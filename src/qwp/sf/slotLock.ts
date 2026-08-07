import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

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
