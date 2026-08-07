import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSlot, releaseSlot } from "../../../src/qwp/sf/slotLock";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("slot lock", () => {
  it("acquires an unheld slot", async () => {
    dir = mkdtempSync(join(tmpdir(), "qwp-"));
    const h = await acquireSlot(dir, "default");
    expect(h).toBeTruthy();
    await releaseSlot(h);
  });

  it("refuses a second holder and names sender_id in the error", async () => {
    dir = mkdtempSync(join(tmpdir(), "qwp-"));
    const h = await acquireSlot(dir, "default");
    await expect(acquireSlot(dir, "default")).rejects.toThrow(/sender_id/);
    await releaseSlot(h);
  });

  it("reclaims a lock from a dead pid", async () => {
    dir = mkdtempSync(join(tmpdir(), "qwp-"));
    const h = await acquireSlot(dir, "default");
    await releaseSlot(h);
    const again = await acquireSlot(dir, "default");
    expect(again).toBeTruthy();
    await releaseSlot(again);
  });
});
