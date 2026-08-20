import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const SLOT_LOCK_FILE = ".lock";
const SLOT_LOCK_PID_FILE = ".lock.pid";
const LOGICAL_LOCK_DIRECTORY = ".slot-locks";

// An explicit unlock can fail without proving that the kernel released the
// lock. Keep such descriptors reachable and retry them before acquiring any
// later lock, matching Java SlotLock's fail-closed release retry list.
const pendingReleases = new Set<QwpNodeAdvisoryLock>();

type FlockOperation = "exnb" | "un";
type FlockFn = (typeof import("fs-ext-extra-prebuilt"))["flock"];

// `fs-ext-extra-prebuilt` is an optional native dependency. It is resolved on
// the first lock rather than at module scope, so ILP-only and
// store-and-forward-free QWP users neither load the addon nor depend on a
// prebuilt binary existing for their platform.
let flockPromise: Promise<FlockFn> | undefined;

/** @internal Native advisory-lock contention with Java-compatible diagnostics. */
export class QwpNodeAdvisoryLockBusyError extends Error {
  constructor(
    readonly lockPath: string,
    readonly holderPid?: number,
    cause?: unknown,
  ) {
    super(`QWP advisory lock is already held [file=${lockPath}]`);
    this.name = "QwpNodeAdvisoryLockBusyError";
    this.cause = cause;
  }
}

/** @internal Native advisory-lock setup or release failure. */
export class QwpNodeAdvisoryLockError extends Error {
  constructor(
    message: string,
    readonly lockPath: string,
    cause?: unknown,
  ) {
    super(`${message} [file=${lockPath}]`);
    this.name = "QwpNodeAdvisoryLockError";
    this.cause = cause;
  }
}

/** @internal The optional native locking module is absent or unloadable. */
export class QwpNodeAdvisoryLockUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      "QWP store-and-forward requires the optional native module " +
        "'fs-ext-extra-prebuilt', which could not be loaded " +
        `[platform=${process.platform}-${process.arch}, node=${process.versions.node}]`,
    );
    this.name = "QwpNodeAdvisoryLockUnavailableError";
    this.cause = cause;
  }
}

/**
 * Lifetime owner of Java-compatible `.lock` / `.lock.pid` slot metadata.
 * The files deliberately remain after release: unlinking a lock pathname can
 * create a second inode while another process still holds the first one.
 *
 * @internal
 */
export class QwpNodeAdvisoryLock {
  private released = false;

  private constructor(
    readonly lockPath: string,
    readonly pidPath: string,
    private readonly handle: FileHandle,
  ) {}

  static async acquire(directory: string): Promise<QwpNodeAdvisoryLock> {
    return QwpNodeAdvisoryLock.acquireAt(
      join(directory, SLOT_LOCK_FILE),
      join(directory, SLOT_LOCK_PID_FILE),
    );
  }

  /** Acquires Java's parent-anchored guard for a logical slot pathname. */
  static async acquireLogical(
    slotDirectory: string,
  ): Promise<QwpNodeAdvisoryLock> {
    const { lockDirectory, lockPath, pidPath } =
      logicalLockPaths(slotDirectory);
    await mkdir(lockDirectory, { recursive: true });
    return QwpNodeAdvisoryLock.acquireAt(lockPath, pidPath);
  }

  /** Best-effort Java-compatible cleanup for a permanently drained slot. */
  static async removeOrphanLogical(slotDirectory: string): Promise<void> {
    const { lockPath, pidPath } = logicalLockPaths(slotDirectory);
    let guard: QwpNodeAdvisoryLock;
    try {
      // Only unlink while owning this inode. A live transition holder makes
      // cleanup safely leave the files for a later drained close.
      guard = await QwpNodeAdvisoryLock.acquireAt(lockPath, pidPath);
    } catch {
      return;
    }
    try {
      // Sidecar first: after the lock pathname is gone, a racing acquirer may
      // create a new inode and its own PID sidecar, which we must not remove.
      await unlink(pidPath).catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    } finally {
      await guard.release().catch(() => undefined);
    }
  }

  private static async acquireAt(
    lockPath: string,
    pidPath: string,
  ): Promise<QwpNodeAdvisoryLock> {
    // Resolve the native binding before creating anything: an unsupported
    // platform must fail without leaving slot metadata behind.
    await loadFlock();
    await retryPendingReleases();
    let handle: FileHandle;
    try {
      // a+ maps to a read/write handle on Windows, which LockFileEx requires.
      // Java likewise opens/creates this stable inode read/write before locking.
      handle = await open(lockPath, "a+", 0o600);
    } catch (error) {
      throw new QwpNodeAdvisoryLockError(
        "could not open QWP advisory lock",
        lockPath,
        error,
      );
    }

    try {
      await flockAsync(handle.fd, "exnb");
    } catch (error) {
      const holderPid = isLockContention(error)
        ? await readHolderPid(pidPath)
        : undefined;
      await handle.close().catch(() => undefined);
      if (isLockContention(error)) {
        throw new QwpNodeAdvisoryLockBusyError(lockPath, holderPid, error);
      }
      throw new QwpNodeAdvisoryLockError(
        "could not acquire QWP advisory lock",
        lockPath,
        error,
      );
    }

    // Diagnostic-only, matching Java SlotLock: failure to refresh the sidecar
    // must not discard an already-acquired kernel lock.
    await writeFile(pidPath, `${process.pid}\n`, {
      encoding: "utf8",
      flag: "w",
      mode: 0o600,
    }).catch(() => undefined);
    return new QwpNodeAdvisoryLock(lockPath, pidPath, handle);
  }

  async release(): Promise<void> {
    if (this.released) return;
    try {
      await flockAsync(this.handle.fd, "un");
    } catch (error) {
      // Keep the descriptor alive when unlock is unconfirmed. Closing it would
      // usually release the lock, but would lose Java's explicit-release safety
      // contract and make retry/diagnostics impossible.
      pendingReleases.add(this);
      throw new QwpNodeAdvisoryLockError(
        "could not release QWP advisory lock",
        this.lockPath,
        error,
      );
    }
    this.released = true;
    pendingReleases.delete(this);
    // The kernel unlock is the ownership boundary. Match Java by making the
    // subsequent descriptor close best-effort and never unlinking either file.
    await this.handle.close().catch(() => undefined);
  }
}

async function retryPendingReleases(): Promise<void> {
  for (const lock of [...pendingReleases]) {
    await lock.release().catch(() => undefined);
  }
}

function loadFlock(): Promise<FlockFn> {
  // A failed attempt is not cached. The module throws from its own module scope
  // when no binding matches this platform/ABI, and a later Node upgrade or
  // reinstall can make the very same import succeed.
  flockPromise ??= import("fs-ext-extra-prebuilt").then(
    (module) => module.flock,
    (error) => {
      flockPromise = undefined;
      throw new QwpNodeAdvisoryLockUnavailableError(error);
    },
  );
  return flockPromise;
}

async function flockAsync(
  fd: number,
  operation: FlockOperation,
): Promise<void> {
  const flock = await loadFlock();
  return new Promise((resolve, reject) => {
    flock(fd, operation, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function isLockContention(error: unknown): boolean {
  const code = nodeErrorCode(error);
  return (
    code === "EACCES" ||
    code === "EAGAIN" ||
    code === "EBUSY" ||
    code === "EWOULDBLOCK"
  );
}

async function readHolderPid(path: string): Promise<number | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const value = Number(text.trim().slice(0, 64));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

function logicalLockPaths(slotDirectory: string): {
  readonly lockDirectory: string;
  readonly lockPath: string;
  readonly pidPath: string;
} {
  const absoluteSlot = resolve(slotDirectory);
  const lockDirectory = join(dirname(absoluteSlot), LOGICAL_LOCK_DIRECTORY);
  const slotName = basename(absoluteSlot);
  return {
    lockDirectory,
    lockPath: join(lockDirectory, `${slotName}${SLOT_LOCK_FILE}`),
    pidPath: join(lockDirectory, `${slotName}${SLOT_LOCK_PID_FILE}`),
  };
}
