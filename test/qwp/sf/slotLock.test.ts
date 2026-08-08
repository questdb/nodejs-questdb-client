import { describe, it, expect, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSlot,
  lockHolderLive,
  releaseSlot,
} from "../../../src/qwp/sf/slotLock";

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

  it("never steals a legacy lock from a live foreign process", async () => {
    dir = mkdtempSync(join(tmpdir(), "qwp-"));
    const slotDir = join(dir, "default");
    mkdirSync(slotDir);
    // Older clients wrote their own process-start timestamp as the second line.
    // A different process therefore always sees a different value.
    writeFileSync(join(slotDir, ".lock"), `${process.pid}\nforeign-start\n`);
    expect(lockHolderLive(process.pid, "foreign-start")).toBe(true);
    await expect(acquireSlot(dir, "default")).rejects.toThrow(/already in use/);
  });

  it("reclaims a lock from a dead pid", async () => {
    dir = mkdtempSync(join(tmpdir(), "qwp-"));
    const slotDir = join(dir, "default");
    mkdirSync(slotDir);
    writeFileSync(
      join(slotDir, ".lock"),
      "2147483647\nunknown\nunknown\nold\n",
    );
    const h = await acquireSlot(dir, "default");
    expect(h).toBeTruthy();
    await releaseSlot(h);
  });

  it("recovers an abandoned stale-takeover guard", async () => {
    dir = mkdtempSync(join(tmpdir(), "qwp-"));
    const slotDir = join(dir, "default");
    mkdirSync(slotDir);
    writeFileSync(
      join(slotDir, ".lock"),
      "2147483647\nunknown\nunknown\nold\n",
    );
    const takeover = join(slotDir, ".lock.takeover");
    mkdirSync(takeover);
    const old = new Date(Date.now() - 1000);
    utimesSync(takeover, old, old);

    const h = await acquireSlot(dir, "default");
    expect(h).toBeTruthy();
    await releaseSlot(h);
  });

  it("an old handle cannot release a replacement holder", async () => {
    dir = mkdtempSync(join(tmpdir(), "qwp-"));
    const old = await acquireSlot(dir, "default");
    await releaseSlot(old);
    const replacement = await acquireSlot(dir, "default");
    await releaseSlot(old);
    await expect(acquireSlot(dir, "default")).rejects.toThrow(/already in use/);
    await releaseSlot(replacement);
  });
});
