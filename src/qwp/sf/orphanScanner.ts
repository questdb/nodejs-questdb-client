import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isLiveLock } from "./slotLock";

export interface OrphanSlot {
  senderId: string;
  slotDir: string;
}

/**
 * A quarantined slot is renamed to `<senderId>.quarantined.<n>`, so a generic
 * trailing-infx test (any sender) catches every copy regardless of who owns it.
 * These are skipped by the orphan scanner: a quarantined slot already carries a
 * `.failed` sentinel and must be inspected by a human, never replayed (spec 8.4).
 */
const QUARANTINE_RE = /\.quarantined\.\d+$/;

/**
 * Scans `<sf_dir>/` for slot directories not held by a live lock (spec 8.4).
 * A slot is skipped when its `.lock` is live (actively owned); it is an orphan
 * when the lock is absent or stale (the holder crashed). Dotfiles (including
 * the `.slot-locks` logical-lock area) and quarantined slots are ignored.
 */
export async function scanOrphans(sfDir: string): Promise<OrphanSlot[]> {
  const entries = await readdir(sfDir, { withFileTypes: true }).catch(() => []);
  const orphans: OrphanSlot[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    if (name.startsWith(".")) continue; // dotfiles / .slot-locks
    if (QUARANTINE_RE.test(name)) continue; // quarantined, human-in-the-loop
    const slotDir = join(sfDir, name);
    const live = await isLiveLock(join(slotDir, ".lock"));
    if (!live) orphans.push({ senderId: name, slotDir });
  }
  return orphans;
}
