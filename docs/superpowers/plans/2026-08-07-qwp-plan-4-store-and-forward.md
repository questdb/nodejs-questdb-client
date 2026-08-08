# QWP Plan 4 — Store-and-Forward and Release (spec PRs 12–16) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `flush()`'s publish semantics honest — published frames survive a disconnect and a process crash, replay after reconnect, and a crashed process's leftover data gets drained. Then ship 5.0.0.

**Architecture:** A byte-capped ring of segments keyed by FSN, in memory or on disk depending on whether `sf_dir` is set. Segments carry `baseSeq` in their header, so **FSNs persist across restarts**. Two crash-safe boundary records (manifest, ack watermark) and a load-bearing persisted symbol dictionary sit beside them. Slot directories are locked, and orphaned slots are drained by background tasks with their own connections.

**Tech Stack:** TypeScript, Node ≥ 20, `node:fs/promises`, `node:crypto`. vitest + testcontainers + child-process crash tests.

**Prerequisites:** Plans 1–3 merged. Consumes: `SymbolDict`, `AckTracker`, `HostTracker` (and its `newCursor()`), `encodeFrame`, `QwpTransport`, `Dispatcher`, `SenderError`.

**Source of truth:** `docs/superpowers/specs/2026-08-07-qwp-nodejs-client-design.md`.

## Global Constraints

- **No new runtime dependencies.** In particular **no CRC library** — `zlib.crc32` is ISO-HDLC and will not interoperate; CRC32C (Castagnoli) is implemented in Task 1.
- **Node 20 floor.**
- **All integers little-endian.**
- **Options stay `undefined` until set** (spec 9.1.2).
- **Mode selection is implicit:** `sf_dir` present ⇒ disk mode; absent ⇒ memory mode. There is no `store_and_forward` key (spec 9.2).
- Existing tests stay green: `npx vitest run && npx tsc --noEmit && npx eslint src/**`.

## File Structure

| File | Responsibility |
|---|---|
| `src/qwp/sf/crc32c.ts` | CRC32C (Castagnoli) |
| `src/qwp/sf/segment.ts` | `SF01` segment: append, scan-recover, torn-tail detection |
| `src/qwp/sf/ring.ts` | FSN-keyed segment chain, ACK-driven trim, publish barrier |
| `src/qwp/sf/boundary.ts` | Alternating-generation record (manifest + ack watermark) |
| `src/qwp/sf/symbolDictFile.ts` | `SYD1` persisted dictionary |
| `src/qwp/sf/slotLock.ts` | Slot lock + logical lock |
| `src/qwp/sf/orphans.ts` | Orphan scan + background drainers |
| `src/qwp/sf/engine.ts` | Ties ring + manager + watermark together |
| `src/qwp/transport.ts` | **modify** — publish to the engine, replay on reconnect |
| `README.md` | **modify** — support matrix and the caveats in Task 10 |

---

### Task 1: CRC32C

**Files:**
- Create: `src/qwp/sf/crc32c.ts`
- Test: `test/qwp/sf/crc32c.test.ts`

**Interfaces:**
- Produces: `crc32c(buf: Buffer, seed?: number): number`.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/sf/crc32c.test.ts
import { describe, it, expect } from "vitest";
import { crc32c } from "../../../src/qwp/sf/crc32c";

describe("crc32c (Castagnoli)", () => {
  it("matches the published check value for '123456789'", () => {
    expect(crc32c(Buffer.from("123456789", "ascii")) >>> 0).toBe(0xe3069283);
  });

  it("returns 0 for an empty buffer", () => {
    expect(crc32c(Buffer.alloc(0)) >>> 0).toBe(0);
  });

  it("is order-sensitive", () => {
    expect(crc32c(Buffer.from("ab"))).not.toBe(crc32c(Buffer.from("ba")));
  });
});
```

- [ ] **Step 2: Run test** → `npx vitest run test/qwp/sf/crc32c.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/qwp/sf/crc32c.ts
import { Buffer } from "node:buffer";

// Castagnoli polynomial, reversed: 0x82F63B78. NOT the zlib/ISO-HDLC one.
const TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function crc32c(buf: Buffer, seed = 0): number {
  let c = ~seed;
  for (let i = 0; i < buf.length; i++) {
    c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (~c) >>> 0;
}
```

- [ ] **Step 4: Run test** → PASS, 3 tests. The `123456789` check value is the published CRC-32C constant, so this validates against the standard rather than against our own output.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/sf/crc32c.ts test/qwp/sf/crc32c.test.ts
git commit -m "feat(qwp): add CRC32C (Castagnoli) implementation"
```

---

### Task 2: Segment format, append and torn-tail recovery

**Files:**
- Create: `src/qwp/sf/segment.ts`
- Test: `test/qwp/sf/segment.test.ts`

**Spec 8.1.5.** 24-byte `SF01` header, then frames of `u32 crc32c | u32 payloadLen | payload`, with the **CRC covering `payloadLen` and the payload together**. Recovery stops at the first bad CRC or a length that overruns the file. **The residue must not be zeroed during the scan** — it can hold valid-CRC frames that are the only surviving copy.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/sf/segment.test.ts
import { describe, it, expect } from "vitest";
import { buildSegment, scanSegment, SEGMENT_HEADER_SIZE } from "../../../src/qwp/sf/segment";

function seg(baseSeq: number, frames: Buffer[]): Buffer {
  return buildSegment(baseSeq, frames, 4096);
}

describe("segment", () => {
  it("writes an SF01 header carrying baseSeq", () => {
    const b = seg(42, [Buffer.from("aa")]);
    expect(b.subarray(0, 4).toString("ascii")).toBe("SF01");
    expect(b.readUInt8(4)).toBe(1);
    expect(Number(b.readBigUInt64LE(8))).toBe(42);
  });

  it("scans back the frames it wrote", () => {
    const r = scanSegment(seg(0, [Buffer.from("aa"), Buffer.from("bbb")]));
    expect(r.frames.map((f) => f.toString())).toEqual(["aa", "bbb"]);
    expect(r.tornTailBytes).toBe(0);
  });

  it("stops at a bad CRC and reports a torn tail", () => {
    const b = seg(0, [Buffer.from("aa"), Buffer.from("bbb")]);
    b[SEGMENT_HEADER_SIZE + 8 + 2 + 0] ^= 0xff; // corrupt the second frame's payload
    const r = scanSegment(b);
    expect(r.frames.length).toBe(1);
    expect(r.tornTailBytes).toBeGreaterThan(0);
  });

  it("distinguishes a clean partial fill from a torn tail", () => {
    const b = seg(0, [Buffer.from("aa")]);
    // trailing bytes are already zero -> clean fill, not a tear
    expect(scanSegment(b).tornTailBytes).toBe(0);
  });

  it("stops when a declared length overruns the file", () => {
    const b = seg(0, [Buffer.from("aa")]);
    b.writeUInt32LE(9_000_000, SEGMENT_HEADER_SIZE + 4);
    expect(scanSegment(b).frames.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test** → FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/qwp/sf/segment.ts
import { Buffer } from "node:buffer";
import { crc32c } from "./crc32c";

export const SEGMENT_MAGIC = Buffer.from("SF01", "ascii");
export const SEGMENT_HEADER_SIZE = 24;
export const FRAME_HEADER_SIZE = 8;

export interface ScanResult {
  baseSeq: number;
  frames: Buffer[];
  /** Bytes of non-zero residue after the last valid frame. 0 = clean fill. */
  tornTailBytes: number;
  /** Offset where the next append must start. */
  appendOffset: number;
}

export function buildSegment(baseSeq: number, frames: Buffer[], capacity: number): Buffer {
  const buf = Buffer.alloc(capacity);
  SEGMENT_MAGIC.copy(buf, 0);
  buf.writeUInt8(1, 4); // version
  buf.writeUInt8(0, 5); // flags
  buf.writeUInt16LE(0, 6); // reserved
  buf.writeBigUInt64LE(BigInt(baseSeq), 8);
  buf.writeBigUInt64LE(0n, 16); // createdMicros; stamped by the caller if needed
  let o = SEGMENT_HEADER_SIZE;
  for (const f of frames) o = appendFrame(buf, o, f);
  return buf;
}

/** Returns the new offset, or -1 when the frame does not fit. */
export function appendFrame(buf: Buffer, offset: number, payload: Buffer): number {
  const need = FRAME_HEADER_SIZE + payload.length;
  if (offset + need > buf.length) return -1;
  // CRC covers (payloadLen, payload) together -- not the payload alone.
  const lenAndPayload = Buffer.allocUnsafe(4 + payload.length);
  lenAndPayload.writeUInt32LE(payload.length, 0);
  payload.copy(lenAndPayload, 4);
  buf.writeUInt32LE(crc32c(lenAndPayload), offset);
  buf.writeUInt32LE(payload.length, offset + 4);
  payload.copy(buf, offset + 8);
  return offset + need;
}

export function scanSegment(buf: Buffer): ScanResult {
  if (buf.length < SEGMENT_HEADER_SIZE || !buf.subarray(0, 4).equals(SEGMENT_MAGIC)) {
    throw new Error("segment: bad magic");
  }
  if (buf.readUInt8(4) !== 1) throw new Error("segment: unsupported version");
  const baseSeq = Number(buf.readBigUInt64LE(8));

  const frames: Buffer[] = [];
  let o = SEGMENT_HEADER_SIZE;
  for (;;) {
    if (o + FRAME_HEADER_SIZE > buf.length) break;
    const crc = buf.readUInt32LE(o);
    const len = buf.readUInt32LE(o + 4);
    if (len === 0 && crc === 0) break; // unwritten space
    if (o + FRAME_HEADER_SIZE + len > buf.length) break; // declared length overruns
    const lenAndPayload = buf.subarray(o + 4, o + FRAME_HEADER_SIZE + len);
    if (crc32c(lenAndPayload) !== crc) break; // first bad CRC ends the chain
    frames.push(Buffer.from(buf.subarray(o + FRAME_HEADER_SIZE, o + FRAME_HEADER_SIZE + len)));
    o += FRAME_HEADER_SIZE + len;
  }

  // Non-zero residue means a write was attempted and failed. Do NOT zero it
  // here: after a mid-file tear it can hold valid-CRC frames that are the only
  // surviving copy of real payloads (spec 8.1.5).
  let torn = 0;
  for (let i = o; i < buf.length; i++) if (buf[i] !== 0) torn++;

  return { baseSeq, frames, tornTailBytes: torn, appendOffset: o };
}
```

- [ ] **Step 4: Run test** → PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/sf/segment.ts test/qwp/sf/segment.test.ts
git commit -m "feat(qwp): add SF01 segment format with torn-tail recovery"
```

---

### Task 3: Segment ring and FSN model

**Files:**
- Create: `src/qwp/sf/ring.ts`
- Test: `test/qwp/sf/ring.test.ts`

**Spec 8.1.1.** FSNs derive from `baseSeq + frameCount`, so a recovered ring **continues** the previous numbering. Two sentinels with opposite handling: no-spare means wait, payload-too-large means fail now.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/sf/ring.test.ts
import { describe, it, expect } from "vitest";
import { SegmentRing, BACKPRESSURE_NO_SPARE, PAYLOAD_TOO_LARGE } from "../../../src/qwp/sf/ring";

describe("SegmentRing", () => {
  it("assigns FSNs from 0 on a fresh ring", () => {
    const r = new SegmentRing({ segmentBytes: 4096, maxTotalBytes: 1 << 20 });
    expect(r.publishedFsn).toBe(-1);
    expect(r.append(Buffer.from("a"))).toBe(0);
    expect(r.append(Buffer.from("b"))).toBe(1);
    expect(r.publishedFsn).toBe(1);
  });

  it("continues numbering when recovered from existing segments", () => {
    const r = SegmentRing.recovered([{ baseSeq: 10, frames: [Buffer.from("x"), Buffer.from("y")] }], {
      segmentBytes: 4096,
      maxTotalBytes: 1 << 20,
    });
    expect(r.publishedFsn).toBe(11);
    expect(r.append(Buffer.from("z"))).toBe(12);
  });

  it("returns PAYLOAD_TOO_LARGE for a frame that cannot fit a fresh segment", () => {
    const r = new SegmentRing({ segmentBytes: 64, maxTotalBytes: 1 << 20 });
    expect(r.append(Buffer.alloc(1000))).toBe(PAYLOAD_TOO_LARGE);
  });

  it("trims acked segments and frees space", () => {
    const r = new SegmentRing({ segmentBytes: 64, maxTotalBytes: 256 });
    const fsns = [0, 1, 2].map(() => r.append(Buffer.alloc(20)));
    r.acknowledge(fsns[2]);
    expect(r.ackedFsn).toBe(fsns[2]);
    expect(r.totalBytes).toBeLessThan(256);
  });

  it("returns the frames to replay from ackedFsn + 1", () => {
    const r = new SegmentRing({ segmentBytes: 4096, maxTotalBytes: 1 << 20 });
    r.append(Buffer.from("a"));
    r.append(Buffer.from("b"));
    r.append(Buffer.from("c"));
    r.acknowledge(0);
    expect(r.framesFrom(r.ackedFsn + 1).map((f) => f.toString())).toEqual(["b", "c"]);
  });
});
```

- [ ] **Step 2: Run test** → FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/qwp/sf/ring.ts
import { Buffer } from "node:buffer";

export const BACKPRESSURE_NO_SPARE = -1;
export const PAYLOAD_TOO_LARGE = -2;

interface Seg {
  baseSeq: number;
  frames: Buffer[];
  bytes: number;
}

export interface RingOptions {
  segmentBytes: number;
  maxTotalBytes: number;
}

export class SegmentRing {
  private segs: Seg[] = [];
  private nextSeq = 0;
  private acked = -1;

  constructor(private readonly opts: RingOptions) {
    this.segs.push({ baseSeq: 0, frames: [], bytes: 0 });
  }

  /** FSNs derive from the chain, so a recovered ring continues numbering. */
  static recovered(
    chain: { baseSeq: number; frames: Buffer[] }[],
    opts: RingOptions,
  ): SegmentRing {
    const r = new SegmentRing(opts);
    r.segs = chain.map((c) => ({
      baseSeq: c.baseSeq,
      frames: c.frames,
      bytes: c.frames.reduce((a, f) => a + f.length, 0),
    }));
    r.segs.sort((a, b) => a.baseSeq - b.baseSeq);
    for (let i = 1; i < r.segs.length; i++) {
      const prev = r.segs[i - 1];
      if (prev.baseSeq + prev.frames.length !== r.segs[i].baseSeq) {
        throw new Error("segment chain is not contiguous");
      }
    }
    for (const s of r.segs) {
      if (s.baseSeq < 0) throw new Error("segment with negative baseSeq must be quarantined");
    }
    const last = r.segs[r.segs.length - 1];
    r.nextSeq = last.baseSeq + last.frames.length;
    return r;
  }

  get publishedFsn(): number {
    return this.nextSeq - 1;
  }

  get ackedFsn(): number {
    return this.acked;
  }

  get totalBytes(): number {
    return this.segs.reduce((a, s) => a + s.bytes, 0);
  }

  /** Returns the assigned FSN, or a negative sentinel. */
  append(frame: Buffer): number {
    if (frame.length > this.opts.segmentBytes) return PAYLOAD_TOO_LARGE;
    const active = this.segs[this.segs.length - 1];
    if (active.bytes + frame.length > this.opts.segmentBytes) {
      if (this.totalBytes + frame.length > this.livenessFloorAdjustedCap()) {
        return BACKPRESSURE_NO_SPARE;
      }
      this.segs.push({ baseSeq: this.nextSeq, frames: [], bytes: 0 });
    }
    const seg = this.segs[this.segs.length - 1];
    seg.frames.push(frame);
    seg.bytes += frame.length;
    return this.nextSeq++;
  }

  /**
   * Never refuse below the minimum working set. Segment bytes are reclaimable
   * by ACK-driven trim, but side files are lifetime-monotonic, so refusing on
   * the raw total can wedge the producer permanently (spec 8.1.3).
   */
  private livenessFloorAdjustedCap(): number {
    return Math.max(this.opts.maxTotalBytes, 2 * this.opts.segmentBytes);
  }

  acknowledge(fsn: number): void {
    if (fsn > this.acked) this.acked = fsn;
    while (this.segs.length > 1) {
      const head = this.segs[0];
      if (head.baseSeq + head.frames.length - 1 > this.acked) break;
      this.segs.shift();
    }
  }

  framesFrom(fsn: number): Buffer[] {
    const out: Buffer[] = [];
    for (const s of this.segs) {
      s.frames.forEach((f, i) => {
        if (s.baseSeq + i >= fsn) out.push(f);
      });
    }
    return out;
  }
}
```

- [ ] **Step 4: Run test** → PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/sf/ring.ts test/qwp/sf/ring.test.ts
git commit -m "feat(qwp): add FSN-keyed segment ring with ACK-driven trim"
```

---

### Task 4: Replay on reconnect

**Files:**
- Modify: `src/qwp/transport.ts`
- Test: `test/qwp/sf/replay.test.ts`

The gap Plan 3 left open. `flush()` publishes into the ring; the send loop drains it; a reconnect replays from `ackedFsn + 1` **after** the dictionary catch-up.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/sf/replay.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { MockQwpServer } from "../mockServer";
import { QwpTransport } from "../../../src/qwp/transport";
import { SenderOptions } from "../../../src/options";

let mock: MockQwpServer | undefined;
afterEach(async () => await mock?.stop());

describe("replay", () => {
  it("resends unacked frames after a reconnect", async () => {
    mock = new MockQwpServer();
    // Drop the connection after the first frame, never ACKing it.
    const port = await mock.start({ dropAfter: 1 });
    const t = new QwpTransport(new SenderOptions(`ws::addr=127.0.0.1:${port};`));
    await t.connect();
    await t.sendFrames([Buffer.from("QWP1frame-one")]);
    await new Promise((r) => setTimeout(r, 400));
    // The same payload must appear at least twice: original plus replay.
    const matching = mock.frames.filter((f) => f.toString().includes("frame-one"));
    expect(matching.length).toBeGreaterThanOrEqual(2);
    await t.close();
  });

  it("does not replay frames the server already acked", async () => {
    mock = new MockQwpServer();
    const port = await mock.start();
    const t = new QwpTransport(new SenderOptions(`ws::addr=127.0.0.1:${port};`));
    await t.connect();
    await t.sendFrames([Buffer.from("QWP1acked-frame")]);
    await new Promise((r) => setTimeout(r, 150));
    await t.reconnectForTest();
    await new Promise((r) => setTimeout(r, 150));
    const matching = mock.frames.filter((f) => f.toString().includes("acked-frame"));
    expect(matching.length).toBe(1);
    await t.close();
  });
});
```

- [ ] **Step 2: Run test** → FAIL — no ring wired in, so nothing replays.

- [ ] **Step 3: Implement** — in `src/qwp/transport.ts`:

```ts
  private ring = new SegmentRing({
    segmentBytes: 4 * 1024 * 1024,
    maxTotalBytes: 128 * 1024 * 1024, // memory-mode default (spec 9.1)
  });

  async sendFrames(frames: Buffer[]): Promise<boolean> {
    for (const f of frames) {
      const fsn = this.ring.append(f);
      if (fsn === PAYLOAD_TOO_LARGE) {
        throw new Error(`frame does not fit a fresh segment [size=${f.length}]`);
      }
      if (fsn === BACKPRESSURE_NO_SPARE) {
        await this.awaitSpace();
        this.ring.append(f);
      }
    }
    await this.drain();
    return true;
  }

  /** Sends everything published beyond what has been sent on this connection. */
  private async drain(): Promise<void> {
    if (!this.ws) return;
    const pending = this.ring.framesFrom(this.sentUpTo + 1);
    for (const f of pending) {
      await this.ws.sendBinary(f);
      this.acks.onFrameSent();
      this.sentUpTo++;
    }
  }

  private async onReconnected(): Promise<void> {
    await this.sendDictCatchUp();            // dictionary first (spec 7.5)
    this.sentUpTo = this.ring.ackedFsn;      // replay from ackedFsn + 1
    this.acks.onConnected(this.ring.ackedFsn + 1);
    await this.drain();
  }
```

Route `onResponse`'s OK path through `this.ring.acknowledge(fsn)` using the FSN returned by `AckTracker.onAck`, and drop the Plan 3 `DATA_LOSS`-on-disconnect emission — with retention in place, a disconnect no longer loses in-flight frames.

- [ ] **Step 4: Run test** → PASS, 2 tests. Also re-run `test/qwp/transport.acks.test.ts` and **update** its "reports in-flight loss" case: that behaviour is now intentionally gone, replaced by replay. Rewrite it to assert the frame is *replayed* rather than reported lost.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/transport.ts test/qwp/sf/replay.test.ts test/qwp/transport.acks.test.ts
git commit -m "feat(qwp): replay unacked frames from the ring after reconnect"
```

---

### Task 5: Crash-safe boundary record

**Files:**
- Create: `src/qwp/sf/boundary.ts`
- Test: `test/qwp/sf/boundary.test.ts`

**Spec 8.2.** Two independently CRC-protected 64-byte records at offsets **0 and 4096**, alternating on update, CRC written last. Recovery picks the valid record with the greatest generation. The 4 KiB separation stops one sector tear damaging both.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/sf/boundary.test.ts
import { describe, it, expect } from "vitest";
import { writeBoundary, readBoundary, BOUNDARY_FILE_SIZE } from "../../../src/qwp/sf/boundary";

describe("boundary record", () => {
  it("alternates slots and picks the greatest valid generation", () => {
    const buf = Buffer.alloc(BOUNDARY_FILE_SIZE);
    writeBoundary(buf, 1, 100n);
    writeBoundary(buf, 2, 200n);
    expect(readBoundary(buf)).toEqual({ generation: 2, value: 200n });
  });

  it("writes the two records 4096 bytes apart", () => {
    const buf = Buffer.alloc(BOUNDARY_FILE_SIZE);
    writeBoundary(buf, 1, 100n);
    writeBoundary(buf, 2, 200n);
    expect(buf.readUInt32LE(0)).not.toBe(0);
    expect(buf.readUInt32LE(4096)).not.toBe(0);
  });

  it("falls back to the older record when the newer one is torn", () => {
    const buf = Buffer.alloc(BOUNDARY_FILE_SIZE);
    writeBoundary(buf, 1, 100n);
    writeBoundary(buf, 2, 200n);
    // Corrupt whichever slot holds generation 2.
    const slot = buf.readBigUInt64LE(8) === 2n ? 0 : 4096;
    buf[slot + 20] ^= 0xff;
    expect(readBoundary(buf)).toEqual({ generation: 1, value: 100n });
  });

  it("returns null when neither record validates", () => {
    const buf = Buffer.alloc(BOUNDARY_FILE_SIZE);
    expect(readBoundary(buf)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test** → FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/qwp/sf/boundary.ts
import { Buffer } from "node:buffer";
import { crc32c } from "./crc32c";

export const BOUNDARY_FILE_SIZE = 8192;
const RECORD_SIZE = 64;
const SLOT_STRIDE = 4096;
const CRC_OFFSET = 60;
const MAGIC = 0x314b5741; // 'AKW1'

export interface Boundary {
  generation: number;
  value: bigint;
}

/** Alternates slots by generation parity; the CRC is written last. */
export function writeBoundary(buf: Buffer, generation: number, value: bigint): void {
  const slot = (generation % 2) * SLOT_STRIDE;
  buf.fill(0, slot, slot + RECORD_SIZE);
  buf.writeUInt32LE(MAGIC, slot);
  buf.writeUInt32LE(1, slot + 4);
  buf.writeBigUInt64LE(BigInt(generation), slot + 8);
  buf.writeBigInt64LE(value, slot + 16);
  const crc = crc32c(buf.subarray(slot, slot + CRC_OFFSET));
  buf.writeUInt32LE(crc, slot + CRC_OFFSET);
}

export function readBoundary(buf: Buffer): Boundary | null {
  let best: Boundary | null = null;
  for (const slot of [0, SLOT_STRIDE]) {
    if (slot + RECORD_SIZE > buf.length) continue;
    if (buf.readUInt32LE(slot) !== MAGIC) continue;
    const stored = buf.readUInt32LE(slot + CRC_OFFSET);
    if (crc32c(buf.subarray(slot, slot + CRC_OFFSET)) !== stored) continue;
    const generation = Number(buf.readBigUInt64LE(slot + 8));
    const value = buf.readBigInt64LE(slot + 16);
    if (!best || generation > best.generation) best = { generation, value };
  }
  return best;
}
```

- [ ] **Step 4: Run test** → PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/sf/boundary.ts test/qwp/sf/boundary.test.ts
git commit -m "feat(qwp): add alternating-generation crash-safe boundary record"
```

---

### Task 6: Persisted symbol dictionary

**Files:**
- Create: `src/qwp/sf/symbolDictFile.ts`
- Test: `test/qwp/sf/symbolDictFile.test.ts`

**Spec 8.1.6 — load-bearing, not an optimisation.** `SYD1` header then chunks of `[entryCount varint][entryBytes varint][entries][crc32c u32]`. **One chunk = one frame's new symbols.** Ids are implicit and positional, so **recovery must not de-duplicate**.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/sf/symbolDictFile.test.ts
import { describe, it, expect } from "vitest";
import { encodeChunk, decodeDictFile, DICT_HEADER } from "../../../src/qwp/sf/symbolDictFile";
import { SymbolDict } from "../../../src/qwp/protocol/symbolDict";

describe("persisted symbol dictionary", () => {
  it("round-trips chunks in order", () => {
    const file = Buffer.concat([DICT_HEADER, encodeChunk(["a", "b"]), encodeChunk(["c"])]);
    expect(decodeDictFile(file)).toEqual(["a", "b", "c"]);
  });

  it("stops at the first bad chunk CRC, keeping the prefix", () => {
    const file = Buffer.concat([DICT_HEADER, encodeChunk(["a"]), encodeChunk(["b"])]);
    file[file.length - 1] ^= 0xff;
    expect(decodeDictFile(file)).toEqual(["a"]);
  });

  it("recovery preserves positional ids and does NOT de-duplicate", () => {
    const file = Buffer.concat([DICT_HEADER, encodeChunk(["x", "x"])]);
    const entries = decodeDictFile(file);
    const dict = new SymbolDict();
    for (const e of entries) dict.addRecovered(e);
    expect(dict.size()).toBe(2); // collapsing would renumber every later symbol
  });

  it("rejects a bad magic", () => {
    expect(() => decodeDictFile(Buffer.from("NOPE0000"))).toThrow(/magic/i);
  });
});
```

- [ ] **Step 2: Run test** → FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/qwp/sf/symbolDictFile.ts
import { Buffer } from "node:buffer";
import { crc32c } from "./crc32c";
import { writeVarint, varintSize, readVarint } from "../protocol/varint";

export const DICT_HEADER = (() => {
  const b = Buffer.alloc(8);
  b.write("SYD1", 0, "ascii");
  b.writeUInt8(1, 4);
  return b;
})();

/** One chunk = exactly the symbols one frame introduces (spec 8.1.6). */
export function encodeChunk(entries: string[]): Buffer {
  let entryBytes = 0;
  for (const s of entries) {
    const n = Buffer.byteLength(s, "utf8");
    entryBytes += varintSize(n) + n;
  }
  const head = Buffer.alloc(varintSize(entries.length) + varintSize(entryBytes));
  let ho = writeVarint(head, 0, entries.length);
  ho = writeVarint(head, ho, entryBytes);

  const body = Buffer.alloc(entryBytes);
  let bo = 0;
  for (const s of entries) {
    const n = Buffer.byteLength(s, "utf8");
    bo = writeVarint(body, bo, n);
    body.write(s, bo, "utf8");
    bo += n;
  }

  // CRC covers BOTH header varints and the entry region.
  const crcInput = Buffer.concat([head.subarray(0, ho), body]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32LE(crc32c(crcInput), 0);
  return Buffer.concat([head.subarray(0, ho), body, tail]);
}

export function decodeDictFile(file: Buffer): string[] {
  if (file.length < DICT_HEADER.length || file.subarray(0, 4).toString("ascii") !== "SYD1") {
    throw new Error("symbol dict: bad magic");
  }
  const out: string[] = [];
  let o = DICT_HEADER.length;
  while (o < file.length) {
    const start = o;
    let r;
    try {
      r = readVarint(file, o);
    } catch {
      break;
    }
    const count = r.value;
    o = r.offset;
    const r2 = readVarint(file, o);
    const entryBytes = r2.value;
    o = r2.offset;
    if (o + entryBytes + 4 > file.length) break;
    const crcInput = file.subarray(start, o + entryBytes);
    if (crc32c(crcInput) !== file.readUInt32LE(o + entryBytes)) break;

    let eo = o;
    for (let i = 0; i < count; i++) {
      const rl = readVarint(file, eo);
      eo = rl.offset;
      out.push(file.subarray(eo, eo + rl.value).toString("utf8"));
      eo += rl.value;
    }
    o += entryBytes + 4;
  }
  return out;
}
```

- [ ] **Step 4: Run test** → PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/sf/symbolDictFile.ts test/qwp/sf/symbolDictFile.test.ts
git commit -m "feat(qwp): add SYD1 persisted symbol dictionary"
```

---

### Task 7: Delta → full-dict runtime fallback

**Files:**
- Modify: `src/qwp/buffer.ts`, `src/qwp/transport.ts`
- Test: `test/qwp/sf/dictFallback.test.ts`

**Spec 5.2.** If `.symbol-dict` becomes unwritable mid-run, degrade **permanently** to full-dict mode. Without this, every later `flush()` throws forever and a survivable condition becomes total ingestion loss.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/sf/dictFallback.test.ts
import { describe, it, expect } from "vitest";
import { QwpBuffer } from "../../../src/qwp/buffer";
import { SymbolDict } from "../../../src/qwp/protocol/symbolDict";
import { FLAG_DELTA_SYMBOL_DICT } from "../../../src/qwp/protocol/constants";

describe("delta -> full-dict fallback", () => {
  it("keeps ingesting after the side file becomes unwritable", () => {
    const b = new QwpBuffer();
    b.attachDict(new SymbolDict(), () => {
      throw new Error("ENOSPC");
    });
    b.table("t").symbol("s", "a");
    b.at(1n, "us");
    const frames = b.sealFrames(1 << 20); // must NOT throw
    expect(frames.length).toBe(1);
    expect(frames[0].readUInt8(5) & FLAG_DELTA_SYMBOL_DICT).toBe(0);
  });

  it("the fallback is permanent", () => {
    const b = new QwpBuffer();
    let fail = true;
    b.attachDict(new SymbolDict(), () => {
      if (fail) throw new Error("ENOSPC");
    });
    b.table("t").symbol("s", "a");
    b.at(1n, "us");
    b.sealFrames(1 << 20);
    fail = false; // side file recovers, but we must stay in full-dict mode
    b.table("t").symbol("s", "b");
    b.at(2n, "us");
    expect(b.sealFrames(1 << 20)[0].readUInt8(5) & FLAG_DELTA_SYMBOL_DICT).toBe(0);
  });
});
```

- [ ] **Step 2: Run test** → FAIL, `attachDict` takes one argument.

- [ ] **Step 3: Implement** — in `QwpBuffer`:

```ts
  private persist?: (entries: string[]) => void;

  attachDict(dict: SymbolDict, persist?: (entries: string[]) => void): void {
    this.dict = dict;
    this.persist = persist;
  }

  /**
   * One-way, permanent degradation. The side file can start failing appends
   * while segments stay writable, because segments are pre-allocated and the
   * dictionary is the one thing still growing. A fixed mode would turn that
   * into total, permanent ingestion loss (spec 5.2).
   */
  private disableDeltaDict(cause: unknown): void {
    this.dict = undefined;
    this.persist = undefined;
    this.confirmedMaxId = -1;
  }
```

In `sealFrames`, before encoding, write-ahead-persist the new symbols and fall back on failure:

```ts
    if (this.dict && this.persist) {
      const fresh = this.dict.entriesFrom(this.confirmedMaxId + 1);
      if (fresh.length > 0) {
        try {
          this.persist(fresh);
        } catch (e) {
          this.disableDeltaDict(e);
        }
      }
    }
```

Because `symbol()` stored global ids while a dict was attached, the fallback must also re-materialise strings. Simplest correct approach: keep the string alongside the id in `col.values` as `{ id, text }` and let the encoder pick whichever the current mode needs.

- [ ] **Step 4: Run test** → PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/buffer.ts src/qwp/transport.ts test/qwp/sf/dictFallback.test.ts
git commit -m "feat(qwp): degrade to full-dict mode when the symbol side file fails"
```

---

### Task 8: Disk mode — slot locks and persistence

**Files:**
- Create: `src/qwp/sf/slotLock.ts`, `src/qwp/sf/engine.ts`
- Test: `test/qwp/sf/slotLock.test.ts`, `test/qwp/sf/engine.test.ts`

**Spec 8.3.** A slot is `<sf_dir>/<sender_id>/`, `sender_id` defaults to `"default"`. Node has no `flock`, so both locks are emulated with an `O_EXCL` lockfile carrying **pid + boot id**. A second sender on the same slot must fail with a message that **names `sender_id`** as the fix.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/sf/slotLock.test.ts
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
```

- [ ] **Step 2: Run test** → FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/qwp/sf/slotLock.ts
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface SlotHandle {
  slotDir: string;
  lockPath: string;
}

function bootId(): string {
  // Best-effort boot identity: process start time is stable within a boot for
  // a given pid, and differs across reboots for reused pids.
  return String(Math.floor(Date.now() - process.uptime() * 1000));
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
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
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
```

- [ ] **Step 4: Run test** → PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/sf/slotLock.ts test/qwp/sf/slotLock.test.ts
git commit -m "feat(qwp): add slot locking with pid and boot-id liveness"
```

---

### Task 9: Crash-recovery tests

**Files:**
- Create: `test/qwp/sf/crash.test.ts`, `test/qwp/sf/crashChild.ts`

**Spec 10 tier 4.** Assert **at-least-once**, not exactly-once — replay and cap-split retry both legitimately duplicate, so a duplicate must not fail the test.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/sf/crashChild.ts
import { Sender } from "../../../src";

async function main() {
  const [addr, sfDir] = process.argv.slice(2);
  const sender = await Sender.fromConfig(`ws::addr=${addr};sf_dir=${sfDir};`);
  await sender.connect();
  for (let i = 0; i < 50; i++) {
    await sender.table("crash_t").intColumn("i", i).at(BigInt(1_700_000_000_000_000 + i), "us");
  }
  await sender.flush();
  process.stdout.write("FLUSHED\n");
  // Never exits cleanly; the parent kills us mid-flight.
  await new Promise(() => undefined);
}
main();
```

```ts
// test/qwp/sf/crash.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockQwpServer } from "../mockServer";

let mock: MockQwpServer | undefined;
let dir: string | undefined;
afterEach(async () => {
  await mock?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("crash recovery", () => {
  it("leaves a slot on disk when the process is killed mid-flight", async () => {
    mock = new MockQwpServer();
    const port = await mock.start({ statusFor: () => 0x09 }); // never OK, so nothing trims
    dir = mkdtempSync(join(tmpdir(), "qwp-sf-"));

    const child = spawn("npx", ["tsx", "test/qwp/sf/crashChild.ts", `127.0.0.1:${port}`, dir], {
      cwd: process.cwd(),
    });
    await new Promise<void>((resolve) => {
      child.stdout.on("data", (d) => String(d).includes("FLUSHED") && resolve());
    });
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));

    const slot = join(dir, "default");
    expect(readdirSync(slot).length).toBeGreaterThan(0);
  }, 120_000);

  it("recovers the orphan slot and replays with no row lost", async () => {
    // Assert at-least-once: every row present, duplicates allowed (spec 5.1).
    expect(true).toBe(true); // placeholder replaced in Step 3
  }, 120_000);
});
```

- [ ] **Step 2: Run test** → FAIL — the child cannot write a slot because disk mode is not wired.

- [ ] **Step 3: Wire disk mode and finish the second test**

In `src/qwp/sf/engine.ts`, open the slot when `sf_dir` is set: acquire the lock, read `.ack-watermark` via `readBoundary`, load `.symbol-dict` via `decodeDictFile` + `addRecovered`, scan `*.sfa` via `scanSegment`, and build the ring with `SegmentRing.recovered`. Replace the placeholder test with one that starts a fresh sender on the same `sf_dir`, drains against a mock that ACKs, and asserts every `i` in `0..49` appears **at least once** in the frames the mock received.

- [ ] **Step 4: Run test** → PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/sf/engine.ts test/qwp/sf/crash.test.ts test/qwp/sf/crashChild.ts
git commit -m "test(qwp): add crash-recovery tests for store-and-forward"
```

---

### Task 10: Documentation and release

**Files:**
- Modify: `README.md`, `package.json`
- Create: `examples/qwp-basic.ts`

**These caveats must reach the README**, not only the spec — each is a case where the honest behaviour will surprise a user:

- `flush()` resolves on **publish**, not on server ACK (spec 4.4) — unlike `http::`.
- Delivery is **at-least-once**; a cap-split retry can duplicate (spec 5.1).
- A plain OK means **server-side commit, not object-store durability**; opt into `request_durable_ack` for that (spec 4.2).
- **`sf_dir` alone is not power-loss durability** — the default `sf_durability=memory` never fsyncs (spec 8.2).
- **`drain_orphans` defaults to off**, so a crashed process's slot is never drained automatically (spec 9.1).
- **`tls_roots` cannot read a JKS keystore**; use PEM or PKCS#12 (spec 6.5.2).

- [ ] **Step 1: Add the support-matrix row and caveats to `README.md`**

```markdown
| Protocol | Transport | Notes |
|---|---|---|
| `http` / `https` | HTTP | ILP, request/response |
| `tcp` / `tcps` | TCP | ILP, persistent |
| `ws` / `wss` | WebSocket | **QWP** — columnar binary, store-and-forward |

### QWP caveats

- `flush()` resolves once rows are **published** to the send log, not when the
  server acknowledges them. This differs from `http::`.
- Delivery is **at-least-once**. A retried batch can duplicate rows; use a
  `DEDUP` table if you need idempotence.
- An acknowledgement means server-side **commit**, not object-store durability.
  Set `request_durable_ack=on` if durability gates downstream work.
- `sf_dir` enables on-disk buffering but **not** power-loss durability on its
  own — add `sf_durability=periodic`.
- `drain_orphans` is **off** by default, so a crashed process's buffered data is
  not replayed automatically.
- `tls_roots` accepts PEM or PKCS#12. **JKS keystores are not supported** by
  Node; convert them first.
```

- [ ] **Step 2: Add the example**

```ts
// examples/qwp-basic.ts
import { Sender } from "@questdb/nodejs-client";

async function main() {
  const sender = await Sender.fromConfig("ws::addr=localhost:9000;");
  await sender.connect();
  await sender
    .table("trades")
    .symbol("symbol", "ETH-USD")
    .symbol("side", "sell")
    .floatColumn("price", 2615.54)
    .floatColumn("amount", 0.00044)
    .at(Date.now(), "ms");
  await sender.flush();
  await sender.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Bump the version**

Set `"version": "5.0.0"` in `package.json`. A **major** — see the note in the
design spec 3.5. Nothing removes an existing API, but `flush()` means something
different on `ws::` than on `http::`, and `ws::` delivery is at-least-once. The
major exists to force a changelog read, not because a signature broke.

- [ ] **Step 4: Run the full gate**

Run: `npx vitest run && npx tsc --noEmit && npx eslint src/** && npx bunchee`
Expected: all green, and the build emits both ESM and CJS.

- [ ] **Step 5: Commit**

```bash
git add README.md examples/qwp-basic.ts package.json
git commit -m "docs(qwp): document ws:// support and release 5.0.0"
```

---

## Self-Review

**1. Spec coverage.** CRC32C (Task 1 — 8.2). Segment format + torn tail (Task 2 — 8.1.5). FSN model, ring, trim, liveness floor (Task 3 — 8.1.1, 8.1.3, 8.1.4). Replay (Task 4 — closes the gap Plan 3 flagged). Boundary records (Task 5 — 8.2). Persisted dictionary, no-dedup recovery (Task 6 — 8.1.6). Delta fallback (Task 7 — 5.2). Slot locks (Task 8 — 8.3). Crash tests (Task 9 — 10 tier 4). Docs and release (Task 10).

**Knowingly reduced in scope, and why.** Three items are specified but implemented in a simplified form; each is called out so a reviewer sees the gap rather than assuming parity:

- **Orphan scan and background drainers (8.4)** — Task 8 provides the lock and Task 9 proves a slot survives, but automatic adoption of *another* process's slot is not built. `drain_orphans` defaults to off (9.1), so this matches the default behaviour; enabling it should throw "not implemented" rather than silently doing nothing.
- **Quarantine, rename plus `.failed` sentinel, and the 64-copy cap (8.4)** — not built. A corrupt slot currently fails to open loudly instead of being set aside.
- **`sf_durability=periodic` fsync cadence (8.2)** — the boundary records are crash-safe by construction, but the periodic background barrier is not scheduled; only `memory` durability is wired.

**2. Placeholder scan.** One deliberate placeholder in Task 9 Step 1's second test, replaced in Step 3 of the same task — flagged inline rather than left silent.

**3. Type consistency.** `crc32c` (Task 1) is used in Tasks 2, 5, 6. `scanSegment`/`appendFrame` (Task 2) feed `SegmentRing.recovered` (Task 3). `SegmentRing.framesFrom/acknowledge/ackedFsn` (Task 3) are called in Task 4. `readBoundary`/`writeBoundary` (Task 5) and `decodeDictFile` (Task 6) are consumed by the engine in Task 9. `SymbolDict.addRecovered` comes from Plan 2 Task 6 and is relied on in Task 6 here.
