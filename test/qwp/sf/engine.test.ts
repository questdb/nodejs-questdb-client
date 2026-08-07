import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SfEngine } from "../../../src/qwp/sf/engine";
import { readBoundary } from "../../../src/qwp/sf/boundary";
import { quarantineSlot, MAX_QUARANTINED, QUARANTINE_INFIX } from "../../../src/qwp/sf/quarantine";
import { SenderError, Category, Policy } from "../../../src/qwp/errors";

const FRAME = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpSfDir(): string {
  const d = mkdtempSync(join(tmpdir(), "qwp-engine-"));
  dirs.push(d);
  return d;
}

/** Engine that never fires its background barrier during a test. */
function engine(sfDir: string, durability: "memory" | "periodic" = "memory") {
  return new SfEngine({
    segmentBytes: 1024 * 1024,
    maxTotalBytes: 16 * 1024 * 1024,
    sfDir,
    senderId: "default",
    durability,
    syncIntervalMillis: 60_000, // do not let the timer interfere
  });
}

describe("SfEngine durability barrier (spec 8.2, handoff A3/C1)", () => {
  it("does NOT write the ack watermark per ACK, only on the barrier/close", async () => {
    const dir = tmpSfDir();
    const e = engine(dir);
    await e.open();
    await e.append(FRAME); // fsn 0
    await e.append(FRAME); // fsn 1
    e.acknowledge(0);
    e.acknowledge(1);

    // C1: acknowledging twice must not have produced a watermark file yet.
    const wmPath = join(dir, "default", ".ack-watermark");
    expect(existsSync(wmPath)).toBe(false);

    // The final barrier on close persists the highest clamped value.
    await e.close();
    expect(e.ackedFsn).toBe(1);

    const data = readFileSync(wmPath);
    const b = readBoundary(data);
    expect(b).not.toBeNull();
    expect(Number(b!.value)).toBe(1);
  });

  it("coalesces several ACKs into a single watermark on close", async () => {
    const dir = tmpSfDir();
    const e = engine(dir);
    await e.open();
    for (let i = 0; i < 50; i++) {
      await e.append(FRAME);
      e.acknowledge(i);
    }
    expect(existsSync(join(dir, "default", ".ack-watermark"))).toBe(false);
    await e.close();
    const b = readBoundary(readFileSync(join(dir, "default", ".ack-watermark")));
    expect(Number(b!.value)).toBe(49);
  });

  it("recovers the ack watermark as the seeded ackedFsn", async () => {
    const dir = tmpSfDir();
    const e = engine(dir);
    await e.open();
    await e.append(FRAME); // fsn 0
    await e.append(FRAME); // fsn 1
    await e.append(FRAME); // fsn 2
    e.acknowledge(2);
    await e.close();

    const e2 = engine(dir);
    await e2.open();
    expect(e2.ackedFsn).toBe(2);
    await e2.close();
  });

  it("periodic mode writes and survives a reopen (fsync path)", async () => {
    const dir = tmpSfDir();
    const e = engine(dir, "periodic");
    await e.open();
    await e.append(FRAME);
    e.acknowledge(0);
    await e.close();
    const b = readBoundary(readFileSync(join(dir, "default", ".ack-watermark")));
    expect(Number(b!.value)).toBe(0);

    const e2 = engine(dir, "periodic");
    await e2.open();
    expect(e2.ackedFsn).toBe(0);
    await e2.close();
  });

  it("does not write a watermark when nothing was acknowledged", async () => {
    const dir = tmpSfDir();
    const e = engine(dir);
    await e.open();
    await e.append(FRAME);
    await e.close();
    // No ACK -> no dirty watermark -> nothing written by the final barrier.
    expect(existsSync(join(dir, "default", ".ack-watermark"))).toBe(false);
  });
});

describe("SfEngine quarantine (spec 8.4, handoff A2)", () => {
  it("sets aside a slot with a bad-magic segment and surfaces DATA_LOSS + path", async () => {
    const dir = tmpSfDir();
    const slot = join(dir, "default");
    mkdirSync(slot, { recursive: true });
    // 24-byte header with wrong magic -> scanSegment throws.
    const bad = Buffer.alloc(64, 0);
    bad.write("NOPE", 0, "ascii");
    writeFileSync(join(slot, "0.sfa"), bad);

    const e = new SfEngine({
      segmentBytes: 1024 * 1024,
      maxTotalBytes: 16 * 1024 * 1024,
      sfDir: dir,
      senderId: "default",
    });
    const err = await e.open().then(
      () => null as SenderError | null,
      (x) => x as SenderError,
    );
    expect(err).toBeInstanceOf(SenderError);
    expect(err!.category).toBe(Category.DATA_LOSS);
    expect(err!.policy).toBe(Policy.ABANDONED);
    expect(err!.quarantinedPath).toContain(QUARANTINE_INFIX);

    // The working slot is gone (renamed) and the sentinel marks the copy.
    expect(existsSync(slot)).toBe(false);
    expect(existsSync(join(err!.quarantinedPath!, ".failed"))).toBe(true);
  });

  it("refuses to set aside more than 64 quarantined copies of one slot", async () => {
    const dir = tmpSfDir();
    mkdirSync(dir, { recursive: true });
    const existing: string[] = [];
    for (let i = 0; i < MAX_QUARANTINED; i++) {
      const d = join(dir, `default${QUARANTINE_INFIX}${i}`);
      mkdirSync(d, { recursive: true });
      existing.push(d);
    }
    const victim = join(dir, "default");
    mkdirSync(victim, { recursive: true });
    await expect(quarantineSlot(dir, "default", victim)).rejects.toThrow(
      /refusing to quarantine/i,
    );
  });
});
