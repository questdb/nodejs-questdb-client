import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SlotHandle {
  slotDir: string;
  lockPath: string;
}

const BOOT_ID = String(Math.floor(Date.now() - process.uptime() * 1000));

function bootId(): string {
  // Best-effort boot identity: process start time is stable within a boot for
  // a given pid, and differs across reboots for reused pids. Computed ONCE at
  // module load so repeated probes never observe a self-inflicted drift (which
  // would make a live holder look stale and steal its own lock).
  return BOOT_ID;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A lockfile holder is live only when the boot id matches AND the pid is alive. */
export function lockHolderLive(pid: number, boot: string): boolean {
  return boot === bootId() && isAlive(pid);
}

/**
 * Reads a lockfile (pid + boot id) and reports whether its holder is live.
 * Used by the orphan scanner to tell live-held slots from abandoned ones.
 */
export async function isLiveLock(lockPath: string): Promise<boolean> {
  const data = await readFile(lockPath, "utf8").catch(() => undefined);
  if (!data) return false;
  const [pidStr, boot] = data.split("\n");
  const pid = Number.parseInt(pidStr, 10);
  if (!Number.isFinite(pid)) return false;
  return lockHolderLive(pid, boot);
}

/**
 * The parent-anchored logical lock (spec 8.3), used to serialise short-lived
 * orphan-adoption pathname transitions. It lives OUTSIDE the slot directory so
 * it stays valid if that directory is renamed, and the orphan drainer takes it
 * first (then revalidates, then takes the slot lock, then releases it).
 */
const LOGICAL_LOCK_DIR = ".slot-locks";

export async function acquireLogicalLock(
  sfDir: string,
  senderId: string,
): Promise<void> {
  const lockPath = join(sfDir, LOGICAL_LOCK_DIR, senderId);
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.writeFile(`${process.pid}\n${bootId()}\n`, "utf8");
      await fh.close();
      return;
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      if (code !== "EEXIST") throw e;
      if (attempt === 0 && !(await isLiveLock(lockPath))) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      throw new Error(`logical lock in use [dir=${lockPath}]`);
    }
  }
  throw new Error(`logical lock in use [dir=${join(sfDir, LOGICAL_LOCK_DIR, senderId)}]`);
}

export async function releaseLogicalLock(
  sfDir: string,
  senderId: string,
): Promise<void> {
  await unlink(join(sfDir, LOGICAL_LOCK_DIR, senderId)).catch(() => undefined);
}

/** Emulates flock; the kernel's release-on-exit is reconstructed by liveness. */
export async function acquireSlot(sfDir: string, senderId: string): Promise<SlotHandle> {
  const slotDir = join(sfDir, senderId);
  await mkdir(slotDir, { recursive: true });
  const lockPath = join(slotDir, ".lock");

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.writeFile(`${process.pid}\n${bootId()}\n`, "utf8");
      await fh.close();
      return { slotDir, lockPath };
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      if (code !== "EEXIST") throw e;
      const [pidStr, boot] = (await readFile(lockPath, "utf8")).split("\n");
      const pid = Number.parseInt(pidStr, 10);
      const stale = boot !== bootId() || !isAlive(pid);
      if (stale && attempt === 0) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      throw new Error(
        `sf slot already in use [dir=${slotDir}, holderPid=${pid}]. ` +
          `Set a distinct sender_id for each sender sharing sf_dir.`,
      );
    }
  }
  throw new Error(`sf slot already in use [dir=${slotDir}]`);
}

export async function releaseSlot(h: SlotHandle): Promise<void> {
  await unlink(h.lockPath).catch(() => undefined);
}
