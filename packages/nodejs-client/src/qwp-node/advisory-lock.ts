import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
// Marks an owner directory that has been renamed out of the way, by a release
// or by a reclaim, and is waiting to be removed. It holds no lock.
const ABANDONED_SUFFIX = ".abandoned-";

// The kernel released a `flock` the instant a holder died. A directory outlives
// its creator, so ownership is instead proven by an owner record and heartbeat.
// A lapsed heartbeat is not permission to reclaim: the holder may merely be
// suspended inside a filesystem write and can later resume through an already
// open descriptor. Automatic reclaim therefore requires positive same-host
// proof that the recorded process is gone.
const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_AFTER_MS = 15_000;

// An explicit release can fail without proving that the owner directory is
// gone. Keep such locks reachable and retry them before acquiring any later
// lock, matching Java SlotLock's fail-closed release retry list.
const pendingReleases = new Set<QwpNodeAdvisoryLock>();

// Distinguishes concurrent steal attempts within one process. A defunct owner
// directory is renamed aside before removal so that exactly one contender can
// claim the right to clear it.
let stealCounter = 0;

/**
 * Whether this holder still owns its slot, has positively lost it, or merely
 * cannot prove either right now. See {@link QwpNodeAdvisoryLock.ownership}.
 */
export type QwpNodeAdvisoryLockOwnership = "owned" | "lost" | "unprovable";

interface OwnerRecord {
  readonly pid: number;
  readonly host: string;
  /**
   * Identifies one acquisition, not one pathname. Ownership is otherwise a
   * path plus an mtime, and both are reused the moment a lock changes hands,
   * so a holder that removed a directory by path alone could remove whichever
   * acquisition happens to occupy that path now.
   */
  readonly token?: string;
  /**
   * Identifies the writing module registry, not the acquisition and not the
   * process.
   *
   * `pid` alone cannot separate a successor from its predecessor: a producer
   * that is SIGKILLed and restarted into the same PID -- the container shape
   * where the app is always PID 1, or PID wraparound -- leaves a record whose
   * PID is alive again, as the successor itself. This field narrows that, but
   * a `worker_threads` worker has its own registry and so its own value, so it
   * cannot separate a dead predecessor from a live sibling thread either. See
   * {@link isReusedPid}, which pairs it with the heartbeat. Absent on records
   * written before this field existed, which remain fail-closed when their PID
   * is alive.
   */
  readonly instance?: string;
}

/**
 * Minted once per module registry, which is not once per process: each
 * `worker_threads` worker loads its own copy of this module and mints its own.
 * A differing value therefore proves only that some other registry wrote the
 * record -- possibly a live sibling thread -- so {@link isReusedPid} pairs it
 * with the heartbeat before treating a record as a dead predecessor's.
 */
const PROCESS_INSTANCE = randomUUID();

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
  /** When this object last proved it still owned the directory. */
  private provenAtMs: number;
  private heartbeat?: NodeJS.Timeout;

  private constructor(
    readonly lockPath: string,
    readonly pidPath: string,
    private readonly ownerPath: string,
    private ownerMtimeMs: number,
    private readonly token: string,
  ) {
    // Use the filesystem timestamp refreshed by the heartbeat. Date.now() can
    // be several milliseconds newer, so retaining the exact stored value keeps
    // the holder's own liveness boundary stable.
    this.provenAtMs = ownerMtimeMs;
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
      if (await reclaimIfDefunct(ownerPath)) {
        claimed = await claimOwnerDirectory(ownerPath);
      }
      if (!claimed) {
        throw new QwpNodeAdvisoryLockBusyError(
          lockPath,
          await readHolderPid(pidPath),
        );
      }
    }

    // This acquisition owns the slot now, so any directory a previous release
    // or reclaim renamed aside and did not live to remove is safe to clear.
    await sweepAbandonedOwnerDirectories(ownerPath);

    const token = newOwnerToken();
    let ownerMtimeMs: number;
    try {
      await writeFile(
        join(ownerPath, OWNER_FILE),
        JSON.stringify({
          pid: process.pid,
          host: hostname(),
          token,
          instance: PROCESS_INSTANCE,
        }),
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
    return new QwpNodeAdvisoryLock(
      lockPath,
      pidPath,
      ownerPath,
      ownerMtimeMs,
      token,
    );
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
    // A release can be retried long after the fact, by which time the pathname
    // may hold somebody else's acquisition. Removing it then would strip a
    // live lock, so prove the directory is still the one this object created.
    const ownership = await this.ownershipState();
    if (ownership === "foreign") {
      this.released = true;
      pendingReleases.delete(this);
      return;
    }
    if (ownership === "unknown") {
      // Neither "ours to remove" nor "somebody else's to leave alone". Keep it
      // on the retry list so a later acquisition settles it, rather than
      // reporting a release that never happened and stranding the directory.
      pendingReleases.add(this);
      throw new QwpNodeAdvisoryLockError(
        "could not confirm QWP advisory lock ownership before release",
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

  /**
   * Whether the owner directory still carries this acquisition's token.
   *
   * `"unknown"` is deliberately distinct from `"foreign"`: a read that failed
   * says nothing about who owns the pathname, and callers that latch on it
   * turn a transient descriptor shortage into a permanently dead journal.
   * Staleness of {@link provenAtMs} is what keeps `"unknown"` fail-closed.
   */
  private async ownershipState(): Promise<"owned" | "foreign" | "unknown"> {
    const owner = await readOwnerFile(this.ownerPath);
    // A torn record is treated as unknown rather than foreign: a holder whose
    // own record was caught mid-write must retry, not latch. Only a contender
    // acts on the difference, in reclaimIfDefunct().
    if (owner.state === "unreadable" || owner.state === "corrupt") {
      return "unknown";
    }
    if (owner.state === "absent") return "foreign";
    return owner.record.token !== undefined && owner.record.token === this.token
      ? "owned"
      : "foreign";
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
    // A stale timestamp no longer lets a contender reclaim a live owner: doing
    // so cannot fence a filesystem call already in progress. Revalidate the
    // acquisition token before refreshing a holder that resumes after a stall.
    if (this.lost) {
      await this.revalidateAfterStall();
      return;
    }
    try {
      const current = await stat(this.ownerPath);
      // The mtime alone cannot separate our directory from a replacement that
      // landed inside the same clock tick. The token is the authority: a
      // matching token means an mtime drift did not transfer ownership, while
      // a foreign token fences this holder.
      const ownership = await this.ownershipState();
      if (ownership === "foreign") {
        this.markCompromised();
        return;
      }
      if (ownership === "unknown") {
        // Refreshing an mtime we cannot vouch for would extend a lock that may
        // no longer be ours, so skip the beat entirely and let the next one
        // retry -- the same treatment the catch below gives a failed stat().
        // If the fault persists, `provenAtMs` goes stale and `lost` fails
        // closed on its own, which is recoverable; latching here is not.
        return;
      }
      if (Math.trunc(current.mtimeMs) !== Math.trunc(this.ownerMtimeMs)) {
        this.ownerMtimeMs = Math.trunc(current.mtimeMs);
      }
      const touchedMtimeMs = await touchOwnerDirectory(this.ownerPath);
      // The owner directory is a reusable pathname. External cleanup can
      // replace it after the read above and before utimes() runs, in which case
      // the touch refreshed the replacement. Never turn that foreign touch
      // into a fresh local proof.
      const afterTouch = await this.ownershipState();
      if (afterTouch === "foreign") {
        this.markCompromised();
        return;
      }
      if (afterTouch === "unknown") return;
      this.ownerMtimeMs = touchedMtimeMs;
      this.provenAtMs = touchedMtimeMs;
    } catch (error) {
      // A directory that is gone is proof of loss: it cannot later reappear
      // with a drifted mtime, so waiting for one means never noticing at all.
      // Any other failure may be transient, and the next beat retries.
      if (nodeErrorCode(error) === "ENOENT") this.markCompromised();
    }
  }

  /**
   * Whether this lock is known to have been taken over. Callers that mutate
   * the resource it guards must stop when it is true: the pathname now belongs
   * to another acquisition, and writing on is what turns a lost lock into lost
   * data.
   */
  get lost(): boolean {
    if (this.compromised) return true;
    // The heartbeat is a timer, so a section that blocks the event loop past
    // the liveness window resumes with the flag still unset. Fence the first
    // mutation until the owner token has been revalidated and refreshed.
    return Date.now() - this.provenAtMs > STALE_AFTER_MS;
  }

  /**
   * Re-establishes ownership after an awaited filesystem operation may have
   * outlived the lease. Returning false means the caller must not mutate the
   * guarded resource.
   *
   * A contender cannot reclaim a live recorded process merely because this
   * timestamp lapsed. The holder can therefore refresh in place after proving
   * its acquisition token still matches.
   */
  async ensureOwned(): Promise<boolean> {
    return (await this.ownership()) === "owned";
  }

  /**
   * The same fence as {@link ensureOwned}, separating the two reasons it can
   * refuse.
   *
   * `"lost"` means a takeover was established: the owner directory carries
   * somebody else's token, or it is gone. `"unprovable"` means only that this
   * holder cannot currently prove anything -- reading the owner record is the
   * one heartbeat step that needs a descriptor, so process-wide descriptor
   * pressure, EIO, or an NFS ESTALE fails precisely it while `stat` and
   * `utimes` keep succeeding. Collapsing the two made a self-healing local
   * fault look like a permanent takeover, and callers that treat the verdict
   * as terminal killed a session that had lost nothing.
   */
  async ownership(): Promise<QwpNodeAdvisoryLockOwnership> {
    if (this.released || this.compromised) return "lost";
    // A live holder cannot be displaced through the lock protocol. Avoid a
    // filesystem read on every frame/ACK while the heartbeat proof is fresh;
    // only a lapsed proof needs synchronous revalidation before work resumes.
    if (!this.lost) return "owned";
    // A heartbeat may have been suspended between reading the owner token and
    // touching the reusable pathname. Check the token on every mutation fence
    // once the timestamp has lapsed rather than trusting an old proof.
    const ownership = await this.ownershipState().catch(
      () => "unknown" as const,
    );
    if (ownership === "foreign") {
      this.markCompromised();
      return "lost";
    }
    if (ownership === "unknown") return "unprovable";
    await this.revalidateAfterStall();
    if (this.compromised) return "lost";
    if (this.lost) return "unprovable";
    const confirmed = await this.ownershipState().catch(
      () => "unknown" as const,
    );
    if (confirmed === "foreign") {
      this.markCompromised();
      return "lost";
    }
    return confirmed === "owned" ? "owned" : "unprovable";
  }

  /**
   * Revalidates a slot this object has already gone stale on.
   *
   * A stall longer than STALE_AFTER_MS -- a suspended VM or container, a
   * debugger pause, a long event-loop block -- used to fence a producer
   * permanently, because `beat()` declined to run and it is the only writer of
   * {@link provenAtMs}. Nothing had necessarily taken the slot; the holder
   * simply could no longer prove it still owned one.
   *
   * The token settles that. While it still matches, nobody adopted the slot,
   * so no other process has replayed or rewritten the journal and the store's
   * in-memory view of it is still accurate. Contenders only reclaim a recorded
   * same-host process after proving it is gone, so refreshing a matching live
   * acquisition cannot race a legitimate takeover.
   */
  private async revalidateAfterStall(): Promise<void> {
    const ownership = await this.ownershipState().catch(
      () => "unknown" as const,
    );
    // Positive proof somebody adopted the slot. Stay fenced for good.
    if (ownership === "foreign") {
      this.markCompromised();
      return;
    }
    // Proves nothing about ownership, so neither reclaim nor latch: retry.
    if (ownership === "unknown") return;

    try {
      const touchedMtimeMs = await touchOwnerDirectory(this.ownerPath);
      const confirmed = await this.ownershipState();
      if (confirmed === "foreign") {
        this.markCompromised();
        return;
      }
      if (confirmed === "unknown") return;
      this.ownerMtimeMs = touchedMtimeMs;
      this.provenAtMs = touchedMtimeMs;
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") this.markCompromised();
      return;
    }
  }

  private markCompromised(): void {
    this.compromised = true;
    this.stopHeartbeat();
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

/**
 * Removes an owner directory in one observable step.
 *
 * Unlinking the record and then removing the directory left a window whose
 * intermediate state -- the directory present with no record inside -- is
 * indistinguishable from an acquisition still between its own mkdir and its
 * record write. A process killed inside that window stranded the slot for
 * good. Renaming aside first means a crash either leaves the directory intact
 * and reclaimable through the dead-PID path, or leaves the mutex free with a
 * stray aside directory that the next acquisition sweeps.
 */
async function removeOwnerDirectory(ownerPath: string): Promise<void> {
  const abandoned = `${ownerPath}${ABANDONED_SUFFIX}${process.pid}-${stealCounter++}`;
  try {
    await rename(ownerPath, abandoned);
  } catch (error) {
    // Already gone: somebody reclaimed it, or a previous attempt got this far.
    if (nodeErrorCode(error) === "ENOENT") return;
    throw error;
  }
  await rm(abandoned, { recursive: true, force: true });
}

/**
 * Best-effort removal of aside directories left by a release or a reclaim that
 * was killed after its rename. They hold no lock and name no owner, so the
 * acquisition that now owns the slot is free to clear them.
 */
async function sweepAbandonedOwnerDirectories(
  ownerPath: string,
): Promise<void> {
  const parent = dirname(ownerPath);
  const prefix = `${basename(ownerPath)}${ABANDONED_SUFFIX}`;
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    await rm(join(parent, entry), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/** Refreshes the heartbeat and returns the mtime that now proves ownership. */
async function touchOwnerDirectory(ownerPath: string): Promise<number> {
  const now = new Date();
  await utimes(ownerPath, now, now);
  return Math.trunc((await stat(ownerPath)).mtimeMs);
}

/**
 * Clears an owner directory whose same-host process is positively gone. The
 * directory is renamed aside first: `rename` lets exactly one contender win,
 * so a lock can never be removed twice and handed to two acquirers.
 */
async function reclaimIfDefunct(ownerPath: string): Promise<boolean> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(ownerPath)).mtimeMs;
  } catch (error) {
    // Already gone; the caller's next mkdir decides the winner.
    return nodeErrorCode(error) === "ENOENT";
  }
  const owner = await readOwnerFile(ownerPath);
  if (owner.state === "absent" || owner.state === "corrupt") {
    // The directory names no process at all, so the dead-PID test below has
    // nothing to test. The only legitimate occupant of that state is an
    // acquisition still between its own mkdir and its record write, which
    // lasts one writeFile; a directory whose mtime has not advanced for the
    // liveness window is nobody's. Without this, a producer killed inside
    // that window -- or inside a release, before the aside rename existed --
    // stranded the slot permanently: reclaimIfDefunct returned here, so
    // `isPidAlive` was never consulted even though `.lock.pid` named a
    // process that was provably gone.
    if (Date.now() - mtimeMs <= STALE_AFTER_MS) return false;
  } else if (
    owner.state !== "present" ||
    owner.record.host !== hostname() ||
    (isPidAlive(owner.record.pid) && !isReusedPid(owner.record, mtimeMs))
  ) {
    // A holder that is merely suspended keeps a readable record, so it never
    // reaches the mtime path above and is still never reclaimed by time.
    return false;
  }

  const abandoned = `${ownerPath}${ABANDONED_SUFFIX}${process.pid}-${stealCounter++}`;
  try {
    await rename(ownerPath, abandoned);
  } catch {
    // Lost the race to another contender, or the holder released normally.
    return true;
  }
  await rm(abandoned, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

/**
 * Whether a record names a PID that is alive only because this process is now
 * that PID.
 *
 * `isPidAlive` answers "yes" for our own PID, so a producer SIGKILLed and
 * restarted into the same PID -- a container where the app is always PID 1, or
 * PID wraparound -- could not adopt its predecessor's slot through the
 * ordinary PID liveness check.
 *
 * A differing `instance` is a necessary condition and not a sufficient one.
 * `PROCESS_INSTANCE` is minted per module registry, and every `worker_threads`
 * worker loads its own copy of this module, so a live sibling worker holding
 * the slot presents exactly the shape a dead predecessor does: our PID, alive,
 * and an instance we did not mint. Treating that as proof let two threads
 * reclaim one another's lock and append to one journal.
 *
 * The heartbeat is what separates them. A live holder -- in any thread of any
 * process -- keeps the owner directory's mtime current; only a holder that is
 * gone stops touching it. So the same staleness the absent/corrupt path uses
 * is required here too, which costs a same-PID successor `STALE_AFTER_MS`
 * before it may adopt the slot instead of adopting it immediately.
 *
 * Records written before `instance` existed return false; an operator must
 * remove an ambiguous live-PID owner rather than risking concurrent writes.
 */
function isReusedPid(record: OwnerRecord, ownerMtimeMs: number): boolean {
  return (
    record.pid === process.pid &&
    record.instance !== undefined &&
    record.instance !== PROCESS_INSTANCE &&
    Date.now() - ownerMtimeMs > STALE_AFTER_MS
  );
}

/**
 * Outcome of reading an owner record.
 *
 * `unreadable` carries no information about ownership and must never be read
 * as one. `stat()` and `utimes()` need no file descriptor while this read must
 * `open(2)`, so process-wide descriptor pressure -- from anywhere in the host
 * application -- fails precisely this call while every other step of the
 * heartbeat still succeeds. `EIO` and NFS `ESTALE` land the same way. Treating
 * that as a takeover latches a lock nobody took, which is unrecoverable
 * because the latch also stops the heartbeat.
 */
type OwnerRead =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly record: OwnerRecord }
  /**
   * The bytes were read and do not describe an owner. Unlike `unreadable`
   * this is positive evidence about the record itself rather than about the
   * reader, which is what lets a contender treat a torn write the way it
   * treats a missing one.
   */
  | { readonly state: "corrupt" }
  | { readonly state: "unreadable" };

async function readOwnerFile(ownerPath: string): Promise<OwnerRead> {
  let contents: string;
  try {
    contents = await readFile(join(ownerPath, OWNER_FILE), "utf8");
  } catch (error) {
    // A record that is gone is positive evidence: this acquisition wrote one
    // and it is no longer there. Every other failure is a fault in the read
    // itself and proves nothing.
    return nodeErrorCode(error) === "ENOENT"
      ? { state: "absent" }
      : { state: "unreadable" };
  }
  try {
    const parsed: unknown = JSON.parse(contents);
    if (parsed && typeof parsed === "object") {
      const { pid, host, token, instance } = parsed as Partial<OwnerRecord>;
      if (typeof pid === "number" && typeof host === "string") {
        return {
          state: "present",
          record: {
            pid,
            host,
            token: typeof token === "string" ? token : undefined,
            instance: typeof instance === "string" ? instance : undefined,
          },
        };
      }
    }
    // A record written by an older client: it parsed, and it carries no token
    // of ours, so it is somebody else's acquisition.
    return { state: "absent" };
  } catch {
    // A torn write -- caught mid-`writeFile` by a contender that is still
    // establishing itself, or left behind by one that died inside it. The
    // bytes were read, so unlike a failed read this says something about the
    // record: it names nobody. Not proof that this acquisition lost anything,
    // which is why ownershipState() still reports it as unknown.
    return { state: "corrupt" };
  }
}

/** Identifies one acquisition, so a release can prove what it is removing. */
function newOwnerToken(): string {
  return `${process.pid}-${randomUUID()}`;
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
