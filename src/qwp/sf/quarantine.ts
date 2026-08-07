import { readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Two-step quarantine for a slot recovery could not open (spec 8.4):
 * 1. rename the slot so a restarting sender does not re-adopt it as its own
 *    working slot (acquireSlot only ever adopts exactly `<sf_dir>/<sender_id>`);
 * 2. drop a `.failed` sentinel so an orphan drainer skips it too.
 *
 * The capacity cap (64 copies per sf_dir) refuses to set any more aside: each
 * quarantined slot is an unreplayable slot a human must inspect, and letting
 * them pile up turns a disk-space problem into a second incident.
 */
export const QUARANTINE_INFIX = ".quarantined.";
const FAILED_SENTINEL = ".failed";
export const MAX_QUARANTINED = 64;

/**
 * Sets a slot aside and returns the renamed path. Throws (without renaming)
 * when the 64-copy cap for this slot is already reached.
 */
export async function quarantineSlot(
  sfDir: string,
  senderId: string,
  slotDir: string,
): Promise<string> {
  const re = new RegExp(`^${escapeRegExp(senderId)}${QUARANTINE_INFIX}\\d+$`);
  const existing = (await readdir(sfDir).catch(() => [])).filter((e) => re.test(e));
  if (existing.length >= MAX_QUARANTINED) {
    throw new Error(
      `refusing to quarantine another copy of slot '${senderId}' ` +
        `(${MAX_QUARANTINED} already set aside under ${sfDir}); operator must clear them`,
    );
  }
  let idx = 0;
  for (const e of existing) {
    const n = Number(e.slice(e.lastIndexOf(QUARANTINE_INFIX) + QUARANTINE_INFIX.length));
    if (n >= idx) idx = n + 1;
  }
  const destDir = join(sfDir, `${senderId}${QUARANTINE_INFIX}${idx}`);
  await rename(slotDir, destDir);
  // Sentinel AFTER the rename so a crash between the two leaves no orphan .failed.
  await writeFile(join(destDir, FAILED_SENTINEL), `quarantined at ${new Date().toISOString()}\n`);
  return destDir;
}

function escapeRegExp(s: string): string {
  // sender_id is a config string; neutralise regex metacharacters.
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
