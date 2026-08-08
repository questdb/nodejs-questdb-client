import { describe, it, expect, afterEach } from "vitest";
import {
  appendFileSync,
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
import { readManifest, MANIFEST_FILE_NAME } from "../../../src/qwp/sf/manifest";
import {
  quarantineSlot,
  MAX_QUARANTINED,
  QUARANTINE_INFIX,
} from "../../../src/qwp/sf/quarantine";
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
    const b = readBoundary(
      readFileSync(join(dir, "default", ".ack-watermark")),
    );
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
    const b = readBoundary(
      readFileSync(join(dir, "default", ".ack-watermark")),
    );
    expect(Number(b!.value)).toBe(0);

    const e2 = engine(dir, "periodic");
    await e2.open();
    expect(e2.ackedFsn).toBe(0);
    await e2.close();
  });

  it("does not publish an FSN when disk persistence rejects", async () => {
    const dir = tmpSfDir();
    const e = engine(dir);
    await e.open();
    const internals = e as unknown as {
      persistFrame: (fsn: number, frame: Buffer) => Promise<void>;
    };
    internals.persistFrame = async () => {
      throw new Error("injected disk failure");
    };

    await expect(e.append(FRAME)).rejects.toThrow(/injected disk failure/);
    expect(e.publishedFsn).toBe(-1);
    expect(e.framesFrom(0)).toEqual([]);
    await e.close();
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

describe("SfEngine sf-manifest.bin (spec 8.2, handoff C2)", () => {
  function manPath(dir: string) {
    return join(dir, "default", MANIFEST_FILE_NAME);
  }

  it("records the active chain head on segment creation and re-opens consistently", async () => {
    const dir = tmpSfDir();
    const e = engine(dir);
    await e.open();
    await e.append(FRAME); // fsn 0 -> segment head 0
    await e.close();

    expect(existsSync(manPath(dir))).toBe(true);
    const m = readManifest(readFileSync(manPath(dir)));
    expect(m).not.toBeNull();
    expect(m!.headBaseSeq).toBe(0);

    // Re-open: the scanned chain head matches the manifest head, so it recovers.
    const e2 = engine(dir);
    await e2.open();
    expect(e2.publishedFsn).toBe(0);
    await e2.close();
  });

  it("advances the recorded head across a segment rotation", async () => {
    const dir = tmpSfDir();
    // Small segments force a rotation after a few frames.
    const e = new SfEngine({
      segmentBytes: 32,
      maxTotalBytes: 16 * 1024 * 1024,
      sfDir: dir,
      senderId: "default",
      syncIntervalMillis: 60_000,
    });
    await e.open();
    const big = Buffer.alloc(20);
    await e.append(big); // fsn 0 -> segment head 0
    await e.append(big); // fsn 1 -> 20+20>32 -> rotation -> segment head 1
    await e.close();

    const m = readManifest(readFileSync(manPath(dir)));
    expect(m!.headBaseSeq).toBe(1);

    const e2 = new SfEngine({
      segmentBytes: 32,
      maxTotalBytes: 16 * 1024 * 1024,
      sfDir: dir,
      senderId: "default",
      syncIntervalMillis: 60_000,
    });
    await e2.open();
    expect(e2.framesFrom(1)).toHaveLength(1);
    await e2.close();
  });

  it("recovers more than ten numerically named segments in FSN order", async () => {
    const dir = tmpSfDir();
    const options = {
      segmentBytes: FRAME.length,
      maxTotalBytes: 16 * 1024 * 1024,
      sfDir: dir,
      senderId: "default",
      syncIntervalMillis: 60_000,
    };
    const e = new SfEngine(options);
    await e.open();
    for (let i = 0; i < 11; i++) await e.append(Buffer.from([i, 0, 0, 0]));
    await e.close();
    expect(existsSync(join(dir, "default", "10.sfa"))).toBe(true);

    const recovered = new SfEngine(options);
    await recovered.open();
    expect(recovered.publishedFsn).toBe(10);
    expect(recovered.framesFrom(0).map((f) => f[0])).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    await recovered.close();
  });

  it("quarantines when the manifest head is ahead of the scanned chain (lost tail)", async () => {
    const dir = tmpSfDir();
    const slot = join(dir, "default");
    mkdirSync(slot, { recursive: true });
    const e = engine(dir);
    await e.open();
    await e.append(FRAME); // segment head 0
    await e.close();
    expect(existsSync(manPath(dir))).toBe(true);

    // Simulate a lost tail: delete the only segment so the scanned head drops
    // below the manifest's recorded head 0 -> real data loss -> quarantine.
    rmSync(join(slot, "0.sfa"), { force: true });

    const e2 = engine(dir);
    const err = await e2.open().then(
      () => null as SenderError | null,
      (x) => x as SenderError,
    );
    expect(err).toBeInstanceOf(SenderError);
    expect(err!.category).toBe(Category.DATA_LOSS);
    expect(err!.quarantinedPath).toContain(QUARANTINE_INFIX);
  });

  it("quarantines governed frames when the manifest is corrupt", async () => {
    const dir = tmpSfDir();
    const e = engine(dir);
    await e.open();
    await e.append(FRAME);
    await e.close();
    writeFileSync(manPath(dir), Buffer.alloc(8192));

    const e2 = engine(dir);
    const err = await e2.open().then(
      () => null as SenderError | null,
      (x) => x as SenderError,
    );
    expect(err).toBeInstanceOf(SenderError);
    expect(err!.category).toBe(Category.DATA_LOSS);
    expect(err!.message).toMatch(/manifest missing or corrupt/i);
  });

  it("sets MANIFEST_REQUIRED_FLAG (bit 0) on segments it writes", async () => {
    const dir = tmpSfDir();
    const e = engine(dir);
    await e.open();
    await e.append(FRAME);
    await e.close();
    const seg = readFileSync(join(dir, "default", "0.sfa"));
    expect(seg.readUInt8(5) & 1).toBe(1); // flags bit 0
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

describe("SfEngine persisted symbol dictionary (spec 8.1.6, handoff B1)", () => {
  it("repairs a torn final chunk before appending new symbols", async () => {
    const dir = tmpSfDir();
    const e1 = engine(dir);
    await e1.open();
    e1.persistSymbols(["alpha"]);
    await e1.close();

    const dictPath = join(dir, "default", ".symbol-dict");
    appendFileSync(dictPath, Buffer.from([0x81])); // torn entry-count varint

    const e2 = engine(dir);
    await e2.open();
    expect(e2.symbolDict.entriesFrom(0)).toEqual(["alpha"]);
    e2.persistSymbols(["beta"]);
    await e2.close();

    const e3 = engine(dir);
    await e3.open();
    expect(e3.symbolDict.entriesFrom(0)).toEqual(["alpha", "beta"]);
    await e3.close();
  });

  it("quarantines a complete dictionary chunk with a bad CRC", async () => {
    const dir = tmpSfDir();
    const e1 = engine(dir);
    await e1.open();
    e1.persistSymbols(["alpha"]);
    await e1.close();

    const dictPath = join(dir, "default", ".symbol-dict");
    const raw = readFileSync(dictPath);
    raw[raw.length - 1] ^= 0xff;
    writeFileSync(dictPath, raw);

    const e2 = engine(dir);
    const err = await e2.open().then(
      () => null as SenderError | null,
      (x) => x as SenderError,
    );
    expect(err).toBeInstanceOf(SenderError);
    expect(err!.category).toBe(Category.DATA_LOSS);
    expect(err!.message).toMatch(/CRC mismatch/i);
  });

  it("writes a recoverable SYD1 file that re-opens positionally without de-duping", async () => {
    const dir = tmpSfDir();
    const e1 = engine(dir);
    await e1.open();
    e1.persistSymbols(["alpha", "beta"]);
    e1.persistSymbols(["alpha", "gamma"]); // alpha collides but must NOT de-dupe
    await e1.close();

    const dictPath = join(dir, "default", ".symbol-dict");
    const raw = readFileSync(dictPath);
    expect(raw.subarray(0, 4).toString("ascii")).toBe("SYD1");

    const e2 = engine(dir);
    await e2.open();
    // Recovered positionally: alpha,beta,alpha,gamma -> size 4, ids dense from 0.
    expect(e2.symbolDict.size()).toBe(4);
    expect(e2.symbolDict.entriesFrom(0)).toEqual([
      "alpha",
      "beta",
      "alpha",
      "gamma",
    ]);
    await e2.close();

    // A second reopen sees the same on-disk state (idempotent).
    const e3 = engine(dir);
    await e3.open();
    expect(e3.symbolDict.size()).toBe(4);
    await e3.close();
  });
});
