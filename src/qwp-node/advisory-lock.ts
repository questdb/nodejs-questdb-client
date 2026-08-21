import {
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const SLOT_LOCK_FILE = ".lock";
const SLOT_LOCK_PID_FILE = ".lock.pid";
const LOGICAL_LOCK_DIRECTORY = ".slot-locks";

// The owner directory is the mutex. `mkdir` is the only filesystem primitive
// that is atomically exclusive on both POSIX and Windows without a native
// binding, so ownership is "created this directory" rather than a kernel lock.
const OWNER_DIRECTORY_SUFFIX = ".owner";
const OWNER_FILE = "owner";

// The kernel released a `flock` the instant a holder died. A directory outlives
// its creator, so ownership is instead proven by a liveness heartbeat: the
// holder refreshes the owner directory's mtime, and a contender may reclaim a
// lock whose mtime has stopped advancing.
const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_AFTER_MS = 15_000;

// An explicit release can fail without proving that the owner directory is
// gone. Keep such locks reachable and retry them before acquiring any later
// lock, matching Java SlotLock's fail-closed release retry list.
const pendingReleases = new Set<QwpNodeAdvisoryLock>();

// Distinguishes concurrent steal attempts within one process. A stale owner
// directory is renamed aside before removal so that exactly one contender can
// claim the right to clear it.
let stealCounter = 0;

interface OwnerRecord {
  readonly pid: number;
  readonly host: string;
}

/** @internal Advisory-lock contention with Java-compatible diagnostics. */
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

/** @internal Advisory-lock setup or release failure. */
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

/**
 * Lifetime owner of Java-compatible `.lock` / `.lock.pid` slot metadata plus
 * the `.lock.owner` directory that provides mutual exclusion. The metadata
 * files deliberately remain after release so a slot keeps the on-disk shape a
 * Java client expects to find; only the owner directory is transient.
 *
 * Exclusion covers Node processes only. A Java client locks `.lock` with
 * `flock`/`LockFileEx`, which this implementation does not participate in, so
 * the two runtimes must not use one directory at the same time.
 *
 * @internal
 */
export class QwpNodeAdvisoryLock {
  private released = false;
  private compromised = false;
  private heartbeat?: NodeJS.Timeout;

  private constructor(
    readonly lockPath: string,
    readonly pidPath: string,
    private readonly ownerPath: string,
    private ownerMtimeMs: number,
  ) {
    this.startHeartbeat();
  }

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
      // Only unlink while holding the lock. A live holder makes cleanup safely
      // leave the files for a later drained close.
      guard = await QwpNodeAdvisoryLock.acquireAt(lockPath, pidPath);
    } catch {
      return;
    }
    try {
      // Sidecar first: after the lock pathname is gone, a racing acquirer may
      // create its own PID sidecar, which we must not remove.
      await unlink(pidPath).catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    } finally {
      // Releasing removes the owner directory, leaving the parent empty.
      await guard.release().catch(() => undefined);
    }
  }

  private static async acquireAt(
    lockPath: string,
    pidPath: string,
  ): Promise<QwpNodeAdvisoryLock> {
    await retryPendingReleases();
    const ownerPath = `${lockPath}${OWNER_DIRECTORY_SUFFIX}`;

    // Claim the mutex before creating anything else, so losing contention
    // leaves no metadata behind for a slot this process does not own.
    let claimed = await claimOwnerDirectory(ownerPath);
    if (!claimed) {
      if (await reclaimIfStale(ownerPath, pidPath)) {
        claimed = await claimOwnerDirectory(ownerPath);
      }
      if (!claimed) {
        throw new QwpNodeAdvisoryLockBusyError(
          lockPath,
          await readHolderPid(pidPath),
        );
      }
    }

    let ownerMtimeMs: number;
    try {
      await writeFile(
        join(ownerPath, OWNER_FILE),
        JSON.stringify({ pid: process.pid, host: hostname() }),
        { encoding: "utf8", mode: 0o600 },
      );
      ownerMtimeMs = await touchOwnerDirectory(ownerPath);
      // Keep the Java-visible slot metadata present and current. Java creates
      // these itself when absent, so they exist for format parity and for the
      // holder PID a contender reports.
      await writeFile(lockPath, "", {
        encoding: "utf8",
        flag: "a",
        mode: 0o600,
      });
    } catch (error) {
      await removeOwnerDirectory(ownerPath).catch(() => undefined);
      throw new QwpNodeAdvisoryLockError(
        "could not establish QWP advisory lock",
        lockPath,
        error,
      );
    }

    // Diagnostic-only, matching Java SlotLock: failure to refresh the sidecar
    // must not discard an already-acquired lock.
    await writeFile(pidPath, `${process.pid}\n`, {
      encoding: "utf8",
      flag: "w",
      mode: 0o600,
    }).catch(() => undefined);
    return new QwpNodeAdvisoryLock(lockPath, pidPath, ownerPath, ownerMtimeMs);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.stopHeartbeat();
    if (this.compromised) {
      // The owner directory was reclaimed by another process while we held it.
      // Removing it now would strip a lock this process no longer owns.
      this.released = true;
      pendingReleases.delete(this);
      throw new QwpNodeAdvisoryLockError(
        "QWP advisory lock was reclaimed by another process before release",
        this.lockPath,
      );
    }
    try {
      await removeOwnerDirectory(this.ownerPath);
    } catch (error) {
      // Keep the lock reachable when removal is unconfirmed, so a later
      // acquisition retries it rather than assuming the mutex is free.
      pendingReleases.add(this);
      throw new QwpNodeAdvisoryLockError(
        "could not release QWP advisory lock",
        this.lockPath,
        error,
      );
    }
    this.released = true;
    pendingReleases.delete(this);
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      void this.beat();
    }, HEARTBEAT_INTERVAL_MS);
    // Never hold the event loop open for a lock refresh.
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private async beat(): Promise<void> {
    if (this.released || this.compromised) return;
    try {
      const current = await stat(this.ownerPath);
      if (Math.trunc(current.mtimeMs) !== Math.trunc(this.ownerMtimeMs)) {
        // Someone judged this lock stale and took it. Stop refreshing so the
        // new owner's heartbeat is the only one advancing the mtime.
        this.compromised = true;
        this.stopHeartbeat();
        return;
      }
      this.ownerMtimeMs = await touchOwnerDirectory(this.ownerPath);
    } catch {
      // A transient stat/utimes failure is not proof of loss. The next beat
      // retries; a genuinely removed directory surfaces as a drifted mtime.
    }
  }
}

async function retryPendingReleases(): Promise<void> {
  for (const lock of [...pendingReleases]) {
    await lock.release().catch(() => undefined);
  }
}

/** Returns true when this call created the owner directory. */
async function claimOwnerDirectory(ownerPath: string): Promise<boolean> {
  try {
    await mkdir(ownerPath);
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "EEXIST") return false;
    throw new QwpNodeAdvisoryLockError(
      "could not create QWP advisory lock owner directory",
      ownerPath,
      error,
    );
  }
}

async function removeOwnerDirectory(ownerPath: string): Promise<void> {
  await unlink(join(ownerPath, OWNER_FILE)).catch(() => undefined);
  await rmdir(ownerPath);
}

/** Refreshes the heartbeat and returns the mtime that now proves ownership. */
async function touchOwnerDirectory(ownerPath: string): Promise<number> {
  const now = new Date();
  await utimes(ownerPath, now, now);
  return Math.trunc((await stat(ownerPath)).mtimeMs);
}

/**
 * Clears an owner directory whose holder is gone. The directory is renamed
 * aside first: `rename` lets exactly one contender win, so a lock can never be
 * removed twice and handed to two acquirers.
 */
async function reclaimIfStale(
  ownerPath: string,
  pidPath: string,
): Promise<boolean> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(ownerPath)).mtimeMs;
  } catch {
    // Already gone; the caller's next mkdir decides the winner.
    return true;
  }
  if (!(await isStale(ownerPath, pidPath, mtimeMs))) return false;

  const abandoned = `${ownerPath}.stale-${process.pid}-${stealCounter++}`;
  try {
    await rename(ownerPath, abandoned);
  } catch {
    // Lost the race to another contender, or the holder released normally.
    return true;
  }
  await rm(abandoned, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

async function isStale(
  ownerPath: string,
  pidPath: string,
  mtimeMs: number,
): Promise<boolean> {
  if (Date.now() - mtimeMs > STALE_AFTER_MS) return true;
  // Fast path for a crash on this host: a heartbeat that can never resume is
  // stale immediately. A PID is meaningless on another host, so this is only
  // consulted when the recorded host matches.
  const owner = await readOwnerRecord(ownerPath, pidPath);
  return (
    owner !== undefined && owner.host === hostname() && !isPidAlive(owner.pid)
  );
}

async function readOwnerRecord(
  ownerPath: string,
  pidPath: string,
): Promise<OwnerRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(ownerPath, OWNER_FILE), "utf8"),
    );
    if (parsed && typeof parsed === "object") {
      const { pid, host } = parsed as Partial<OwnerRecord>;
      if (typeof pid === "number" && typeof host === "string") {
        return { pid, host };
      }
    }
  } catch {
    // Fall through: a lock written by an older client, or a torn write.
  }
  // A slot locked before the owner record existed still has the PID sidecar,
  // but nothing proves which host wrote it, so it can only expire by mtime.
  const pid = await readHolderPid(pidPath);
  return pid === undefined ? undefined : { pid, host: hostname() };
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return nodeErrorCode(error) === "EPERM";
  }
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
