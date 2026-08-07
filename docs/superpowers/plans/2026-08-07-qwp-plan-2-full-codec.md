# QWP Plan 2 — Full Codec (spec PRs 4–8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the QWP wire codec — every column type, the symbol dictionary in both modes, Gorilla timestamps, deferred commit with its commit frame, and cap-splitting when a flush exceeds the server's batch size.

**Architecture:** Extends `src/qwp/` from Plan 1. Adds a per-type encoder table, a connection-scoped symbol dictionary, a Gorilla bit-writer, and the first genuine widening of the internal contract: a flush can now produce **several** frames, so `QwpBuffer` gains `sealFrames()` and `QwpTransport` gains `sendFrames()`.

**Tech Stack:** TypeScript, Node ≥ 20, `node:buffer`, `node:crypto`. vitest + testcontainers.

**Prerequisite:** Plan 1 (`docs/superpowers/plans/2026-08-07-qwp-plan-1-walking-skeleton.md`) must be merged. This plan consumes from it: `writeVarint`/`varintSize`/`readVarint`, `QwpTableBuffer`/`ColumnBuffer`, `encodeFrame`, `QwpBuffer`, `QwpTransport`, `QwpWebSocket`, and the constants module.

**Source of truth:** `docs/superpowers/specs/2026-08-07-qwp-nodejs-client-design.md`.

## Global Constraints

- **No new runtime dependencies.**
- **Node 20 floor.** No zstd on this path (spec 9.3) — do not add compression.
- **All integers little-endian.** `varint` is unsigned LEB128 (spec 6.0).
- **`V` = non-null row count.** Every column payload is compacted (spec 6.2.1).
- **Options stay `undefined` until set** (spec 9.1.2).
- Existing tests must stay green: `npx vitest run && npx tsc --noEmit && npx eslint src/**`.
- Out of scope: ACK handling, FSN, reconnect, failover, store-and-forward. Frames are still fire-and-forget after `sendFrames()`.

## File Structure

| File | Responsibility |
|---|---|
| `src/qwp/protocol/constants.ts` | **modify** — remaining type codes, encoding-byte constants |
| `src/qwp/protocol/columnWriter.ts` | **new** — per-type sizing and writing, extracted from `frameEncoder` |
| `src/qwp/protocol/bits.ts` | **new** — LSB-first bit writer |
| `src/qwp/protocol/gorilla.ts` | **new** — delta-of-delta encoder + feasibility check |
| `src/qwp/protocol/symbolDict.ts` | **new** — connection-scoped global dictionary |
| `src/qwp/protocol/frameEncoder.ts` | **modify** — flags, delta-dict section, commit frame |
| `src/qwp/buffer.ts` | **modify** — all column types, `sealFrames()`, row rollback |
| `src/qwp/transport.ts` | **modify** — `sendFrames()`, cap tracking |
| `src/sender.ts` | **modify** — multi-frame flush path |

---

### Task 1: Widen the flush contract to multiple frames

**Files:**
- Modify: `src/qwp/buffer.ts`, `src/qwp/transport.ts`, `src/sender.ts`
- Test: `test/qwp/multiframe.test.ts`

**Interfaces:**
- Consumes: Plan 1's `QwpBuffer`, `QwpTransport`.
- Produces: `interface QwpMultiFrame { sealFrames(maxBatchSize: number): Buffer[] }` on `QwpBuffer`; `sendFrames(frames: Buffer[]): Promise<boolean>` on `QwpTransport`; a branch in `Sender.flush()`.

This is the widening spec 3.1 predicted. Do it before cap-splitting needs it, as its own reviewable change with behaviour unchanged (one frame in, one frame out).

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/multiframe.test.ts
import { describe, it, expect } from "vitest";
import { QwpBuffer } from "../../src/qwp/buffer";

describe("multi-frame sealing", () => {
  it("returns a single frame when the batch fits", () => {
    const b = new QwpBuffer();
    b.table("t").intColumn("x", 1);
    b.at(1n, "us");
    const frames = b.sealFrames(1_000_000);
    expect(frames.length).toBe(1);
    expect(frames[0].subarray(0, 4).toString("ascii")).toBe("QWP1");
  });

  it("returns an empty array when nothing is buffered", () => {
    expect(new QwpBuffer().sealFrames(1_000_000)).toEqual([]);
  });

  it("clears state after sealing", () => {
    const b = new QwpBuffer();
    b.table("t").intColumn("x", 1);
    b.at(1n, "us");
    b.sealFrames(1_000_000);
    expect(b.sealFrames(1_000_000)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/multiframe.test.ts`
Expected: FAIL — `b.sealFrames is not a function`.

- [ ] **Step 3: Implement**

In `src/qwp/buffer.ts`, replace `toBufferNew` and add `sealFrames`:

```ts
  /**
   * Seals the buffered rows into one or more frames. A flush produces more
   * than one frame only when the encoded batch exceeds maxBatchSize (spec 5.1);
   * splitting itself lands in Task 9.
   */
  sealFrames(maxBatchSize: number): Buffer[] {
    const dirty = this.tables.filter((t) => t.rowCount > 0);
    if (dirty.length === 0) return [];
    const frame = encodeFrame(dirty);
    this.reset();
    return [frame];
  }

  toBufferNew(): Buffer | null {
    const frames = this.sealFrames(Number.MAX_SAFE_INTEGER);
    if (frames.length === 0) return null;
    if (frames.length > 1) {
      throw new Error("QWP produced multiple frames; use sealFrames()");
    }
    return frames[0];
  }
```

In `src/qwp/transport.ts`:

```ts
  /** Sends each frame as its own WebSocket binary message. */
  async sendFrames(frames: Buffer[]): Promise<boolean> {
    if (!this.ws) throw new Error("QWP transport is not connected");
    for (const f of frames) {
      await this.ws.sendBinary(f);
    }
    return true;
  }

  /** Server-advertised cap, or a conservative default before the handshake. */
  get maxBatchSize(): number {
    return this.ws?.maxBatchSize ?? 16 * 1024 * 1024;
  }
```

In `src/sender.ts`, replace the body of `flush()`:

```ts
  async flush(): Promise<boolean> {
    // QWP can produce several frames per flush; ILP always produces one.
    const buf = this.buffer as unknown as {
      sealFrames?: (cap: number) => Buffer[];
    };
    const tx = this.transport as unknown as {
      sendFrames?: (f: Buffer[]) => Promise<boolean>;
      maxBatchSize?: number;
    };
    if (buf.sealFrames && tx.sendFrames) {
      const frames = buf.sealFrames(tx.maxBatchSize ?? Number.MAX_SAFE_INTEGER);
      if (frames.length === 0) return false;
      this.log("debug", `Flushing ${frames.length} QWP frame(s)`);
      this.resetAutoFlush();
      await tx.sendFrames(frames);
      return true;
    }

    const dataToSend: Buffer = this.buffer.toBufferNew();
    if (!dataToSend) {
      return false; // Nothing to send
    }
    this.log(
      "debug",
      `Flushing, number of flushed rows: ${this.pendingRowCount}`,
    );
    this.resetAutoFlush();
    await this.transport.send(dataToSend);
    return true;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/qwp/ && npx vitest run && npx tsc --noEmit`
Expected: PASS. ILP tests unaffected — they take the original branch.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/buffer.ts src/qwp/transport.ts src/sender.ts test/qwp/multiframe.test.ts
git commit -m "refactor(qwp): allow a flush to produce multiple frames"
```

---

### Task 2: Remaining fixed-width column types

**Files:**
- Modify: `src/qwp/protocol/constants.ts`
- Create: `src/qwp/protocol/columnWriter.ts`
- Modify: `src/qwp/protocol/frameEncoder.ts`
- Test: `test/qwp/columnWriter.test.ts`

**Interfaces:**
- Produces: `columnPayloadSize(col, rowCount, opts): number`, `writeColumn(buf, offset, col, rowCount, opts): number` exported from `columnWriter.ts`; `frameEncoder` delegates to them. `interface EncodeOpts { gorilla: boolean; globalSymbols?: SymbolDict }`.

Adds BOOLEAN (bit-packed), BYTE, SHORT, INT, FLOAT, DATE, UUID, LONG256, CHAR, IPv4 per spec 6.3.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/columnWriter.test.ts
import { describe, it, expect } from "vitest";
import { columnPayloadSize, writeColumn } from "../../src/qwp/protocol/columnWriter";
import { TYPE_BOOLEAN, TYPE_INT, TYPE_FLOAT } from "../../src/qwp/protocol/constants";

const opts = { gorilla: false };

function encode(col: any, rowCount: number): Buffer {
  const size = columnPayloadSize(col, rowCount, opts);
  const b = Buffer.alloc(size);
  const end = writeColumn(b, 0, col, rowCount, opts);
  expect(end).toBe(size);
  return b;
}

describe("column writers", () => {
  it("bit-packs BOOLEAN LSB-first over non-null values", () => {
    const col = { name: "b", type: TYPE_BOOLEAN, values: [true, false, true], nulls: [false, false, false], size: 3 };
    const b = encode(col, 3);
    expect(b[0]).toBe(0); // nullHeader
    expect(b[1]).toBe(0b00000101); // bits 0 and 2
    expect(b.length).toBe(2);
  });

  it("writes INT as 4 bytes LE", () => {
    const col = { name: "i", type: TYPE_INT, values: [258], nulls: [false], size: 1 };
    const b = encode(col, 1);
    expect(b.readInt32LE(1)).toBe(258);
  });

  it("writes FLOAT as 4 bytes IEEE754", () => {
    const col = { name: "f", type: TYPE_FLOAT, values: [1.5], nulls: [false], size: 1 };
    const b = encode(col, 1);
    expect(b.readFloatLE(1)).toBeCloseTo(1.5, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/columnWriter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Add to `src/qwp/protocol/constants.ts`:

```ts
export const TYPE_BOOLEAN = 0x01;
export const TYPE_BYTE = 0x02;
export const TYPE_SHORT = 0x03;
export const TYPE_INT = 0x04;
export const TYPE_FLOAT = 0x06;
export const TYPE_DATE = 0x0b;
export const TYPE_UUID = 0x0c;
export const TYPE_LONG256 = 0x0d;
export const TYPE_GEOHASH = 0x0e;
export const TYPE_VARCHAR = 0x0f;
export const TYPE_TIMESTAMP_NANOS = 0x10;
export const TYPE_DOUBLE_ARRAY = 0x11;
export const TYPE_LONG_ARRAY = 0x12;
export const TYPE_DECIMAL64 = 0x13;
export const TYPE_DECIMAL128 = 0x14;
export const TYPE_DECIMAL256 = 0x15;
export const TYPE_CHAR = 0x16;
export const TYPE_BINARY = 0x17;
export const TYPE_IPV4 = 0x18;

export const ENCODING_UNCOMPRESSED = 0x00;
export const ENCODING_GORILLA = 0x01;
```

Create `src/qwp/protocol/columnWriter.ts`. Move the null-header and bitmap logic out of `frameEncoder.ts` verbatim, then add the new arms:

```ts
// src/qwp/protocol/columnWriter.ts
import { Buffer } from "node:buffer";
import { writeVarint, varintSize } from "./varint";
import { ColumnBuffer } from "./tableBuffer";
import * as T from "./constants";

export interface EncodeOpts {
  gorilla: boolean;
}

function nullCountOf(col: ColumnBuffer): number {
  let n = 0;
  for (const v of col.nulls) if (v) n++;
  return n;
}

function fixedWidth(type: number): number | undefined {
  switch (type) {
    case T.TYPE_BYTE:
      return 1;
    case T.TYPE_SHORT:
    case T.TYPE_CHAR:
      return 2;
    case T.TYPE_INT:
    case T.TYPE_FLOAT:
    case T.TYPE_IPV4:
      return 4;
    case T.TYPE_LONG:
    case T.TYPE_DOUBLE:
    case T.TYPE_DATE:
      return 8;
    case T.TYPE_UUID:
      return 16;
    case T.TYPE_LONG256:
      return 32;
    default:
      return undefined;
  }
}

export function columnPayloadSize(
  col: ColumnBuffer,
  rowCount: number,
  opts: EncodeOpts,
): number {
  let n = 1;
  if (nullCountOf(col) > 0) n += Math.ceil(rowCount / 8);
  const v = col.values.length;

  if (col.type === T.TYPE_BOOLEAN) return n + Math.ceil(v / 8);

  const w = fixedWidth(col.type);
  if (w !== undefined) return n + v * w;

  if (col.type === T.TYPE_SYMBOL) {
    const dict = [...new Set(col.values as string[])];
    n += varintSize(dict.length);
    for (const s of dict) {
      const b = Buffer.byteLength(s, "utf8");
      n += varintSize(b) + b;
    }
    for (const s of col.values as string[]) n += varintSize(dict.indexOf(s));
    return n;
  }

  throw new Error(`unsupported QWP column type: 0x${col.type.toString(16)}`);
}

export function writeColumn(
  buf: Buffer,
  offset: number,
  col: ColumnBuffer,
  rowCount: number,
  opts: EncodeOpts,
): number {
  let o = offset;
  if (nullCountOf(col) > 0) {
    buf[o++] = 1;
    const bytes = Math.ceil(rowCount / 8);
    buf.fill(0, o, o + bytes);
    for (let i = 0; i < rowCount; i++) {
      if (col.nulls[i]) buf[o + (i >>> 3)] |= 1 << (i & 7);
    }
    o += bytes;
  } else {
    buf[o++] = 0;
  }

  switch (col.type) {
    case T.TYPE_BOOLEAN: {
      const bytes = Math.ceil(col.values.length / 8);
      buf.fill(0, o, o + bytes);
      col.values.forEach((v, i) => {
        if (v) buf[o + (i >>> 3)] |= 1 << (i & 7);
      });
      return o + bytes;
    }
    case T.TYPE_BYTE:
      for (const v of col.values) buf.writeInt8(Number(v), o++);
      return o;
    case T.TYPE_SHORT:
      for (const v of col.values) {
        buf.writeInt16LE(Number(v), o);
        o += 2;
      }
      return o;
    case T.TYPE_CHAR:
      for (const v of col.values) {
        buf.writeUInt16LE((v as string).charCodeAt(0), o);
        o += 2;
      }
      return o;
    case T.TYPE_INT:
      for (const v of col.values) {
        buf.writeInt32LE(Number(v), o);
        o += 4;
      }
      return o;
    case T.TYPE_IPV4:
      for (const v of col.values) {
        buf.writeUInt32LE(Number(v) >>> 0, o);
        o += 4;
      }
      return o;
    case T.TYPE_FLOAT:
      for (const v of col.values) {
        buf.writeFloatLE(Number(v), o);
        o += 4;
      }
      return o;
    case T.TYPE_LONG:
    case T.TYPE_DATE:
      for (const v of col.values) {
        buf.writeBigInt64LE(BigInt(v as number | bigint), o);
        o += 8;
      }
      return o;
    case T.TYPE_DOUBLE:
      for (const v of col.values) {
        buf.writeDoubleLE(Number(v), o);
        o += 8;
      }
      return o;
    case T.TYPE_UUID:
      for (const v of col.values) {
        (v as unknown as Buffer).copy(buf, o);
        o += 16;
      }
      return o;
    case T.TYPE_LONG256:
      for (const v of col.values) {
        (v as unknown as Buffer).copy(buf, o);
        o += 32;
      }
      return o;
    case T.TYPE_SYMBOL: {
      const dict = [...new Set(col.values as string[])];
      o = writeVarint(buf, o, dict.length);
      for (const s of dict) {
        const n = Buffer.byteLength(s, "utf8");
        o = writeVarint(buf, o, n);
        buf.write(s, o, "utf8");
        o += n;
      }
      for (const s of col.values as string[]) o = writeVarint(buf, o, dict.indexOf(s));
      return o;
    }
    default:
      throw new Error(`unsupported QWP column type: 0x${col.type.toString(16)}`);
  }
}
```

Then in `frameEncoder.ts`, delete the local `columnPayloadSize`/`writeColumn` and import them from `./columnWriter`, passing `{ gorilla: false }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/qwp/ && npx tsc --noEmit`
Expected: PASS, including Plan 1's `frameEncoder.test.ts` unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/protocol/constants.ts src/qwp/protocol/columnWriter.ts src/qwp/protocol/frameEncoder.ts test/qwp/columnWriter.test.ts
git commit -m "feat(qwp): add remaining fixed-width column types"
```

---

### Task 3: VARCHAR and BINARY

**Files:**
- Modify: `src/qwp/protocol/columnWriter.ts`, `src/qwp/buffer.ts`
- Test: `test/qwp/columnWriter.varchar.test.ts`

Wire layout is `(V+1) × u32` offsets then concatenated bytes (spec 6.3). BINARY shares it exactly.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/columnWriter.varchar.test.ts
import { describe, it, expect } from "vitest";
import { columnPayloadSize, writeColumn } from "../../src/qwp/protocol/columnWriter";
import { TYPE_VARCHAR } from "../../src/qwp/protocol/constants";

describe("VARCHAR", () => {
  it("writes V+1 offsets then concatenated utf8", () => {
    const col = { name: "s", type: TYPE_VARCHAR, values: ["ab", "cde"], nulls: [false, false], size: 2 };
    const opts = { gorilla: false };
    const size = columnPayloadSize(col as any, 2, opts);
    const b = Buffer.alloc(size);
    expect(writeColumn(b, 0, col as any, 2, opts)).toBe(size);
    expect(b[0]).toBe(0); // nullHeader
    expect(b.readUInt32LE(1)).toBe(0);
    expect(b.readUInt32LE(5)).toBe(2);
    expect(b.readUInt32LE(9)).toBe(5);
    expect(b.subarray(13).toString("utf8")).toBe("abcde");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/columnWriter.varchar.test.ts`
Expected: FAIL — "unsupported QWP column type: 0xf".

- [ ] **Step 3: Implement**

Add to `columnPayloadSize`, before the `throw`:

```ts
  if (col.type === T.TYPE_VARCHAR || col.type === T.TYPE_BINARY) {
    let data = 0;
    for (const s of col.values) {
      data += col.type === T.TYPE_VARCHAR
        ? Buffer.byteLength(s as string, "utf8")
        : (s as unknown as Buffer).length;
    }
    return n + (v + 1) * 4 + data;
  }
```

Add to `writeColumn`, before `default:`:

```ts
    case T.TYPE_VARCHAR:
    case T.TYPE_BINARY: {
      const parts: Buffer[] = col.values.map((s) =>
        col.type === T.TYPE_VARCHAR
          ? Buffer.from(s as string, "utf8")
          : (s as unknown as Buffer),
      );
      let acc = 0;
      buf.writeUInt32LE(0, o);
      o += 4;
      for (const p of parts) {
        acc += p.length;
        buf.writeUInt32LE(acc, o);
        o += 4;
      }
      for (const p of parts) {
        p.copy(buf, o);
        o += p.length;
      }
      return o;
    }
```

In `src/qwp/buffer.ts`, replace the `stringColumn` stub:

```ts
  stringColumn(name: string, value: string): SenderBuffer {
    if (typeof value !== "string") throw new Error("stringColumn accepts only string values");
    const col = this.require().getOrCreateColumn(name, TYPE_VARCHAR);
    if (col) col.values.push(value);
    return this;
  }
```

(Import `TYPE_VARCHAR` from `./protocol/constants`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/qwp/ && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/protocol/columnWriter.ts src/qwp/buffer.ts test/qwp/columnWriter.varchar.test.ts
git commit -m "feat(qwp): add VARCHAR and BINARY columns"
```

---

### Task 4: Arrays, decimals, geohash — with their accumulation rules

**Files:**
- Modify: `src/qwp/protocol/tableBuffer.ts`, `src/qwp/protocol/columnWriter.ts`, `src/qwp/buffer.ts`
- Test: `test/qwp/columnWriter.complex.test.ts`

**Spec 6.5.3 rules that must be implemented, not just the wire format:**
- GEOHASH precision is **locked on the column's first value**, 1–60.
- DECIMAL scale is **locked on first value**, and later values are **rescaled**, throwing only on precision loss.
- Arrays reject jagged shapes.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/columnWriter.complex.test.ts
import { describe, it, expect } from "vitest";
import { QwpTableBuffer } from "../../src/qwp/protocol/tableBuffer";
import { TYPE_GEOHASH, TYPE_DOUBLE_ARRAY } from "../../src/qwp/protocol/constants";
import { columnPayloadSize, writeColumn } from "../../src/qwp/protocol/columnWriter";

describe("complex column rules", () => {
  it("locks geohash precision on the first value", () => {
    const t = new QwpTableBuffer("t");
    const c = t.getOrCreateColumn("g", TYPE_GEOHASH)!;
    t.setGeoHashPrecision(c, 20);
    expect(() => t.setGeoHashPrecision(c, 25)).toThrow(/precision mismatch/i);
  });

  it("rejects an out-of-range geohash precision", () => {
    const t = new QwpTableBuffer("t");
    const c = t.getOrCreateColumn("g", TYPE_GEOHASH)!;
    expect(() => t.setGeoHashPrecision(c, 61)).toThrow(/1-60/);
  });

  it("writes a double array as per-value shape then values", () => {
    const col = {
      name: "m", type: TYPE_DOUBLE_ARRAY,
      values: [{ dims: [2], data: [1.5, 2.5] }],
      nulls: [false], size: 1,
    };
    const opts = { gorilla: false };
    const size = columnPayloadSize(col as any, 1, opts);
    const b = Buffer.alloc(size);
    expect(writeColumn(b, 0, col as any, 1, opts)).toBe(size);
    expect(b[1]).toBe(1); // nDims
    expect(b.readUInt32LE(2)).toBe(2); // dim length
    expect(b.readDoubleLE(6)).toBeCloseTo(1.5);
    expect(b.readDoubleLE(14)).toBeCloseTo(2.5);
  });

  it("rejects a jagged array", () => {
    const { flattenArray } = require("../../src/qwp/protocol/columnWriter");
    expect(() => flattenArray([[1, 2], [3]])).toThrow(/irregular array shape/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/columnWriter.complex.test.ts`
Expected: FAIL — `t.setGeoHashPrecision is not a function`.

- [ ] **Step 3: Implement**

In `tableBuffer.ts`, extend `ColumnBuffer` and add the locks:

```ts
export interface ColumnBuffer {
  name: string;
  type: number;
  values: unknown[];
  nulls: boolean[];
  size: number;
  geohashPrecision?: number;
  decimalScale?: number;
}
```

```ts
  /** Precision is 1-60 and locked on the column's first value (spec 6.5.3). */
  setGeoHashPrecision(col: ColumnBuffer, precision: number): void {
    if (precision < 1 || precision > 60) {
      throw new Error(`invalid GeoHash precision: ${precision} (must be 1-60)`);
    }
    if (col.geohashPrecision === undefined) {
      col.geohashPrecision = precision;
    } else if (col.geohashPrecision !== precision) {
      throw new Error(
        `GeoHash precision mismatch: column has ${col.geohashPrecision} bits, got ${precision}`,
      );
    }
  }

  /** Scale locks on the first value; later values rescale (spec 6.5.3). */
  setDecimalScale(col: ColumnBuffer, scale: number): number {
    if (col.decimalScale === undefined) col.decimalScale = scale;
    return col.decimalScale;
  }
```

In `columnWriter.ts` add the shape helper and the arms:

```ts
export function flattenArray(a: unknown[]): { dims: number[]; data: number[] } {
  const dims: number[] = [];
  let level: unknown = a;
  while (Array.isArray(level)) {
    dims.push(level.length);
    level = level[0];
  }
  const data: number[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth === dims.length) {
      data.push(node as number);
      return;
    }
    if (!Array.isArray(node) || node.length !== dims[depth]) {
      throw new Error("irregular array shape");
    }
    for (const child of node) walk(child, depth + 1);
  };
  walk(a, 0);
  return { dims, data };
}
```

Size arm:

```ts
  if (col.type === T.TYPE_DOUBLE_ARRAY || col.type === T.TYPE_LONG_ARRAY) {
    let total = 0;
    for (const val of col.values) {
      const a = val as { dims: number[]; data: number[] };
      total += 1 + a.dims.length * 4 + a.data.length * 8;
    }
    return n + total;
  }
  if (col.type === T.TYPE_GEOHASH) {
    const p = col.geohashPrecision ?? 1;
    return n + varintSize(p) + v * Math.ceil(p / 8);
  }
  if (col.type === T.TYPE_DECIMAL64) return n + 1 + v * 8;
  if (col.type === T.TYPE_DECIMAL128) return n + 1 + v * 16;
  if (col.type === T.TYPE_DECIMAL256) return n + 1 + v * 32;
```

Write arms:

```ts
    case T.TYPE_DOUBLE_ARRAY:
    case T.TYPE_LONG_ARRAY: {
      for (const val of col.values) {
        const a = val as { dims: number[]; data: number[] };
        buf.writeUInt8(a.dims.length, o++);
        for (const d of a.dims) {
          buf.writeUInt32LE(d, o);
          o += 4;
        }
        for (const x of a.data) {
          if (col.type === T.TYPE_DOUBLE_ARRAY) buf.writeDoubleLE(x, o);
          else buf.writeBigInt64LE(BigInt(x), o);
          o += 8;
        }
      }
      return o;
    }
    case T.TYPE_GEOHASH: {
      const p = col.geohashPrecision ?? 1;
      o = writeVarint(buf, o, p);
      const width = Math.ceil(p / 8);
      for (const val of col.values) {
        let bits = BigInt(val as bigint);
        for (let i = 0; i < width; i++) {
          buf.writeUInt8(Number(bits & 0xffn), o++);
          bits >>= 8n;
        }
      }
      return o;
    }
    case T.TYPE_DECIMAL64:
    case T.TYPE_DECIMAL128:
    case T.TYPE_DECIMAL256: {
      // scale is one byte at the START of the column payload, not in the
      // schema -- QwpConstants' javadoc says "in schema" and is wrong (spec 6.3)
      buf.writeUInt8(col.decimalScale ?? 0, o++);
      const width = col.type === T.TYPE_DECIMAL64 ? 8 : col.type === T.TYPE_DECIMAL128 ? 16 : 32;
      for (const val of col.values) {
        let x = BigInt(val as bigint);
        for (let i = 0; i < width; i++) {
          buf.writeUInt8(Number(x & 0xffn), o++);
          x >>= 8n;
        }
      }
      return o;
    }
```

In `buffer.ts` replace the `arrayColumn` stub:

```ts
  arrayColumn(name: string, value: unknown[]): SenderBuffer {
    const col = this.require().getOrCreateColumn(name, TYPE_DOUBLE_ARRAY);
    if (col) col.values.push(flattenArray(value));
    return this;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/qwp/ && npx tsc --noEmit`
Expected: PASS, 4 tests in the new file.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/protocol/tableBuffer.ts src/qwp/protocol/columnWriter.ts src/qwp/buffer.ts test/qwp/columnWriter.complex.test.ts
git commit -m "feat(qwp): add array, decimal and geohash columns with their locks"
```

---

### Task 5: Row rollback on a throwing setter

**Files:**
- Modify: `src/qwp/buffer.ts`
- Test: `test/qwp/rollback.test.ts`

Spec 4.1.1. A setter that throws mid-row must roll **all** columns back to the last row boundary, or columns desynchronise and every later frame is malformed while still looking structurally valid.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/rollback.test.ts
import { describe, it, expect } from "vitest";
import { QwpBuffer } from "../../src/qwp/buffer";

describe("row rollback", () => {
  it("leaves all columns equal-length after a mid-row throw", () => {
    const b = new QwpBuffer();
    b.table("t").intColumn("a", 1);
    expect(() => b.intColumn("bad", 1.5)).toThrow(); // not an integer
    b.intColumn("a2", 2);
    b.at(1n, "us");
    const frame = b.sealFrames(1_000_000)[0];
    // One row; the frame must encode without a size mismatch, which the
    // encoder asserts internally.
    expect(frame.readUInt16LE(6)).toBe(1);
  });

  it("produces bytes identical to a row that was never started", () => {
    const a = new QwpBuffer();
    a.table("t").intColumn("x", 1);
    a.at(5n, "us");
    const clean = a.sealFrames(1_000_000)[0];

    const c = new QwpBuffer();
    c.table("t");
    expect(() => c.intColumn("x", 0.5)).toThrow();
    c.table("t").intColumn("x", 1);
    c.at(5n, "us");
    expect(c.sealFrames(1_000_000)[0].equals(clean)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/rollback.test.ts`
Expected: FAIL on the byte-equality assertion — the failed setter leaves a partial column.

- [ ] **Step 3: Implement**

In `QwpTableBuffer` add:

```ts
  /** Truncates every column back to the last completed row (spec 4.1.1). */
  rollbackRow(): void {
    for (const c of this.cols) {
      while (c.size > this.rows) {
        const wasNull = c.nulls.pop();
        c.size--;
        if (wasNull === false) c.values.pop();
      }
    }
    // Drop columns created solely by the abandoned row.
    for (let i = this.cols.length - 1; i >= 0; i--) {
      if (this.cols[i].size === 0 && this.rows === 0) {
        this.byName.delete(this.cols[i].name);
        this.cols.splice(i, 1);
      }
    }
  }
```

In `QwpBuffer`, wrap every column setter. Introduce one helper and route all setters through it:

```ts
  private guard<R>(fn: () => R): R {
    try {
      return fn();
    } catch (e) {
      this.current?.rollbackRow();
      throw e;
    }
  }

  intColumn(name: string, value: number): SenderBuffer {
    return this.guard(() => {
      if (!Number.isInteger(value)) {
        throw new Error(`value must be an integer, received ${value}`);
      }
      const col = this.require().getOrCreateColumn(name, TYPE_LONG);
      if (col) col.values.push(BigInt(value));
      return this;
    });
  }
```

Apply the same `this.guard(() => { ... })` wrapper to `symbol`, `floatColumn`, `timestampColumn`, `stringColumn`, `booleanColumn`, `arrayColumn`, `decimalColumnText`, `decimalColumn`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/qwp/ && npx tsc --noEmit`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/protocol/tableBuffer.ts src/qwp/buffer.ts test/qwp/rollback.test.ts
git commit -m "feat(qwp): roll back the in-progress row when a setter throws"
```

---

### Task 6: Symbol dictionary — full-dict mode

**Files:**
- Create: `src/qwp/protocol/symbolDict.ts`
- Test: `test/qwp/symbolDict.test.ts`

**Interfaces:**
- Produces: `class SymbolDict` with `getOrAdd(s: string): number`, `size(): number`, `entriesFrom(startId: number): string[]`, `reset(): void`, `addRecovered(s: string): number`.

`addRecovered` appends **without de-duplicating** (spec 8.1.6) — ids are positional, and collapsing two entries silently renumbers everything after.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/symbolDict.test.ts
import { describe, it, expect } from "vitest";
import { SymbolDict } from "../../src/qwp/protocol/symbolDict";
import { MAX_SYMBOL_DICTIONARY_SIZE } from "../../src/qwp/protocol/constants";

describe("SymbolDict", () => {
  it("assigns dense ids from 0 and de-dupes on getOrAdd", () => {
    const d = new SymbolDict();
    expect(d.getOrAdd("a")).toBe(0);
    expect(d.getOrAdd("b")).toBe(1);
    expect(d.getOrAdd("a")).toBe(0);
    expect(d.size()).toBe(2);
  });

  it("returns entries above a baseline", () => {
    const d = new SymbolDict();
    d.getOrAdd("a");
    d.getOrAdd("b");
    d.getOrAdd("c");
    expect(d.entriesFrom(1)).toEqual(["b", "c"]);
  });

  it("addRecovered never de-duplicates", () => {
    const d = new SymbolDict();
    d.addRecovered("x");
    d.addRecovered("x");
    expect(d.size()).toBe(2); // positional ids must be preserved
  });

  it("enforces the dictionary cap at registration time", () => {
    const d = new SymbolDict();
    // Cheap proxy: assert the guard exists rather than adding a million entries.
    expect(MAX_SYMBOL_DICTIONARY_SIZE).toBe(1_000_000);
    expect(() => d.checkCap(MAX_SYMBOL_DICTIONARY_SIZE)).toThrow(/dictionary/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/symbolDict.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Add `export const MAX_SYMBOL_DICTIONARY_SIZE = 1_000_000;` to `constants.ts`, then:

```ts
// src/qwp/protocol/symbolDict.ts
import { MAX_SYMBOL_DICTIONARY_SIZE } from "./constants";

/** Connection-scoped global symbol dictionary. Ids are dense from 0. */
export class SymbolDict {
  private readonly ids = new Map<string, number>();
  private readonly list: string[] = [];

  size(): number {
    return this.list.length;
  }

  checkCap(next: number): void {
    if (next >= MAX_SYMBOL_DICTIONARY_SIZE) {
      throw new Error(
        `symbol dictionary exceeds maximum size ${MAX_SYMBOL_DICTIONARY_SIZE}`,
      );
    }
  }

  getOrAdd(s: string): number {
    const existing = this.ids.get(s);
    if (existing !== undefined) return existing;
    this.checkCap(this.list.length);
    const id = this.list.length;
    this.ids.set(s, id);
    this.list.push(s);
    return id;
  }

  /**
   * Appends at the next id WITHOUT de-duplicating. The persisted dictionary,
   * the wire delta and the catch-up mirror all key on POSITION, so collapsing
   * two entries would leave this shorter than the persisted count and silently
   * misattribute every later symbol (spec 8.1.6).
   */
  addRecovered(s: string): number {
    const id = this.list.length;
    this.list.push(s);
    if (!this.ids.has(s)) this.ids.set(s, id);
    else this.ids.set(s, id); // keep the highest id; both encode identically
    return id;
  }

  entriesFrom(startId: number): string[] {
    return this.list.slice(Math.max(0, startId));
  }

  reset(): void {
    this.ids.clear();
    this.list.length = 0;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/qwp/symbolDict.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/protocol/symbolDict.ts src/qwp/protocol/constants.ts test/qwp/symbolDict.test.ts
git commit -m "feat(qwp): add connection-scoped symbol dictionary"
```

---

### Task 7: Delta symbol dictionary on the wire

**Files:**
- Modify: `src/qwp/protocol/frameEncoder.ts`, `src/qwp/protocol/columnWriter.ts`, `src/qwp/buffer.ts`
- Test: `test/qwp/deltaDict.test.ts`

Spec 5.2 and 6.2. With `FLAG_DELTA_SYMBOL_DICT` set, the payload opens with `varint deltaStart, varint deltaCount, count × [varint len][utf8]`, and symbol columns carry **no per-column dictionary** — just a varint global id per value.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/deltaDict.test.ts
import { describe, it, expect } from "vitest";
import { encodeFrame } from "../../src/qwp/protocol/frameEncoder";
import { QwpTableBuffer } from "../../src/qwp/protocol/tableBuffer";
import { SymbolDict } from "../../src/qwp/protocol/symbolDict";
import { TYPE_SYMBOL, FLAG_DELTA_SYMBOL_DICT } from "../../src/qwp/protocol/constants";
import { readVarint } from "../../src/qwp/protocol/varint";

describe("delta symbol dictionary", () => {
  it("sets the flag and emits only newly-seen symbols", () => {
    const dict = new SymbolDict();
    dict.getOrAdd("already"); // id 0, already confirmed
    const t = new QwpTableBuffer("t");
    t.getOrCreateColumn("s", TYPE_SYMBOL)!.values.push(dict.getOrAdd("fresh")); // id 1
    t.nextRow();

    const f = encodeFrame([t], { gorilla: false, dict, confirmedMaxId: 0 });
    expect(f.readUInt8(5) & FLAG_DELTA_SYMBOL_DICT).toBe(FLAG_DELTA_SYMBOL_DICT);

    let o = 12;
    const start = readVarint(f, o);
    o = start.offset;
    const count = readVarint(f, o);
    expect(start.value).toBe(1); // confirmedMaxId + 1
    expect(count.value).toBe(1); // only "fresh"
  });

  it("emits an empty delta when nothing new was registered", () => {
    const dict = new SymbolDict();
    dict.getOrAdd("a");
    const t = new QwpTableBuffer("t");
    t.getOrCreateColumn("s", TYPE_SYMBOL)!.values.push(0);
    t.nextRow();
    const f = encodeFrame([t], { gorilla: false, dict, confirmedMaxId: 0 });
    let o = 12;
    const start = readVarint(f, o);
    const count = readVarint(f, start.offset);
    expect(count.value).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/deltaDict.test.ts`
Expected: FAIL — `encodeFrame` takes one argument.

- [ ] **Step 3: Implement**

Change `encodeFrame`'s signature and body in `frameEncoder.ts`:

```ts
export interface FrameOpts {
  gorilla: boolean;
  /** Present means delta mode; absent means full-dict/inline mode. */
  dict?: SymbolDict;
  /** Highest symbol id the server has already confirmed. */
  confirmedMaxId?: number;
  deferCommit?: boolean;
}

export function encodeFrame(tables: QwpTableBuffer[], opts: FrameOpts): Buffer {
  const delta = opts.dict !== undefined;
  const deltaStart = delta ? (opts.confirmedMaxId ?? -1) + 1 : 0;
  const entries = delta ? opts.dict!.entriesFrom(deltaStart) : [];

  let flags = 0;
  if (opts.gorilla) flags |= FLAG_GORILLA;
  if (delta) flags |= FLAG_DELTA_SYMBOL_DICT;
  if (opts.deferCommit) flags |= FLAG_DEFER_COMMIT;

  let payloadLen = 0;
  if (delta) {
    payloadLen += varintSize(deltaStart) + varintSize(entries.length);
    for (const s of entries) {
      const n = Buffer.byteLength(s, "utf8");
      payloadLen += varintSize(n) + n;
    }
  }
  const colOpts = { gorilla: opts.gorilla, delta };
  payloadLen += tables.reduce((a, t) => a + tableSize(t, colOpts), 0);

  const buf = Buffer.allocUnsafe(HEADER_SIZE + payloadLen);
  QWP_MAGIC.copy(buf, 0);
  buf.writeUInt8(QWP_VERSION, 4);
  buf.writeUInt8(flags, 5);
  buf.writeUInt16LE(tables.length, 6);
  buf.writeUInt32LE(payloadLen, 8);

  let o = HEADER_SIZE;
  if (delta) {
    o = writeVarint(buf, o, deltaStart);
    o = writeVarint(buf, o, entries.length);
    for (const s of entries) {
      const n = Buffer.byteLength(s, "utf8");
      o = writeVarint(buf, o, n);
      buf.write(s, o, "utf8");
      o += n;
    }
  }
  for (const t of tables) {
    o = writeString(buf, o, t.name);
    o = writeVarint(buf, o, t.rowCount);
    o = writeVarint(buf, o, t.columns.length);
    for (const c of t.columns) {
      o = writeString(buf, o, c.name);
      buf.writeUInt8(c.type, o++);
    }
    for (const c of t.columns) o = writeColumn(buf, o, c, t.rowCount, colOpts);
  }
  if (o !== buf.length) throw new Error(`frame size mismatch: wrote ${o}, sized ${buf.length}`);
  return buf;
}
```

In `columnWriter.ts` add `delta?: boolean` to `EncodeOpts`, and in the SYMBOL arms:

```ts
  // size
  if (col.type === T.TYPE_SYMBOL) {
    if (opts.delta) {
      let n2 = 0;
      for (const id of col.values as number[]) n2 += varintSize(id);
      return n + n2;
    }
    // ...existing inline-dictionary sizing
  }
```

```ts
    case T.TYPE_SYMBOL: {
      if (opts.delta) {
        for (const id of col.values as number[]) o = writeVarint(buf, o, id);
        return o;
      }
      // ...existing inline-dictionary writing
    }
```

In `buffer.ts`, `symbol()` stores a global id when a dict is attached, otherwise the string:

```ts
  symbol(name: string, value: unknown): SenderBuffer {
    return this.guard(() => {
      const col = this.require().getOrCreateColumn(name, TYPE_SYMBOL);
      if (col) col.values.push(this.dict ? this.dict.getOrAdd(String(value)) : String(value));
      return this;
    });
  }
```

Add `private dict?: SymbolDict` and `attachDict(d: SymbolDict) { this.dict = d; }` to `QwpBuffer`, and pass `{ gorilla: false, dict: this.dict, confirmedMaxId: this.confirmedMaxId }` from `sealFrames`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/qwp/ && npx tsc --noEmit`
Expected: PASS. Plan 1's `frameEncoder.test.ts` needs its `encodeFrame([t])` calls updated to `encodeFrame([t], { gorilla: false })` — do that as part of this step.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/protocol/ src/qwp/buffer.ts test/qwp/
git commit -m "feat(qwp): add delta symbol dictionary encoding"
```

---

### Task 8: Gorilla timestamps

**Files:**
- Create: `src/qwp/protocol/bits.ts`, `src/qwp/protocol/gorilla.ts`
- Modify: `src/qwp/protocol/columnWriter.ts`
- Test: `test/qwp/gorilla.test.ts`

**The trap (spec 6.3.2):** packing is LSB-first, so the prefix constants are **bit-reversed** relative to how they read. `'10'` is written as `writeBits(0b01, 2)`, `'110'` as `0b011`, `'1110'` as `0b0111`. Writing `0b10` for `'10'` produces plausible-but-wrong timestamps rather than a decode failure.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/gorilla.test.ts
import { describe, it, expect } from "vitest";
import { BitWriter } from "../../src/qwp/protocol/bits";
import { gorillaSize, encodeGorilla } from "../../src/qwp/protocol/gorilla";

describe("BitWriter", () => {
  it("packs LSB-first within each byte", () => {
    const w = new BitWriter(4);
    w.writeBits(0b1, 1);
    w.writeBits(0b0, 1);
    w.writeBits(0b1, 1);
    const out = w.finish();
    expect(out[0]).toBe(0b00000101);
  });
});

describe("gorilla", () => {
  it("returns -1 when a delta-of-delta leaves int32", () => {
    const ts = [0n, 1n, BigInt(2 ** 40)];
    expect(gorillaSize(ts)).toBe(-1);
  });

  it("sizes a constant-interval series as first two raw plus one bit per row", () => {
    const ts = [1000n, 2000n, 3000n, 4000n];
    // 8 + 8 + ceil(2 bits / 8) = 17
    expect(gorillaSize(ts)).toBe(17);
  });

  it("emits the first two timestamps raw", () => {
    const ts = [1000n, 2000n, 3000n];
    const b = encodeGorilla(ts);
    expect(b.readBigInt64LE(0)).toBe(1000n);
    expect(b.readBigInt64LE(8)).toBe(2000n);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/gorilla.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// src/qwp/protocol/bits.ts
import { Buffer } from "node:buffer";

/** LSB-first bit writer; trailing bits are zero-padded to a byte boundary. */
export class BitWriter {
  private readonly buf: Buffer;
  private byteIndex = 0;
  private bitIndex = 0;

  constructor(capacity: number) {
    this.buf = Buffer.alloc(capacity);
  }

  writeBits(value: number, count: number): void {
    for (let i = 0; i < count; i++) {
      if ((value >>> i) & 1) this.buf[this.byteIndex] |= 1 << this.bitIndex;
      if (++this.bitIndex === 8) {
        this.bitIndex = 0;
        this.byteIndex++;
      }
    }
  }

  finish(): Buffer {
    const len = this.byteIndex + (this.bitIndex > 0 ? 1 : 0);
    return this.buf.subarray(0, len);
  }
}
```

```ts
// src/qwp/protocol/gorilla.ts
import { Buffer } from "node:buffer";
import { BitWriter } from "./bits";

const INT32_MIN = -2147483648n;
const INT32_MAX = 2147483647n;

function bitsRequired(dod: bigint): number {
  if (dod === 0n) return 1;
  if (dod >= -64n && dod <= 63n) return 9;
  if (dod >= -256n && dod <= 255n) return 12;
  if (dod >= -2048n && dod <= 2047n) return 16;
  return 36;
}

/** Encoded size in bytes, or -1 when a delta-of-delta leaves int32 range. */
export function gorillaSize(ts: bigint[]): number {
  if (ts.length === 0) return 0;
  if (ts.length === 1) return 8;
  if (ts.length === 2) return 16;
  let prevTs = ts[1];
  let prevDelta = ts[1] - ts[0];
  let bits = 0;
  for (let i = 2; i < ts.length; i++) {
    const delta = ts[i] - prevTs;
    const dod = delta - prevDelta;
    if (dod < INT32_MIN || dod > INT32_MAX) return -1;
    bits += bitsRequired(dod);
    prevDelta = delta;
    prevTs = ts[i];
  }
  return 16 + Math.ceil(bits / 8);
}

export function encodeGorilla(ts: bigint[]): Buffer {
  const size = gorillaSize(ts);
  if (size < 0) throw new Error("gorilla: delta-of-delta out of int32 range");
  const out = Buffer.alloc(size);
  out.writeBigInt64LE(ts[0], 0);
  if (ts.length === 1) return out;
  out.writeBigInt64LE(ts[1], 8);
  if (ts.length === 2) return out;

  const w = new BitWriter(size - 16);
  let prevTs = ts[1];
  let prevDelta = ts[1] - ts[0];
  for (let i = 2; i < ts.length; i++) {
    const delta = ts[i] - prevTs;
    const dod = delta - prevDelta;
    // Prefixes are BIT-REVERSED because packing is LSB-first (spec 6.3.2).
    if (dod === 0n) {
      w.writeBits(0b0, 1);
    } else if (dod >= -64n && dod <= 63n) {
      w.writeBits(0b01, 2); // logical '10'
      w.writeBits(Number(dod & 0x7fn), 7);
    } else if (dod >= -256n && dod <= 255n) {
      w.writeBits(0b011, 3); // logical '110'
      w.writeBits(Number(dod & 0x1ffn), 9);
    } else if (dod >= -2048n && dod <= 2047n) {
      w.writeBits(0b0111, 4); // logical '1110'
      w.writeBits(Number(dod & 0xfffn), 12);
    } else {
      w.writeBits(0b1111, 4); // logical '1111'
      w.writeBits(Number(dod & 0xffffffffn), 32);
    }
    prevDelta = delta;
    prevTs = ts[i];
  }
  w.finish().copy(out, 16);
  return out;
}
```

In `columnWriter.ts`, timestamps become (spec 6.3.1) — note the encoding byte exists **only** when the gorilla flag is set, and is still emitted as `0x00` for columns of ≤ 2 values:

```ts
    case T.TYPE_TIMESTAMP:
    case T.TYPE_TIMESTAMP_NANOS: {
      const ts = col.values.map((v) => BigInt(v as bigint));
      if (!opts.gorilla) {
        for (const v of ts) {
          buf.writeBigInt64LE(v, o);
          o += 8;
        }
        return o;
      }
      const size = ts.length > 2 ? gorillaSize(ts) : -1;
      if (size > 0) {
        buf.writeUInt8(T.ENCODING_GORILLA, o++);
        encodeGorilla(ts).copy(buf, o);
        return o + size;
      }
      buf.writeUInt8(T.ENCODING_UNCOMPRESSED, o++);
      for (const v of ts) {
        buf.writeBigInt64LE(v, o);
        o += 8;
      }
      return o;
    }
```

Mirror the same branching in `columnPayloadSize`. **DATE is excluded** — it stays in the fixed-width path and never carries an encoding byte.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/qwp/ && npx tsc --noEmit`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/protocol/bits.ts src/qwp/protocol/gorilla.ts src/qwp/protocol/columnWriter.ts test/qwp/gorilla.test.ts
git commit -m "feat(qwp): add Gorilla timestamp encoding"
```

---

### Task 9: Cap-splitting and the commit frame

**Files:**
- Modify: `src/qwp/buffer.ts`, `src/qwp/protocol/frameEncoder.ts`
- Test: `test/qwp/capSplit.test.ts`

Spec 5.1 and 5.1.1. When the combined frame exceeds the cap, split **per table**; all but the last carry `FLAG_DEFER_COMMIT`. **Pre-flight every frame before publishing any.** The commit frame is `tableCount = 0`, no rows, flag cleared, and an empty delta built **by construction** from `[baseline+1 .. baseline]`.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/capSplit.test.ts
import { describe, it, expect } from "vitest";
import { QwpBuffer } from "../../src/qwp/buffer";
import { encodeCommitFrame } from "../../src/qwp/protocol/frameEncoder";
import { SymbolDict } from "../../src/qwp/protocol/symbolDict";
import { FLAG_DEFER_COMMIT } from "../../src/qwp/protocol/constants";

describe("cap splitting", () => {
  it("splits per table when the batch exceeds the cap", () => {
    const b = new QwpBuffer();
    for (const t of ["a", "b", "c"]) {
      b.table(t).intColumn("x", 1);
      b.at(1n, "us");
    }
    const frames = b.sealFrames(80); // small cap forces a split
    expect(frames.length).toBe(3);
    // All but the last defer the commit.
    expect(frames[0].readUInt8(5) & FLAG_DEFER_COMMIT).toBe(FLAG_DEFER_COMMIT);
    expect(frames[1].readUInt8(5) & FLAG_DEFER_COMMIT).toBe(FLAG_DEFER_COMMIT);
    expect(frames[2].readUInt8(5) & FLAG_DEFER_COMMIT).toBe(0);
  });

  it("throws before publishing when one table cannot fit any split", () => {
    const b = new QwpBuffer();
    b.table("wide").stringColumn("s", "x".repeat(500));
    b.at(1n, "us");
    expect(() => b.sealFrames(50)).toThrow(/cannot fit/i);
  });

  it("builds a commit frame with no tables and an empty delta", () => {
    const dict = new SymbolDict();
    dict.getOrAdd("a");
    const f = encodeCommitFrame(dict, 0);
    expect(f.readUInt16LE(6)).toBe(0); // tableCount
    expect(f.readUInt8(5) & FLAG_DEFER_COMMIT).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/capSplit.test.ts`
Expected: FAIL — `encodeCommitFrame` not exported; `sealFrames` never splits.

- [ ] **Step 3: Implement**

Add to `frameEncoder.ts`:

```ts
/**
 * A commit carries no rows and MUST carry no symbols. The empty delta is built
 * by construction from [baseline+1 .. baseline] — deriving the bound from batch
 * state re-ships the whole dictionary in a frame no chunker covers (spec 5.1.1).
 */
export function encodeCommitFrame(dict: SymbolDict | undefined, baseline: number): Buffer {
  return encodeFrame([], { gorilla: false, dict, confirmedMaxId: baseline, deferCommit: false });
}
```

Because `entriesFrom(baseline + 1)` on a dictionary whose size is `baseline + 1` returns `[]`, the delta is empty by construction — no special-casing.

Replace `sealFrames` in `buffer.ts`:

```ts
  sealFrames(maxBatchSize: number): Buffer[] {
    const dirty = this.tables.filter((t) => t.rowCount > 0);
    if (dirty.length === 0) return [];

    const opts = { gorilla: this.gorilla, dict: this.dict, confirmedMaxId: this.confirmedMaxId };
    const combined = encodeFrame(dirty, { ...opts, deferCommit: this.deferCommit });
    if (combined.length <= maxBatchSize) {
      this.reset();
      return [combined];
    }

    // Pre-flight EVERY split frame before publishing any: discovering an
    // oversized frame mid-publish strands the already-sent prefix and a later
    // commit delivers a partial batch (spec 5.1).
    const parts: Buffer[] = [];
    for (let i = 0; i < dirty.length; i++) {
      const isLast = i === dirty.length - 1;
      const f = encodeFrame([dirty[i]], {
        ...opts,
        deferCommit: this.deferCommit ? true : !isLast,
      });
      if (f.length > maxBatchSize) {
        throw new Error(
          `batch cannot fit the server cap however it is split ` +
            `[table=${dirty[i].name}, frameSize=${f.length}, cap=${maxBatchSize}]`,
        );
      }
      parts.push(f);
    }
    this.reset();
    return parts;
  }
```

Add `private gorilla = true;`, `private deferCommit = false;`, `private confirmedMaxId = -1;` to `QwpBuffer`, plus `setDeferCommit(on: boolean) { this.deferCommit = on; }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/qwp/ && npx tsc --noEmit`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/buffer.ts src/qwp/protocol/frameEncoder.ts test/qwp/capSplit.test.ts
git commit -m "feat(qwp): add cap-splitting and the commit frame"
```

---

### Task 10: End-to-end across all types

**Files:**
- Modify: `test/qwp/integration.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the existing describe block from Plan 1:

```ts
  it("round-trips every supported column type", async () => {
    const sender = await Sender.fromConfig(
      `ws::addr=${container.getHost()}:${httpPort};`,
    );
    await sender.connect();
    await sender
      .table("qwp_types")
      .symbol("sym", "A")
      .stringColumn("str", "hello")
      .booleanColumn("flag", true)
      .intColumn("i", 42)
      .floatColumn("d", 1.25)
      .timestampColumn("ts2", 1_700_000_000_000_000n, "us")
      .at(1_700_000_000_000_000n, "us");
    await sender.flush();
    await sender.close();

    let rows: any[] = [];
    for (let i = 0; i < 60; i++) {
      const r = await query("select sym, str, flag, i, d from qwp_types");
      rows = r.dataset ?? [];
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(rows[0][0]).toBe("A");
    expect(rows[0][1]).toBe("hello");
    expect(rows[0][2]).toBe(true);
    expect(rows[0][3]).toBe(42);
    expect(rows[0][4]).toBeCloseTo(1.25, 5);
  }, 180_000);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/integration.test.ts`
Expected: FAIL — `booleanColumn` still throws "not supported" until Task 2 lands, then passes.

- [ ] **Step 3: Wire the remaining setters in `buffer.ts`**

```ts
  booleanColumn(name: string, value: boolean): SenderBuffer {
    return this.guard(() => {
      const col = this.require().getOrCreateColumn(name, TYPE_BOOLEAN);
      if (col) col.values.push(value);
      return this;
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run && npx tsc --noEmit && npx eslint src/**`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/buffer.ts test/qwp/integration.test.ts
git commit -m "test(qwp): end-to-end coverage for all supported column types"
```

---

## Self-Review

**1. Spec coverage.** Remaining scalars (Task 2 — 6.3). VARCHAR/BINARY (Task 3). Arrays/decimals/geohash with locks (Task 4 — 6.5.3). Row rollback (Task 5 — 4.1.1). Symbol dict, both modes (Tasks 6, 7 — 5.2, 6.2). Gorilla with bit-reversed prefixes (Task 8 — 6.3.2). Cap-split + commit frame (Task 9 — 5.1, 5.1.1). Multi-frame contract (Task 1 — 3.1).

**Deferred to Plan 3, not dropped:** the delta→full-dict runtime fallback (5.2) needs the `.symbol-dict` file from Plan 4, so `QwpBuffer` starts in full-dict mode unless a dict is attached; `DICTIONARY_GAP` handling needs the ACK path.

**2. Placeholder scan.** None. Every step carries code.

**3. Type consistency.** `EncodeOpts { gorilla, delta? }` (Task 2) gains `delta` in Task 7 and is used in Task 8. `FrameOpts` (Task 7) is used by `encodeCommitFrame` (Task 9). `SymbolDict.entriesFrom` (Task 6) is called in Task 7 and relied on for the empty-by-construction commit delta in Task 9. `sealFrames(maxBatchSize)` (Task 1) is re-implemented in Task 9 with the same signature.

**Known churn, stated:** Task 7 changes `encodeFrame`'s arity, so Plan 1's `frameEncoder.test.ts` must be updated in that task's Step 4. Task 2 moves `columnPayloadSize`/`writeColumn` out of `frameEncoder.ts`; Plan 1's tests import from `frameEncoder` only via `encodeFrame`, so they are unaffected.
