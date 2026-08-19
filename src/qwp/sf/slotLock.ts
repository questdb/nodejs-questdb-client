import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  link,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SlotHandle {
  slotDir: string;
  lockPath: string;
  ownerToken: string;
}

function readBootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return "unknown";
  }
}

function processStatFields(pid: number): string[] | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The process name is parenthesised and can contain spaces. Field 3 starts
    // after its final ')'.
    return stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
  } catch {
    return undefined;
  }
}

function processStartIdentity(pid: number): string {
  return processStatFields(pid)?.[19] ?? "unknown"; // /proc field 22
}

const BOOT_ID = readBootId();
const PROCESS_START_ID = processStartIdentity(process.pid);
const logicalOwners = new Map<string, string>();

function lockContents(ownerToken: string): string {
  return `${process.pid}\n${BOOT_ID}\n${PROCESS_START_ID}\n${ownerToken}\n`;
}

function genuineBootId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // A killed but not-yet-reaped child still has a PID and answers signal 0,
    // but cannot own or release the lock. /proc field 3 identifies zombies.
    if (processStatFields(pid)?.[0] === "Z") return false;
    return true;
  } catch (e: unknown) {
    // EPERM proves that a process exists but is owned by another user.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A holder is live unless we can positively prove its process identity is stale. */
export function lockHolderLive(
  pid: number,
  boot: string,
  startIdentity = "unknown",
): boolean {
  if (!isAlive(pid)) return false;
  // Compare boot ids only when both are genuine. This keeps lockfiles written
  // by older clients conservative rather than stealing from a live process.
  if (genuineBootId(BOOT_ID) && genuineBootId(boot) && boot !== BOOT_ID) {
    return false;
  }
  const currentStart = processStartIdentity(pid);
  if (
    startIdentity &&
    startIdentity !== "unknown" &&
    currentStart !== "unknown" &&
    startIdentity !== currentStart
  ) {
    return false;
  }
  return true;
}

function parseLock(data: string): {
  pid: number;
  boot: string;
  startIdentity: string;
  ownerToken: string;
} {
  const [pidStr, boot = "unknown", startIdentity = "unknown", ownerToken = ""] =
    data.split("\n");
  return {
    pid: Number.parseInt(pidStr, 10),
    boot,
    startIdentity,
    ownerToken,
  };
}

export async function isLiveLock(lockPath: string): Promise<boolean> {
  const data = await readFile(lockPath, "utf8").catch(() => undefined);
  if (!data) return false;
  const { pid, boot, startIdentity } = parseLock(data);
  return Number.isFinite(pid) && lockHolderLive(pid, boot, startIdentity);
}

/**
 * Publish complete metadata atomically. Linking a fully-written sibling temp
 * file avoids the empty/partial record window of open("wx") followed by write.
 */
async function publishLock(
  lockPath: string,
  ownerToken: string,
): Promise<void> {
  const tempPath = `${lockPath}.${process.pid}.${ownerToken}.tmp`;
  const fh = await open(tempPath, "wx");
  try {
    try {
      await fh.writeFile(lockContents(ownerToken), "utf8");
    } finally {
      await fh.close();
    }
    await link(tempPath, lockPath); // atomic EEXIST if another holder won
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

const TAKEOVER_OWNER = ".owner";
const EMPTY_GUARD_GRACE_MS = 100;

function lockInUse(path: string): NodeJS.ErrnoException {
  const e = new Error(`lock in use [path=${path}]`) as NodeJS.ErrnoException;
  e.code = "EEXIST";
  return e;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialize every acquire/release pathname transition. The guard carries the
 * same process identity as the slot lock, so a crash in takeover is recoverable
 * instead of wedging the slot forever. Empty guards get a short grace period
 * for the creator to publish their owner record.
 */
async function acquireTransition(
  lockPath: string,
): Promise<string | undefined> {
  const guardPath = `${lockPath}.takeover`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = randomUUID();
    try {
      await mkdir(guardPath);
      await writeFile(join(guardPath, TAKEOVER_OWNER), lockContents(token), {
        flag: "wx",
      });
      return token;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        await rm(guardPath, { recursive: true, force: true }).catch(
          () => undefined,
        );
        throw e;
      }
      const ownerPath = join(guardPath, TAKEOVER_OWNER);
      const data = await readFile(ownerPath, "utf8").catch(() => undefined);
      if (data) {
        const owner = parseLock(data);
        if (
          Number.isFinite(owner.pid) &&
          lockHolderLive(owner.pid, owner.boot, owner.startIdentity)
        ) {
          return undefined;
        }
      } else {
        const info = await stat(guardPath).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs < EMPTY_GUARD_GRACE_MS) {
          return undefined;
        }
      }
      // Revalidate after a scheduling turn so a just-created live guard is not
      // mistaken for the stale record observed above.
      await sleep(10);
      const current = await readFile(ownerPath, "utf8").catch(() => undefined);
      if (current) {
        const owner = parseLock(current);
        if (
          Number.isFinite(owner.pid) &&
          lockHolderLive(owner.pid, owner.boot, owner.startIdentity)
        ) {
          return undefined;
        }
      }
      await rm(guardPath, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
  return undefined;
}

async function releaseTransition(
  lockPath: string,
  ownerToken: string,
): Promise<void> {
  const guardPath = `${lockPath}.takeover`;
  const data = await readFile(join(guardPath, TAKEOVER_OWNER), "utf8").catch(
    () => undefined,
  );
  if (!data || parseLock(data).ownerToken !== ownerToken) return;
  await rm(guardPath, { recursive: true, force: true }).catch(() => undefined);
}

async function acquireLock(lockPath: string): Promise<string> {
  await mkdir(dirname(lockPath), { recursive: true });
  const transition = await acquireTransition(lockPath);
  if (!transition) throw lockInUse(lockPath);
  try {
    const ownerToken = randomUUID();
    try {
      await publishLock(lockPath, ownerToken);
      return ownerToken;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const data = await readFile(lockPath, "utf8").catch(() => undefined);
      if (data) {
        const owner = parseLock(data);
        if (
          Number.isFinite(owner.pid) &&
          lockHolderLive(owner.pid, owner.boot, owner.startIdentity)
        ) {
          throw e;
        }
      }
      await unlink(lockPath).catch((unlinkError: unknown) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw unlinkError;
        }
      });
      await publishLock(lockPath, ownerToken);
      return ownerToken;
    }
  } finally {
    await releaseTransition(lockPath, transition);
  }
}

async function releaseOwnedLock(
  lockPath: string,
  ownerToken: string,
): Promise<void> {
  // Acquisition and release both use the transition guard, making token check
  // plus unlink atomic with respect to replacement publication.
  for (let attempt = 0; attempt < 20; attempt++) {
    const transition = await acquireTransition(lockPath);
    if (!transition) {
      await sleep(10);
      continue;
    }
    try {
      const data = await readFile(lockPath, "utf8").catch(() => undefined);
      if (!data || parseLock(data).ownerToken !== ownerToken) return;
      await unlink(lockPath).catch(() => undefined);
      return;
    } finally {
      await releaseTransition(lockPath, transition);
    }
  }
}

const LOGICAL_LOCK_DIR = ".slot-locks";

export async function acquireLogicalLock(
  sfDir: string,
  senderId: string,
): Promise<void> {
  const lockPath = join(sfDir, LOGICAL_LOCK_DIR, senderId);
  try {
    const ownerToken = await acquireLock(lockPath);
    logicalOwners.set(lockPath, ownerToken);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    throw new Error(`logical lock in use [dir=${lockPath}]`);
  }
}

export async function releaseLogicalLock(
  sfDir: string,
  senderId: string,
): Promise<void> {
  const lockPath = join(sfDir, LOGICAL_LOCK_DIR, senderId);
  const ownerToken = logicalOwners.get(lockPath);
  if (!ownerToken) return;
  logicalOwners.delete(lockPath);
  await releaseOwnedLock(lockPath, ownerToken);
}

export async function acquireSlot(
  sfDir: string,
  senderId: string,
): Promise<SlotHandle> {
  const slotDir = join(sfDir, senderId);
  const lockPath = join(slotDir, ".lock");
  try {
    const ownerToken = await acquireLock(lockPath);
    return { slotDir, lockPath, ownerToken };
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const data = await readFile(lockPath, "utf8").catch(() => "");
    const { pid } = parseLock(data);
    throw new Error(
      `sf slot already in use [dir=${slotDir}, holderPid=${pid}]. ` +
        `Set a distinct sender_id for each sender sharing sf_dir.`,
    );
  }
}

export async function releaseSlot(h: SlotHandle): Promise<void> {
  await releaseOwnedLock(h.lockPath, h.ownerToken);
}
