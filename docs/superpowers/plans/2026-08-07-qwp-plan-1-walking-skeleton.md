# QWP Plan 1 — Walking Skeleton (spec PRs 1–3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `ws::` ingest end-to-end in `@questdb/nodejs-client` — a QuestDB server accepts rows sent over QWP with LONG, DOUBLE, TIMESTAMP and SYMBOL columns, verified by SQL in a testcontainers test.

**Architecture:** Four layers under `src/qwp/`, no upward dependencies. `ws/` is a hand-rolled RFC 6455 codec over `net`/`tls`. `protocol/` is pure `Buffer` functions with no I/O. `buffer.ts` implements the existing `SenderBuffer` interface by accumulating columnar data and sealing one QWP frame in `toBufferNew()`. `transport.ts` implements the existing `SenderTransport` interface. Because `Sender.flush()` is exactly `buffer.toBufferNew()` → `transport.send(buf)`, **no existing interface is widened in this plan.**

**Tech Stack:** TypeScript, Node ≥ 20, `node:net`, `node:tls`, `node:crypto`, `node:buffer`. Tests: vitest. Integration: testcontainers. **No new runtime dependencies.**

**Source of truth:** `docs/superpowers/specs/2026-08-07-qwp-nodejs-client-design.md`. Section references below (e.g. 6.2.1) point into it.

## Global Constraints

- **No new runtime dependencies.** The package currently depends only on `undici`. Do not add `ws`, a CRC library, or a WebSocket framework (spec 3.3).
- **Node 20 floor.** No API newer than Node 20. There is no zstd on this path (spec 9.3).
- **All integers little-endian** on the wire (spec 6).
- **`varint` means unsigned LEB128**, never zig-zag unless a codec explicitly asks (spec 6.0).
- **`V` = `valueCount` = non-null row count.** Column payloads are compacted; never write placeholder slots for nulls (spec 6.2.1).
- **Options stay `undefined` until set.** Never pre-seed defaults with `??`; "unset" and "set to the default" must remain distinguishable (spec 9.1.2).
- Existing tests must stay green: `pnpm test`, `pnpm typecheck`, `pnpm eslint`.
- Out of scope in this plan, do not build: store-and-forward, FSN/ACK correlation, reconnect, failover, Gorilla, delta symbol dictionary, cap-splitting, remaining column types.

## File Structure

| File | Responsibility |
|---|---|
| `src/qwp/protocol/varint.ts` | LEB128 encode/decode, size calculation |
| `src/qwp/protocol/constants.ts` | Magic, version, flags, type codes, limits |
| `src/qwp/protocol/tableBuffer.ts` | Per-table columnar accumulation, type lock, null tracking |
| `src/qwp/protocol/frameEncoder.ts` | Header + table block + schema + column payloads |
| `src/qwp/ws/mask.ts` | Per-frame CSPRNG mask key, XOR |
| `src/qwp/ws/frame.ts` | RFC 6455 frame encode + incremental parse + defragmentation |
| `src/qwp/ws/handshake.ts` | Upgrade request, `Sec-WebSocket-Accept`, response classification |
| `src/qwp/ws/socket.ts` | net/tls connect, frame send/receive, control frames |
| `src/qwp/buffer.ts` | `QwpBuffer implements SenderBuffer` |
| `src/qwp/transport.ts` | `QwpTransport implements SenderTransport` |
| `src/options.ts` | **modify** — 4 protocol-branch sites |
| `src/buffer/index.ts` | **modify** — branch on protocol before protocol_version |
| `src/transport/index.ts` | **modify** — `case WS/WSS` |
| `src/index.ts` | **modify** — exports |

---

### Task 1: LEB128 varint

**Files:**
- Create: `src/qwp/protocol/varint.ts`
- Test: `test/qwp/varint.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `writeVarint(buf: Buffer, offset: number, value: number): number` (returns new offset), `varintSize(value: number): number`, `readVarint(buf: Buffer, offset: number): { value: number; offset: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/varint.test.ts
import { describe, it, expect } from "vitest";
import { writeVarint, varintSize, readVarint } from "../../src/qwp/protocol/varint";

describe("varint (unsigned LEB128)", () => {
  it("encodes single-byte values", () => {
    const b = Buffer.alloc(4);
    expect(writeVarint(b, 0, 0)).toBe(1);
    expect(b[0]).toBe(0x00);
    expect(writeVarint(b, 0, 127)).toBe(1);
    expect(b[0]).toBe(0x7f);
  });

  it("encodes multi-byte values with the continuation bit", () => {
    const b = Buffer.alloc(4);
    const end = writeVarint(b, 0, 128);
    expect(end).toBe(2);
    expect(b[0]).toBe(0x80);
    expect(b[1]).toBe(0x01);
  });

  it("round-trips a range of values", () => {
    for (const v of [0, 1, 127, 128, 300, 16383, 16384, 1_000_000]) {
      const b = Buffer.alloc(10);
      const end = writeVarint(b, 0, v);
      expect(end).toBe(varintSize(v));
      expect(readVarint(b, 0)).toEqual({ value: v, offset: end });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/varint.test.ts` (from the repo root, as every other command in this plan)
Expected: FAIL — cannot resolve `../../src/qwp/protocol/varint`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/qwp/protocol/varint.ts
import { Buffer } from "node:buffer";

/** Unsigned LEB128. 7 data bits per byte; high bit set means another byte follows. */
export function writeVarint(buf: Buffer, offset: number, value: number): number {
  if (value < 0 || !Number.isInteger(value)) {
    throw new Error(`varint requires a non-negative integer, got ${value}`);
  }
  let v = value;
  let o = offset;
  while (v >= 0x80) {
    buf[o++] = (v & 0x7f) | 0x80;
    v = Math.floor(v / 128);
  }
  buf[o++] = v;
  return o;
}

export function varintSize(value: number): number {
  let v = value;
  let n = 1;
  while (v >= 0x80) {
    v = Math.floor(v / 128);
    n++;
  }
  return n;
}

export function readVarint(
  buf: Buffer,
  offset: number,
): { value: number; offset: number } {
  let value = 0;
  let shift = 1;
  let o = offset;
  for (;;) {
    if (o >= buf.length) throw new Error("incomplete varint");
    const b = buf[o++];
    value += (b & 0x7f) * shift;
    if ((b & 0x80) === 0) break;
    shift *= 128;
  }
  return { value, offset: o };
}
```

Note: `Math.floor(v / 128)` rather than `>>> 7` — `>>>` truncates to 32 bits and row counts can exceed that.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/qwp/varint.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/protocol/varint.ts test/qwp/varint.test.ts
git commit -m "feat(qwp): add unsigned LEB128 varint codec"
```

---

### Task 2: Protocol constants

**Files:**
- Create: `src/qwp/protocol/constants.ts`
- Test: `test/qwp/constants.test.ts`

**Interfaces:**
- Produces: `QWP_MAGIC`, `QWP_VERSION`, `HEADER_SIZE`, `FLAG_DEFER_COMMIT`, `FLAG_GORILLA`, `FLAG_DELTA_SYMBOL_DICT`, `TYPE_LONG`, `TYPE_DOUBLE`, `TYPE_SYMBOL`, `TYPE_TIMESTAMP`, `MAX_COLUMNS_PER_TABLE`, `MAX_NAME_LENGTH`, `WRITE_PATH`.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/constants.test.ts
import { describe, it, expect } from "vitest";
import { QWP_MAGIC, HEADER_SIZE, QWP_VERSION, TYPE_LONG, TYPE_SYMBOL } from "../../src/qwp/protocol/constants";

describe("QWP constants", () => {
  it("magic reads as 0x31505751 little-endian", () => {
    expect(QWP_MAGIC.toString("ascii")).toBe("QWP1");
    expect(QWP_MAGIC.readUInt32LE(0)).toBe(0x31505751);
  });

  it("pins header size and version", () => {
    expect(HEADER_SIZE).toBe(12);
    expect(QWP_VERSION).toBe(1);
  });

  it("pins the type codes this plan uses", () => {
    expect(TYPE_LONG).toBe(0x05);
    expect(TYPE_SYMBOL).toBe(0x09);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/constants.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/qwp/protocol/constants.ts
import { Buffer } from "node:buffer";

/** ASCII "QWP1"; reads as 0x31505751 when interpreted little-endian. */
export const QWP_MAGIC = Buffer.from("QWP1", "ascii");
export const QWP_VERSION = 1;
export const HEADER_SIZE = 12;

export const FLAG_DEFER_COMMIT = 0x01;
export const FLAG_GORILLA = 0x04;
export const FLAG_DELTA_SYMBOL_DICT = 0x08;

// Column type codes (spec 6.3). Only the four this plan encodes.
export const TYPE_DOUBLE = 0x07;
export const TYPE_SYMBOL = 0x09;
export const TYPE_TIMESTAMP = 0x0a;
export const TYPE_LONG = 0x05;

// Limits mirrored from the server (spec 6.4).
export const MAX_COLUMNS_PER_TABLE = 2048;
export const MAX_NAME_LENGTH = 127;
export const MAX_ROWS_PER_TABLE = 1_000_000;

export const WRITE_PATH = "/write/v4";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/qwp/constants.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/protocol/constants.ts test/qwp/constants.test.ts
git commit -m "feat(qwp): add protocol constants"
```

---

### Task 3: Table buffer — columnar accumulation

**Files:**
- Create: `src/qwp/protocol/tableBuffer.ts`
- Test: `test/qwp/tableBuffer.test.ts`

**Interfaces:**
- Consumes: `constants.ts`.
- Produces: `class QwpTableBuffer` with `constructor(name: string)`, `getOrCreateColumn(name: string, type: number): ColumnBuffer | null`, `nextRow(): void`, `reset(): void`, `get rowCount(): number`, `get columns(): ColumnBuffer[]`, `get name(): string`. `interface ColumnBuffer { name: string; type: number; values: (number | bigint | string)[]; nulls: boolean[]; size: number; }`

Implements spec 6.5.3: type locked on first sight, duplicate column in a row is first-value-wins, `nextRow()` back-fills nulls so all columns stay equal length.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/tableBuffer.test.ts
import { describe, it, expect } from "vitest";
import { QwpTableBuffer } from "../../src/qwp/protocol/tableBuffer";
import { TYPE_LONG, TYPE_DOUBLE } from "../../src/qwp/protocol/constants";

describe("QwpTableBuffer", () => {
  it("back-fills nulls so all columns stay equal length", () => {
    const t = new QwpTableBuffer("trades");
    t.getOrCreateColumn("a", TYPE_LONG)!.values.push(1);
    t.nextRow();
    t.getOrCreateColumn("b", TYPE_DOUBLE)!.values.push(2.5);
    t.nextRow();
    expect(t.rowCount).toBe(2);
    for (const c of t.columns) expect(c.size).toBe(2);
    // "a" is null in row 1, "b" is null in row 0
    expect(t.columns.find((c) => c.name === "a")!.nulls).toEqual([false, true]);
    expect(t.columns.find((c) => c.name === "b")!.nulls).toEqual([true, false]);
  });

  it("locks a column's type on first sight", () => {
    const t = new QwpTableBuffer("x");
    t.getOrCreateColumn("c", TYPE_LONG);
    expect(() => t.getOrCreateColumn("c", TYPE_DOUBLE)).toThrow(/type mismatch/i);
  });

  it("ignores a duplicate column within one row (first value wins)", () => {
    const t = new QwpTableBuffer("x");
    t.getOrCreateColumn("c", TYPE_LONG)!.values.push(1);
    expect(t.getOrCreateColumn("c", TYPE_LONG)).toBeNull();
  });

  it("rejects an empty column name", () => {
    const t = new QwpTableBuffer("x");
    expect(() => t.getOrCreateColumn("", TYPE_LONG)).toThrow(/empty/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/tableBuffer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/qwp/protocol/tableBuffer.ts
import { MAX_COLUMNS_PER_TABLE, MAX_NAME_LENGTH } from "./constants";

export interface ColumnBuffer {
  name: string;
  type: number;
  /** Non-null values only — the wire is compacted (spec 6.2.1). */
  values: (number | bigint | string)[];
  /** One entry per row; true means NULL. */
  nulls: boolean[];
  /** Rows accounted for so far, including nulls. */
  size: number;
}

export class QwpTableBuffer {
  readonly name: string;
  private readonly cols: ColumnBuffer[] = [];
  private readonly byName = new Map<string, ColumnBuffer>();
  private rows = 0;

  constructor(name: string) {
    if (!name) throw new Error("table name cannot be empty");
    if (Buffer.byteLength(name, "utf8") > MAX_NAME_LENGTH) {
      throw new Error(`table name too long [maxLength=${MAX_NAME_LENGTH}]`);
    }
    this.name = name;
  }

  get rowCount(): number {
    return this.rows;
  }

  get columns(): ColumnBuffer[] {
    return this.cols;
  }

  /** Returns null when the column already holds a value for the in-progress row. */
  getOrCreateColumn(name: string, type: number): ColumnBuffer | null {
    if (!name) throw new Error("column name cannot be empty");
    const existing = this.byName.get(name);
    if (existing) {
      if (existing.type !== type) {
        throw new Error(
          `Column type mismatch for column '${name}': columnType=${existing.type}, sentType=${type}`,
        );
      }
      // Already has a value for this row -> first value wins, silently.
      if (existing.size > this.rows) return null;
      existing.nulls.push(false);
      existing.size++;
      return existing;
    }
    if (Buffer.byteLength(name, "utf8") > MAX_NAME_LENGTH) {
      throw new Error(`column name too long [maxLength=${MAX_NAME_LENGTH}]`);
    }
    if (this.cols.length >= MAX_COLUMNS_PER_TABLE) {
      throw new Error(
        `column count exceeds maximum: ${this.cols.length + 1} (max ${MAX_COLUMNS_PER_TABLE})`,
      );
    }
    // Back-fill this column as null for every row already closed.
    const col: ColumnBuffer = {
      name,
      type,
      values: [],
      nulls: new Array(this.rows).fill(true),
      size: this.rows,
    };
    col.nulls.push(false);
    col.size++;
    this.cols.push(col);
    this.byName.set(name, col);
    return col;
  }

  /** Closes the row, back-filling a null into every column that was not set. */
  nextRow(): void {
    this.rows++;
    for (const c of this.cols) {
      while (c.size < this.rows) {
        c.nulls.push(true);
        c.size++;
      }
    }
  }

  reset(): void {
    this.cols.length = 0;
    this.byName.clear();
    this.rows = 0;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/qwp/tableBuffer.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/protocol/tableBuffer.ts test/qwp/tableBuffer.test.ts
git commit -m "feat(qwp): add columnar table buffer with null back-fill"
```

---

### Task 4: Frame encoder — header, schema, four column types

**Files:**
- Create: `src/qwp/protocol/frameEncoder.ts`
- Test: `test/qwp/frameEncoder.test.ts`

**Interfaces:**
- Consumes: `constants.ts`, `varint.ts`, `tableBuffer.ts`.
- Produces: `encodeFrame(tables: QwpTableBuffer[]): Buffer`.

Layout per spec 6.1/6.2: 12-byte header, then per table `[varint nameLen][utf8][varint rowCount][varint colCount]`, schema `[varint nameLen][utf8][typeCode]`, then per column `[nullHeader:u8]` + optional bitmap + **compacted** values.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/frameEncoder.test.ts
import { describe, it, expect } from "vitest";
import { encodeFrame } from "../../src/qwp/protocol/frameEncoder";
import { QwpTableBuffer } from "../../src/qwp/protocol/tableBuffer";
import { TYPE_LONG, HEADER_SIZE } from "../../src/qwp/protocol/constants";

describe("encodeFrame", () => {
  it("writes a valid 12-byte header", () => {
    const t = new QwpTableBuffer("t");
    t.getOrCreateColumn("a", TYPE_LONG)!.values.push(7);
    t.nextRow();
    const f = encodeFrame([t]);
    expect(f.subarray(0, 4).toString("ascii")).toBe("QWP1");
    expect(f.readUInt8(4)).toBe(1); // version
    expect(f.readUInt8(5)).toBe(0); // flags: none in this plan
    expect(f.readUInt16LE(6)).toBe(1); // tableCount
    expect(f.readUInt32LE(8)).toBe(f.length - HEADER_SIZE); // payloadLen excludes header
  });

  it("emits nullHeader 0 and compacted values when there are no nulls", () => {
    const t = new QwpTableBuffer("t");
    t.getOrCreateColumn("a", TYPE_LONG)!.values.push(1);
    t.nextRow();
    t.getOrCreateColumn("a", TYPE_LONG)!.values.push(2);
    t.nextRow();
    const f = encodeFrame([t]);
    // ...header, table name "t", rowCount 2, colCount 1, schema "a"+type, then column
    // nullHeader is the byte immediately after the schema entry.
    const idx = f.indexOf(TYPE_LONG, HEADER_SIZE);
    expect(f.readUInt8(idx + 1)).toBe(0); // nullHeader = no nulls
    expect(f.readBigInt64LE(idx + 2)).toBe(1n);
    expect(f.readBigInt64LE(idx + 10)).toBe(2n);
  });

  it("emits nullHeader 1, an LSB-first bitmap, and only non-null values", () => {
    const t = new QwpTableBuffer("t");
    t.getOrCreateColumn("a", TYPE_LONG)!.values.push(1);
    t.nextRow();
    t.nextRow(); // row 1: "a" not set -> null
    const f = encodeFrame([t]);
    const idx = f.indexOf(TYPE_LONG, HEADER_SIZE);
    expect(f.readUInt8(idx + 1)).toBe(1); // bitmap present
    expect(f.readUInt8(idx + 2)).toBe(0b00000010); // bit 1 set -> row 1 is NULL
    expect(f.readBigInt64LE(idx + 3)).toBe(1n); // only ONE value, not two
    expect(f.length).toBe(idx + 3 + 8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/frameEncoder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/qwp/protocol/frameEncoder.ts
import { Buffer } from "node:buffer";
import { writeVarint, varintSize } from "./varint";
import { QwpTableBuffer, ColumnBuffer } from "./tableBuffer";
import {
  HEADER_SIZE,
  QWP_MAGIC,
  QWP_VERSION,
  TYPE_DOUBLE,
  TYPE_LONG,
  TYPE_SYMBOL,
  TYPE_TIMESTAMP,
} from "./constants";

function utf8Size(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** varint length + utf8 bytes (spec 6.0 "string"). */
function writeString(buf: Buffer, offset: number, s: string): number {
  const n = utf8Size(s);
  let o = writeVarint(buf, offset, n);
  buf.write(s, o, "utf8");
  return o + n;
}

function stringSize(s: string): number {
  const n = utf8Size(s);
  return varintSize(n) + n;
}

function columnPayloadSize(col: ColumnBuffer, rowCount: number): number {
  const nullCount = col.nulls.filter(Boolean).length;
  let n = 1; // nullHeader
  if (nullCount > 0) n += Math.ceil(rowCount / 8);
  const v = col.values.length;
  switch (col.type) {
    case TYPE_LONG:
    case TYPE_DOUBLE:
    case TYPE_TIMESTAMP:
      return n + v * 8;
    case TYPE_SYMBOL: {
      // Inline dictionary: varint dictSize, entries, then a varint index per value.
      const dict = [...new Set(col.values as string[])];
      n += varintSize(dict.length);
      for (const s of dict) n += stringSize(s);
      for (const s of col.values as string[]) n += varintSize(dict.indexOf(s));
      return n;
    }
    default:
      throw new Error(`unsupported QWP column type: 0x${col.type.toString(16)}`);
  }
}

function writeColumn(
  buf: Buffer,
  offset: number,
  col: ColumnBuffer,
  rowCount: number,
): number {
  let o = offset;
  const nullCount = col.nulls.filter(Boolean).length;
  if (nullCount > 0) {
    buf[o++] = 1;
    const bytes = Math.ceil(rowCount / 8);
    buf.fill(0, o, o + bytes);
    for (let i = 0; i < rowCount; i++) {
      // bit i set means row i is NULL, LSB-first within each byte (spec 6.2.1)
      if (col.nulls[i]) buf[o + (i >>> 3)] |= 1 << (i & 7);
    }
    o += bytes;
  } else {
    buf[o++] = 0;
  }

  switch (col.type) {
    case TYPE_LONG:
    case TYPE_TIMESTAMP:
      for (const v of col.values) {
        buf.writeBigInt64LE(BigInt(v as number | bigint), o);
        o += 8;
      }
      return o;
    case TYPE_DOUBLE:
      for (const v of col.values) {
        buf.writeDoubleLE(v as number, o);
        o += 8;
      }
      return o;
    case TYPE_SYMBOL: {
      const dict = [...new Set(col.values as string[])];
      o = writeVarint(buf, o, dict.length);
      for (const s of dict) o = writeString(buf, o, s);
      for (const s of col.values as string[]) o = writeVarint(buf, o, dict.indexOf(s));
      return o;
    }
    default:
      throw new Error(`unsupported QWP column type: 0x${col.type.toString(16)}`);
  }
}

function tableSize(t: QwpTableBuffer): number {
  let n = stringSize(t.name) + varintSize(t.rowCount) + varintSize(t.columns.length);
  for (const c of t.columns) n += stringSize(c.name) + 1;
  for (const c of t.columns) n += columnPayloadSize(c, t.rowCount);
  return n;
}

/** Encodes one QWP v1 message. No flags are set in this plan (spec 6.1). */
export function encodeFrame(tables: QwpTableBuffer[]): Buffer {
  const payloadLen = tables.reduce((a, t) => a + tableSize(t), 0);
  const buf = Buffer.allocUnsafe(HEADER_SIZE + payloadLen);

  QWP_MAGIC.copy(buf, 0);
  buf.writeUInt8(QWP_VERSION, 4);
  buf.writeUInt8(0, 5); // flags
  buf.writeUInt16LE(tables.length, 6);
  buf.writeUInt32LE(payloadLen, 8);

  let o = HEADER_SIZE;
  for (const t of tables) {
    o = writeString(buf, o, t.name);
    o = writeVarint(buf, o, t.rowCount);
    o = writeVarint(buf, o, t.columns.length);
    for (const c of t.columns) {
      o = writeString(buf, o, c.name);
      buf.writeUInt8(c.type, o++);
    }
    for (const c of t.columns) o = writeColumn(buf, o, c, t.rowCount);
  }
  if (o !== buf.length) {
    throw new Error(`frame size mismatch: wrote ${o}, sized ${buf.length}`);
  }
  return buf;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/qwp/frameEncoder.test.ts`
Expected: PASS, 3 tests. The `o !== buf.length` assertion catches any size/write divergence immediately.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/protocol/frameEncoder.ts test/qwp/frameEncoder.test.ts
git commit -m "feat(qwp): encode QWP v1 frames with null bitmaps and compacted values"
```

---

### Task 5: WebSocket masking

**Files:**
- Create: `src/qwp/ws/mask.ts`
- Test: `test/qwp/ws.mask.test.ts`

**Interfaces:**
- Produces: `newMaskKey(): Buffer` (4 bytes from the OS CSPRNG), `applyMask(payload: Buffer, key: Buffer): void` (in place).

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/ws.mask.test.ts
import { describe, it, expect } from "vitest";
import { newMaskKey, applyMask } from "../../src/qwp/ws/mask";

describe("ws masking", () => {
  it("produces a fresh 4-byte key per call", () => {
    const a = newMaskKey();
    const b = newMaskKey();
    expect(a.length).toBe(4);
    // Not a strong randomness test; catches a constant/seeded-once key.
    const keys = new Set([a.toString("hex"), b.toString("hex")]);
    for (let i = 0; i < 20; i++) keys.add(newMaskKey().toString("hex"));
    expect(keys.size).toBeGreaterThan(1);
  });

  it("is its own inverse", () => {
    const key = Buffer.from([1, 2, 3, 4]);
    const original = Buffer.from("hello websocket", "utf8");
    const payload = Buffer.from(original);
    applyMask(payload, key);
    expect(payload.equals(original)).toBe(false);
    applyMask(payload, key);
    expect(payload.equals(original)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/ws.mask.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/qwp/ws/mask.ts
import { Buffer } from "node:buffer";
import { randomFillSync } from "node:crypto";

/** RFC 6455 §10.3 requires a fresh, unpredictable key per frame. */
export function newMaskKey(): Buffer {
  return randomFillSync(Buffer.allocUnsafe(4));
}

export function applyMask(payload: Buffer, key: Buffer): void {
  for (let i = 0; i < payload.length; i++) {
    payload[i] ^= key[i & 3];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/qwp/ws.mask.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/ws/mask.ts test/qwp/ws.mask.test.ts
git commit -m "feat(qwp): add per-frame websocket masking"
```

---

### Task 6: WebSocket frame codec

**Files:**
- Create: `src/qwp/ws/frame.ts`
- Test: `test/qwp/ws.frame.test.ts`

**Interfaces:**
- Consumes: `mask.ts`.
- Produces: `OPCODE = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }`, `encodeClientFrame(opcode: number, payload: Buffer): Buffer`, `class FrameParser` with `push(chunk: Buffer): void` and `next(): { opcode: number; payload: Buffer } | null`.

`FrameParser` implements spec 3.2.2: incremental across chunks, **defragments inbound continuation frames**, rejects masked inbound frames, rejects non-zero RSV, caps control payloads at 125.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/ws.frame.test.ts
import { describe, it, expect } from "vitest";
import { encodeClientFrame, FrameParser, OPCODE } from "../../src/qwp/ws/frame";

/** Server->client frames are never masked (RFC 6455). */
function serverFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const head: number[] = [(fin ? 0x80 : 0) | opcode];
  if (payload.length < 126) head.push(payload.length);
  else if (payload.length < 65536) head.push(126, payload.length >>> 8, payload.length & 0xff);
  else throw new Error("test helper: use a small payload");
  return Buffer.concat([Buffer.from(head), payload]);
}

describe("ws frame codec", () => {
  it("encodes a masked client binary frame", () => {
    const f = encodeClientFrame(OPCODE.BINARY, Buffer.from([1, 2, 3]));
    expect(f[0]).toBe(0x82); // FIN + binary
    expect(f[1] & 0x80).toBe(0x80); // mask bit set
    expect(f[1] & 0x7f).toBe(3);
    expect(f.length).toBe(2 + 4 + 3);
  });

  it("uses the 64-bit length form above 65535", () => {
    const f = encodeClientFrame(OPCODE.BINARY, Buffer.alloc(70000));
    expect(f[1] & 0x7f).toBe(127);
    expect(Number(f.readBigUInt64BE(2))).toBe(70000);
  });

  it("parses a frame split across chunks", () => {
    const whole = serverFrame(OPCODE.BINARY, Buffer.from("abcd"));
    const p = new FrameParser();
    p.push(whole.subarray(0, 3));
    expect(p.next()).toBeNull();
    p.push(whole.subarray(3));
    expect(p.next()!.payload.toString()).toBe("abcd");
  });

  it("defragments continuation frames", () => {
    const p = new FrameParser();
    p.push(serverFrame(OPCODE.BINARY, Buffer.from("ab"), false));
    expect(p.next()).toBeNull();
    p.push(serverFrame(OPCODE.CONT, Buffer.from("cd"), true));
    const msg = p.next()!;
    expect(msg.opcode).toBe(OPCODE.BINARY);
    expect(msg.payload.toString()).toBe("abcd");
  });

  it("rejects a masked inbound frame", () => {
    const f = serverFrame(OPCODE.BINARY, Buffer.from("x"));
    f[1] |= 0x80; // claim masked
    const p = new FrameParser();
    p.push(f);
    expect(() => p.next()).toThrow(/masked/i);
  });

  it("rejects non-zero RSV bits", () => {
    const f = serverFrame(OPCODE.BINARY, Buffer.from("x"));
    f[0] |= 0x40;
    const p = new FrameParser();
    p.push(f);
    expect(() => p.next()).toThrow(/rsv/i);
  });

  it("rejects an oversized control frame", () => {
    const f = serverFrame(OPCODE.PING, Buffer.alloc(126));
    const p = new FrameParser();
    p.push(f);
    expect(() => p.next()).toThrow(/control frame/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/ws.frame.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/qwp/ws/frame.ts
import { Buffer } from "node:buffer";
import { newMaskKey, applyMask } from "./mask";

export const OPCODE = {
  CONT: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

const MAX_CONTROL_PAYLOAD = 125;

/** Client->server frames are always FIN=1 and always masked (spec 3.2.1). */
export function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let headerLen = 2;
  if (len >= 65536) headerLen += 8;
  else if (len >= 126) headerLen += 2;

  const out = Buffer.allocUnsafe(headerLen + 4 + len);
  out[0] = 0x80 | opcode;
  if (len < 126) {
    out[1] = 0x80 | len;
  } else if (len < 65536) {
    out[1] = 0x80 | 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = 0x80 | 127;
    out.writeBigUInt64BE(BigInt(len), 2);
  }
  const key = newMaskKey();
  key.copy(out, headerLen);
  payload.copy(out, headerLen + 4);
  applyMask(out.subarray(headerLen + 4), key);
  return out;
}

export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);
  private fragOpcode = -1;
  private frags: Buffer[] = [];

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
  }

  /** Returns the next complete message, or null when more bytes are needed. */
  next(): { opcode: number; payload: Buffer } | null {
    for (;;) {
      if (this.buf.length < 2) return null;
      const b0 = this.buf[0];
      const b1 = this.buf[1];

      if ((b0 & 0x70) !== 0) throw new Error("websocket: non-zero RSV bits");
      if ((b1 & 0x80) !== 0) throw new Error("websocket: inbound frame must not be masked");

      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const isControl = (opcode & 0x08) !== 0;

      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return null;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return null;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("websocket: frame too large");
        len = Number(big);
        offset = 10;
      }

      if (isControl) {
        if (len > MAX_CONTROL_PAYLOAD) {
          throw new Error(`websocket: control frame payload exceeds ${MAX_CONTROL_PAYLOAD}`);
        }
        if (!fin) throw new Error("websocket: control frame must not be fragmented");
      }

      if (this.buf.length < offset + len) return null;
      const payload = Buffer.from(this.buf.subarray(offset, offset + len));
      this.buf = this.buf.subarray(offset + len);

      // Control frames are never fragmented and interleave freely.
      if (isControl) return { opcode, payload };

      if (opcode === OPCODE.CONT) {
        if (this.fragOpcode === -1) throw new Error("websocket: continuation without start");
        this.frags.push(payload);
        if (!fin) continue;
        const full = Buffer.concat(this.frags);
        const op = this.fragOpcode;
        this.frags = [];
        this.fragOpcode = -1;
        return { opcode: op, payload: full };
      }

      if (!fin) {
        this.fragOpcode = opcode;
        this.frags = [payload];
        continue;
      }
      return { opcode, payload };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/qwp/ws.frame.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/ws/frame.ts test/qwp/ws.frame.test.ts
git commit -m "feat(qwp): add RFC 6455 frame codec with inbound defragmentation"
```

---

### Task 7: Handshake — request, accept validation, failure classification

**Files:**
- Create: `src/qwp/ws/handshake.ts`
- Test: `test/qwp/ws.handshake.test.ts`

**Interfaces:**
- Consumes: `constants.ts`.
- Produces: `buildUpgradeRequest(opts): { request: Buffer; key: string }`, `computeAccept(key: string): string`, `parseUpgradeResponse(raw: Buffer): UpgradeResult`, `class QwpUpgradeError extends Error { status: number; kind: "role-reject" | "auth" | "other" }`.

Implements spec 6.5 and 6.5.1: `421`+`X-QuestDB-Role` is a **retriable** role reject; `401`/`403` is a **terminal** auth failure; everything else (including `404`) is unclassified.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/ws.handshake.test.ts
import { describe, it, expect } from "vitest";
import {
  buildUpgradeRequest,
  computeAccept,
  parseUpgradeResponse,
  QwpUpgradeError,
} from "../../src/qwp/ws/handshake";

describe("qwp handshake", () => {
  it("computes Sec-WebSocket-Accept per RFC 6455", () => {
    // The canonical example from RFC 6455 §1.3.
    expect(computeAccept("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("builds an upgrade request with the QWP headers", () => {
    const { request } = buildUpgradeRequest({ host: "h", port: 9000, clientId: "nodejs/1.0.0" });
    const s = request.toString("ascii");
    expect(s).toMatch(/^GET \/write\/v4 HTTP\/1\.1\r\n/);
    expect(s).toMatch(/\r\nUpgrade: websocket\r\n/);
    expect(s).toMatch(/\r\nSec-WebSocket-Version: 13\r\n/);
    expect(s).toMatch(/\r\nX-QWP-Max-Version: 1\r\n/);
    expect(s).toMatch(/\r\nX-QWP-Client-Id: nodejs\/1\.0\.0\r\n/);
    expect(s.endsWith("\r\n\r\n")).toBe(true);
  });

  it("classifies 421 with a role header as a retriable role reject", () => {
    const raw = Buffer.from(
      "HTTP/1.1 421 Misdirected Request\r\nX-QuestDB-Role: replica\r\n\r\n",
      "ascii",
    );
    try {
      parseUpgradeResponse(raw);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(QwpUpgradeError);
      expect((e as QwpUpgradeError).kind).toBe("role-reject");
      expect((e as QwpUpgradeError).retriable).toBe(true);
    }
  });

  it("classifies 401 as a terminal auth failure", () => {
    const raw = Buffer.from("HTTP/1.1 401 Unauthorized\r\n\r\n", "ascii");
    try {
      parseUpgradeResponse(raw);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as QwpUpgradeError).kind).toBe("auth");
      expect((e as QwpUpgradeError).retriable).toBe(false);
    }
  });

  it("leaves 404 unclassified", () => {
    const raw = Buffer.from("HTTP/1.1 404 Not Found\r\n\r\n", "ascii");
    try {
      parseUpgradeResponse(raw);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as QwpUpgradeError).kind).toBe("other");
    }
  });

  it("returns negotiated headers on 101", () => {
    const raw = Buffer.from(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n" +
        "X-QWP-Version: 1\r\nX-QWP-Max-Batch-Size: 1048576\r\n\r\n",
      "ascii",
    );
    const r = parseUpgradeResponse(raw);
    expect(r.accept).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    expect(r.qwpVersion).toBe(1);
    expect(r.maxBatchSize).toBe(1048576);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/ws.handshake.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/qwp/ws/handshake.ts
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { WRITE_PATH } from "../protocol/constants";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export type UpgradeFailureKind = "role-reject" | "auth" | "other";

export class QwpUpgradeError extends Error {
  readonly status: number;
  readonly kind: UpgradeFailureKind;
  /** 421 role rejects retry indefinitely; auth failures never do (spec 6.5.1). */
  readonly retriable: boolean;
  readonly role?: string;

  constructor(status: number, kind: UpgradeFailureKind, message: string, role?: string) {
    super(message);
    this.name = "QwpUpgradeError";
    this.status = status;
    this.kind = kind;
    this.retriable = kind === "role-reject";
    this.role = role;
  }
}

export interface UpgradeResult {
  accept: string;
  qwpVersion?: number;
  maxBatchSize?: number;
  role?: string;
  /** Bytes already received after the header terminator. */
  leftover: Buffer;
}

export function computeAccept(key: string): string {
  return createHash("sha1").update(key + WS_GUID, "ascii").digest("base64");
}

export function buildUpgradeRequest(opts: {
  host: string;
  port: number;
  clientId: string;
  authorization?: string;
}): { request: Buffer; key: string } {
  const key = randomBytes(16).toString("base64");
  const lines = [
    `GET ${WRITE_PATH} HTTP/1.1`,
    `Host: ${opts.host}:${opts.port}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${key}`,
    "X-QWP-Max-Version: 1",
    `X-QWP-Client-Id: ${opts.clientId}`,
  ];
  if (opts.authorization) lines.push(`Authorization: ${opts.authorization}`);
  return { request: Buffer.from(lines.join("\r\n") + "\r\n\r\n", "ascii"), key };
}

export function parseUpgradeResponse(raw: Buffer): UpgradeResult {
  const end = raw.indexOf("\r\n\r\n");
  if (end < 0) throw new Error("incomplete HTTP upgrade response");
  const head = raw.subarray(0, end).toString("ascii");
  const leftover = Buffer.from(raw.subarray(end + 4));

  const [statusLine, ...headerLines] = head.split("\r\n");
  const status = Number.parseInt(statusLine.split(" ")[1], 10);

  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }

  if (status !== 101) {
    const role = headers.get("x-questdb-role");
    if (status === 421 && role) {
      throw new QwpUpgradeError(status, "role-reject", `node cannot accept writes [role=${role}]`, role);
    }
    if (status === 401 || status === 403) {
      throw new QwpUpgradeError(status, "auth", `authentication failed [status=${status}]`);
    }
    throw new QwpUpgradeError(status, "other", `websocket upgrade failed [status=${status}]`);
  }

  const accept = headers.get("sec-websocket-accept");
  if (!accept) throw new Error("upgrade response missing Sec-WebSocket-Accept");

  const version = headers.get("x-qwp-version");
  const cap = headers.get("x-qwp-max-batch-size");
  return {
    accept,
    qwpVersion: version ? Number.parseInt(version, 10) : undefined,
    maxBatchSize: cap ? Number.parseInt(cap, 10) : undefined,
    role: headers.get("x-questdb-role"),
    leftover,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/qwp/ws.handshake.test.ts`
Expected: PASS, 6 tests. The `computeAccept` test uses RFC 6455's own worked example, so it validates against the standard rather than against our own output.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/ws/handshake.ts test/qwp/ws.handshake.test.ts
git commit -m "feat(qwp): add websocket handshake and upgrade-failure classification"
```

---

### Task 8: WebSocket socket — connect and send

**Files:**
- Create: `src/qwp/ws/socket.ts`
- Test: `test/qwp/ws.socket.test.ts`

**Interfaces:**
- Consumes: `frame.ts`, `handshake.ts`.
- Produces: `class QwpWebSocket` with `static connect(opts): Promise<QwpWebSocket>`, `sendBinary(payload: Buffer): Promise<void>`, `close(): Promise<void>`, `get maxBatchSize(): number | undefined`.

Handles PING→PONG and CLOSE→echo (spec 3.2.1). Writes each data frame in a **single** `socket.write()` so a control frame can never interleave mid-frame.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/ws.socket.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, Server } from "node:net";
import { createHash } from "node:crypto";
import { QwpWebSocket } from "../../src/qwp/ws/socket";
import { FrameParser, encodeClientFrame, OPCODE } from "../../src/qwp/ws/frame";

let server: Server | undefined;
afterEach(() => server?.close());

/** Minimal QWP-ish websocket server: completes the upgrade, echoes nothing. */
function startServer(onBinary: (b: Buffer) => void): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((sock) => {
      let handshaken = false;
      const parser = new FrameParser();
      sock.on("data", (chunk) => {
        if (!handshaken) {
          const text = chunk.toString("ascii");
          const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(text)![1];
          const accept = createHash("sha1")
            .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", "ascii")
            .digest("base64");
          sock.write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
              `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n` +
              "X-QWP-Version: 1\r\nX-QWP-Max-Batch-Size: 1048576\r\n\r\n",
          );
          handshaken = true;
          return;
        }
        parser.push(chunk);
        for (let m = parser.next(); m; m = parser.next()) {
          if (m.opcode === OPCODE.BINARY) onBinary(m.payload);
          if (m.opcode === OPCODE.PING) sock.write(encodeClientFrame(OPCODE.PONG, m.payload));
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve((server!.address() as any).port));
  });
}

describe("QwpWebSocket", () => {
  it("connects, negotiates, and sends a binary frame", async () => {
    const received: Buffer[] = [];
    const port = await startServer((b) => received.push(b));
    const ws = await QwpWebSocket.connect({
      host: "127.0.0.1",
      port,
      tls: false,
      clientId: "nodejs/1.0.0",
    });
    expect(ws.maxBatchSize).toBe(1048576);
    await ws.sendBinary(Buffer.from("payload"));
    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBe(1);
    expect(received[0].toString()).toBe("payload");
    await ws.close();
  });

  it("rejects a bad Sec-WebSocket-Accept", async () => {
    server = createServer((sock) => {
      sock.on("data", () =>
        sock.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
            "Connection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n",
        ),
      );
    });
    const port: number = await new Promise((r) =>
      server!.listen(0, "127.0.0.1", () => r((server!.address() as any).port)),
    );
    await expect(
      QwpWebSocket.connect({ host: "127.0.0.1", port, tls: false, clientId: "x" }),
    ).rejects.toThrow(/accept/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/ws.socket.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/qwp/ws/socket.ts
import { Buffer } from "node:buffer";
import { connect as netConnect, Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { encodeClientFrame, FrameParser, OPCODE } from "./frame";
import { buildUpgradeRequest, computeAccept, parseUpgradeResponse } from "./handshake";

export interface QwpWebSocketOptions {
  host: string;
  port: number;
  tls: boolean;
  clientId: string;
  authorization?: string;
  rejectUnauthorized?: boolean;
  ca?: Buffer | Buffer[];
}

export class QwpWebSocket {
  private readonly socket: Socket;
  private readonly parser = new FrameParser();
  private closed = false;
  readonly maxBatchSize?: number;

  private constructor(socket: Socket, maxBatchSize?: number) {
    this.socket = socket;
    this.maxBatchSize = maxBatchSize;
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  static connect(opts: QwpWebSocketOptions): Promise<QwpWebSocket> {
    return new Promise((resolve, reject) => {
      const socket: Socket = opts.tls
        ? tlsConnect({
            host: opts.host,
            port: opts.port,
            rejectUnauthorized: opts.rejectUnauthorized !== false,
            ca: opts.ca,
          })
        : netConnect({ host: opts.host, port: opts.port });

      const onError = (e: Error) => reject(e);
      socket.once("error", onError);

      socket.once(opts.tls ? "secureConnect" : "connect", () => {
        const { request, key } = buildUpgradeRequest(opts);
        socket.write(request);

        let acc = Buffer.alloc(0);
        const onHeaderData = (chunk: Buffer) => {
          acc = Buffer.concat([acc, chunk]);
          if (acc.indexOf("\r\n\r\n") < 0) return;
          socket.off("data", onHeaderData);
          socket.off("error", onError);
          try {
            const res = parseUpgradeResponse(acc);
            if (res.accept !== computeAccept(key)) {
              throw new Error("websocket: Sec-WebSocket-Accept mismatch");
            }
            const ws = new QwpWebSocket(socket, res.maxBatchSize);
            if (res.leftover.length > 0) ws.onData(res.leftover);
            resolve(ws);
          } catch (e) {
            socket.destroy();
            reject(e);
          }
        };
        socket.on("data", onHeaderData);
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.parser.push(chunk);
    for (let m = this.parser.next(); m; m = this.parser.next()) {
      switch (m.opcode) {
        case OPCODE.PING:
          this.socket.write(encodeClientFrame(OPCODE.PONG, m.payload));
          break;
        case OPCODE.CLOSE:
          // RFC 6455 §5.5.1: echo the close before tearing down.
          if (!this.closed) {
            this.closed = true;
            this.socket.write(encodeClientFrame(OPCODE.CLOSE, m.payload));
            this.socket.end();
          }
          break;
        default:
          // Response frames are decoded in a later plan (ACK handling).
          break;
      }
    }
  }

  /** One write per frame, so a control frame can never interleave mid-frame. */
  sendBinary(payload: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("websocket is closed"));
      const frame = encodeClientFrame(OPCODE.BINARY, payload);
      this.socket.write(frame, (err) => (err ? reject(err) : resolve()));
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.closed) return resolve();
      this.closed = true;
      this.socket.write(encodeClientFrame(OPCODE.CLOSE, Buffer.alloc(0)));
      this.socket.end(() => resolve());
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/qwp/ws.socket.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/ws/socket.ts test/qwp/ws.socket.test.ts
git commit -m "feat(qwp): add websocket transport socket with control-frame handling"
```

---

### Task 9: `QwpBuffer` implementing `SenderBuffer`

**Files:**
- Create: `src/qwp/buffer.ts`
- Test: `test/qwp/buffer.test.ts`

**Interfaces:**
- Consumes: `tableBuffer.ts`, `frameEncoder.ts`, `constants.ts`.
- Produces: `class QwpBuffer implements SenderBuffer`.

Unsupported column types throw explicitly rather than silently producing wrong bytes. `toBufferNew()` seals one frame across all dirty tables.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/buffer.test.ts
import { describe, it, expect } from "vitest";
import { QwpBuffer } from "../../src/qwp/buffer";
import { HEADER_SIZE } from "../../src/qwp/protocol/constants";

describe("QwpBuffer", () => {
  it("seals a frame containing the buffered rows", () => {
    const b = new QwpBuffer();
    b.table("trades").symbol("sym", "ETH").floatColumn("price", 1.5);
    b.at(1000n, "us");
    const f = b.toBufferNew()!;
    expect(f.subarray(0, 4).toString("ascii")).toBe("QWP1");
    expect(f.readUInt16LE(6)).toBe(1); // one table
    expect(f.length).toBeGreaterThan(HEADER_SIZE);
  });

  it("returns null when nothing is buffered", () => {
    expect(new QwpBuffer().toBufferNew()).toBeNull();
  });

  it("accumulates multiple tables into one frame", () => {
    const b = new QwpBuffer();
    b.table("a").intColumn("x", 1);
    b.at(1n, "us");
    b.table("b").intColumn("y", 2);
    b.at(2n, "us");
    expect(b.toBufferNew()!.readUInt16LE(6)).toBe(2);
  });

  it("throws for column types this plan does not encode", () => {
    const b = new QwpBuffer();
    b.table("t");
    expect(() => b.booleanColumn("flag", true)).toThrow(/not supported/i);
  });

  it("clears state after sealing", () => {
    const b = new QwpBuffer();
    b.table("t").intColumn("x", 1);
    b.at(1n, "us");
    b.toBufferNew();
    expect(b.toBufferNew()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/buffer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/qwp/buffer.ts
import { Buffer } from "node:buffer";
import { SenderBuffer } from "../buffer";
import { TimestampUnit } from "../utils";
import { QwpTableBuffer } from "./protocol/tableBuffer";
import { encodeFrame } from "./protocol/frameEncoder";
import { TYPE_DOUBLE, TYPE_LONG, TYPE_SYMBOL, TYPE_TIMESTAMP } from "./protocol/constants";

function toMicros(value: number | bigint, unit: TimestampUnit): bigint {
  const v = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  switch (unit) {
    case "ns":
      return v / 1000n;
    case "ms":
      return v * 1000n;
    default:
      return v;
  }
}

function unsupported(what: string): never {
  throw new Error(`${what} is not supported by the QWP buffer yet`);
}

export class QwpBuffer implements SenderBuffer {
  private tables: QwpTableBuffer[] = [];
  private byName = new Map<string, QwpTableBuffer>();
  private current?: QwpTableBuffer;
  private rows = 0;

  reset(): SenderBuffer {
    this.tables = [];
    this.byName = new Map();
    this.current = undefined;
    this.rows = 0;
    return this;
  }

  table(table: string): SenderBuffer {
    let t = this.byName.get(table);
    if (!t) {
      t = new QwpTableBuffer(table);
      this.byName.set(table, t);
      this.tables.push(t);
    }
    this.current = t;
    return this;
  }

  private require(): QwpTableBuffer {
    if (!this.current) throw new Error("table name must be set before adding columns");
    return this.current;
  }

  symbol(name: string, value: unknown): SenderBuffer {
    const col = this.require().getOrCreateColumn(name, TYPE_SYMBOL);
    if (col) col.values.push(String(value));
    return this;
  }

  intColumn(name: string, value: number): SenderBuffer {
    if (!Number.isInteger(value)) throw new Error(`value must be an integer, received ${value}`);
    const col = this.require().getOrCreateColumn(name, TYPE_LONG);
    if (col) col.values.push(BigInt(value));
    return this;
  }

  floatColumn(name: string, value: number): SenderBuffer {
    const col = this.require().getOrCreateColumn(name, TYPE_DOUBLE);
    if (col) col.values.push(value);
    return this;
  }

  timestampColumn(name: string, value: number | bigint, unit: TimestampUnit = "us"): SenderBuffer {
    const col = this.require().getOrCreateColumn(name, TYPE_TIMESTAMP);
    if (col) col.values.push(toMicros(value, unit));
    return this;
  }

  at(timestamp: number | bigint, unit: TimestampUnit = "us"): void {
    const t = this.require();
    const col = t.getOrCreateColumn("timestamp", TYPE_TIMESTAMP);
    if (col) col.values.push(toMicros(timestamp, unit));
    t.nextRow();
    this.rows++;
    this.current = undefined;
  }

  atNow(): void {
    const t = this.require();
    t.nextRow();
    this.rows++;
    this.current = undefined;
  }

  toBufferNew(): Buffer | null {
    const dirty = this.tables.filter((t) => t.rowCount > 0);
    if (dirty.length === 0) return null;
    const frame = encodeFrame(dirty);
    this.reset();
    return frame;
  }

  toBufferView(): Buffer {
    throw new Error("toBufferView is not supported by the QWP buffer");
  }

  currentPosition(): number {
    return this.rows;
  }

  // Column types arriving in a later plan — fail loudly rather than emit wrong bytes.
  stringColumn(): SenderBuffer {
    return unsupported("stringColumn");
  }
  booleanColumn(): SenderBuffer {
    return unsupported("booleanColumn");
  }
  arrayColumn(): SenderBuffer {
    return unsupported("arrayColumn");
  }
  decimalColumnText(): SenderBuffer {
    return unsupported("decimalColumnText");
  }
  decimalColumn(): SenderBuffer {
    return unsupported("decimalColumn");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/qwp/buffer.test.ts && npx tsc --noEmit`
Expected: PASS, 5 tests, and no type errors — `tsc` proves `QwpBuffer` satisfies `SenderBuffer`.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/buffer.ts test/qwp/buffer.test.ts
git commit -m "feat(qwp): add QwpBuffer implementing SenderBuffer"
```

---

### Task 10: `QwpTransport` implementing `SenderTransport`

**Files:**
- Create: `src/qwp/transport.ts`
- Test: `test/qwp/transport.test.ts`

**Interfaces:**
- Consumes: `ws/socket.ts`.
- Produces: `class QwpTransport implements SenderTransport`.

`getDefaultAutoFlushRows()` returns **1000** per spec 9.1 — not the ILP defaults.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/transport.test.ts
import { describe, it, expect } from "vitest";
import { QwpTransport } from "../../src/qwp/transport";
import { SenderOptions } from "../../src/options";

describe("QwpTransport", () => {
  it("uses the QWP auto-flush row default, not the ILP one", () => {
    const t = new QwpTransport(new SenderOptions("ws::addr=localhost:9000;"));
    expect(t.getDefaultAutoFlushRows()).toBe(1000);
  });

  it("refuses to send before connect", async () => {
    const t = new QwpTransport(new SenderOptions("ws::addr=localhost:9000;"));
    await expect(t.send(Buffer.from([1]))).rejects.toThrow(/not connected/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/transport.test.ts`
Expected: FAIL — module not found (and `ws::` not yet accepted by `SenderOptions`; Task 11 fixes that, so this test is expected to stay red until then. If it fails on the protocol rather than the module, proceed to Task 11 and re-run.)

- [ ] **Step 3: Write minimal implementation**

```ts
// src/qwp/transport.ts
import { Buffer } from "node:buffer";
import { SenderTransport } from "../transport";
import { SenderOptions } from "../options";
import { QwpWebSocket } from "./ws/socket";

const QWP_DEFAULT_AUTO_FLUSH_ROWS = 1000; // spec 9.1
const CLIENT_ID = "nodejs/1.0.0"; // protocol client version, not the package version (spec 6.5)

export class QwpTransport implements SenderTransport {
  private readonly options: SenderOptions;
  private ws?: QwpWebSocket;

  constructor(options: SenderOptions) {
    this.options = options;
  }

  async connect(): Promise<boolean> {
    const auth = this.options.username && this.options.password
      ? "Basic " +
        Buffer.from(`${this.options.username}:${this.options.password}`).toString("base64")
      : this.options.token
        ? `Bearer ${this.options.token}`
        : undefined;

    this.ws = await QwpWebSocket.connect({
      host: this.options.host!,
      port: this.options.port!,
      tls: this.options.protocol === "wss",
      clientId: CLIENT_ID,
      authorization: auth,
      rejectUnauthorized: this.options.tls_verify !== "unsafe_off",
    });
    return true;
  }

  async send(data: Buffer): Promise<boolean> {
    if (!this.ws) throw new Error("QWP transport is not connected");
    await this.ws.sendBinary(data);
    return true;
  }

  async close(): Promise<void> {
    await this.ws?.close();
    this.ws = undefined;
  }

  getDefaultAutoFlushRows(): number {
    return QWP_DEFAULT_AUTO_FLUSH_ROWS;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/qwp/transport.test.ts`
Expected: still failing on `ws::` protocol parsing until Task 11. That is expected; Task 11 ends with this test green.

- [ ] **Step 5: Commit**

```bash
git add src/qwp/transport.ts test/qwp/transport.test.ts
git commit -m "feat(qwp): add QwpTransport implementing SenderTransport"
```

---

### Task 11: Wire `ws://` into options, buffer and transport factories

**Files:**
- Modify: `src/options.ts` (4 sites), `src/buffer/index.ts`, `src/transport/index.ts`, `src/index.ts`
- Test: `test/qwp/options.test.ts`

**Interfaces:**
- Consumes: `QwpBuffer`, `QwpTransport`.
- Produces: `WS = "ws"`, `WSS = "wss"` exported from `src/options.ts`.

Implements spec 3.5. **The ordering hazard is the point of this task:** `createBuffer` must branch on `options.protocol` *before* its `protocol_version` switch, or a `ws::` sender silently gets `SenderBufferV1` and emits ILP text.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/options.test.ts
import { describe, it, expect } from "vitest";
import { SenderOptions } from "../../src/options";
import { createBuffer } from "../../src/buffer";
import { createTransport } from "../../src/transport";
import { QwpBuffer } from "../../src/qwp/buffer";
import { QwpTransport } from "../../src/qwp/transport";

describe("ws:// wiring", () => {
  it("accepts ws:: and defaults the port to 9000", () => {
    const o = new SenderOptions("ws::addr=localhost;");
    expect(o.protocol).toBe("ws");
    expect(o.port).toBe(9000);
  });

  it("accepts wss:: ", () => {
    expect(new SenderOptions("wss::addr=localhost;").protocol).toBe("wss");
  });

  it("gives a ws:: sender a QwpBuffer, never an ILP buffer", () => {
    const o = new SenderOptions("ws::addr=localhost:9000;");
    expect(createBuffer(o)).toBeInstanceOf(QwpBuffer);
  });

  it("gives a ws:: sender a QwpTransport", () => {
    const o = new SenderOptions("ws::addr=localhost:9000;");
    expect(createTransport(o)).toBeInstanceOf(QwpTransport);
  });

  it("rejects protocol_version for ws:: (spec 9.2)", () => {
    expect(() => new SenderOptions("ws::addr=localhost:9000;protocol_version=2;")).toThrow(
      /not supported for WebSocket/i,
    );
  });

  it("still rejects a genuinely unknown protocol", () => {
    expect(() => new SenderOptions("wsx::addr=localhost;")).toThrow(/invalid protocol/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/options.test.ts`
Expected: FAIL — `Invalid protocol: 'ws'`.

- [ ] **Step 3: Apply the four edits**

In `src/options.ts`:

```ts
// (a) near the existing protocol constants
const WS = "ws";
const WSS = "wss";
```

```ts
// (b) in the protocol token switch inside the constructor
  switch (options.protocol) {
    case HTTP:
    case HTTPS:
    case TCP:
    case TCPS:
    case WS:
    case WSS:
      break;
    default:
      throw new Error(
        `Invalid protocol: '${options.protocol}', accepted protocols: 'http', 'https', 'tcp', 'tcps', 'ws', 'wss'`,
      );
  }
```

```ts
// (c) parseProtocolVersion — leave ws/wss unset, and reject an explicit value
function parseProtocolVersion(options: SenderOptions) {
  if (options.protocol === WS || options.protocol === WSS) {
    if (options.protocol_version !== undefined && options.protocol_version !== null) {
      throw new Error("protocol version is not supported for WebSocket protocol");
    }
    return; // stays undefined: createBuffer branches on protocol first
  }
  // ...existing body unchanged
}
```

```ts
// (d) parseAddress port defaulting
    switch (options.protocol) {
      case HTTP:
      case HTTPS:
      case WS:
      case WSS:
        options.port = HTTP_PORT; // QWP shares the HTTP port, 9000
        return;
      case TCP:
      case TCPS:
        options.port = TCP_PORT;
        return;
      default:
        throw new Error(
          `Invalid protocol: '${options.protocol}', accepted protocols: 'http', 'https', 'tcp', 'tcps', 'ws', 'wss'`,
        );
    }
```

Export them: add `WS, WSS` to the existing export list at the bottom of `src/options.ts`.

In `src/buffer/index.ts` — **protocol check first**:

```ts
import { SenderOptions, WS, WSS, /* ...existing */ } from "../options";
import { QwpBuffer } from "../qwp/buffer";

function createBuffer(options: SenderOptions): SenderBuffer {
  // QWP has no protocol_version; this MUST precede the version switch or a
  // ws:// sender silently receives SenderBufferV1 and emits ILP text.
  if (options.protocol === WS || options.protocol === WSS) {
    return new QwpBuffer();
  }
  switch (options.protocol_version) {
    // ...existing arms unchanged
  }
}
```

In `src/transport/index.ts`:

```ts
import { SenderOptions, HTTP, HTTPS, TCP, TCPS, WS, WSS } from "../options";
import { QwpTransport } from "../qwp/transport";

  switch (options.protocol) {
    case HTTP:
    case HTTPS:
      return options.stdlib_http ? new HttpTransport(options) : new UndiciTransport(options);
    case TCP:
    case TCPS:
      return new TcpTransport(options);
    case WS:
    case WSS:
      return new QwpTransport(options);
    default:
      throw new Error(`Invalid protocol: '${options.protocol}'`);
  }
```

In `src/index.ts`:

```ts
export { QwpBuffer } from "./qwp/buffer";
export { QwpTransport } from "./qwp/transport";
```

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run test/qwp/ && npx vitest run && npx tsc --noEmit && npx eslint src/**`
Expected: all `test/qwp/` green including Task 10's transport test, **all pre-existing tests still green**, no type errors, no lint errors. If `sender.config.test.ts` fails on an "accepted protocols" message, update that assertion to the new string — the spec predicted this at 3.5.

- [ ] **Step 5: Commit**

```bash
git add src/options.ts src/buffer/index.ts src/transport/index.ts src/index.ts test/qwp/options.test.ts
git commit -m "feat(qwp): route ws:// and wss:// to the QWP buffer and transport"
```

---

### Task 12: End-to-end against a real QuestDB

**Files:**
- Create: `test/qwp/integration.test.ts`

**Interfaces:**
- Consumes: everything above, via the public `Sender` API.

This is the gate the whole plan exists to reach: a real server accepts our bytes.

- [ ] **Step 1: Write the failing test**

```ts
// test/qwp/integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { Sender } from "../../src";

let container: StartedTestContainer;
let httpPort: number;

async function query(sql: string): Promise<any> {
  const res = await fetch(
    `http://${container.getHost()}:${httpPort}/exec?query=${encodeURIComponent(sql)}`,
  );
  return res.json();
}

describe("QWP ingest end-to-end", () => {
  beforeAll(async () => {
    // Matches the existing test/sender.integration.test.ts pattern: no wait
    // strategy, readiness is established by the polling loop below.
    container = await new GenericContainer("questdb/questdb:nightly")
      .withExposedPorts(9000)
      .start();
    httpPort = container.getMappedPort(9000);
  }, 180_000);

  afterAll(async () => await container?.stop());

  it("ingests rows over ws:// and they land with correct values", async () => {
    // fromConfig is async. Do NOT pass auto_flush=off: spec 9.2 records that
    // disabling auto-flush is rejected for WebSocket. The default triggers are
    // harmless here because we flush explicitly and then poll.
    const sender = await Sender.fromConfig(
      `ws::addr=${container.getHost()}:${httpPort};`,
    );
    await sender.connect();

    await sender
      .table("qwp_e2e")
      .symbol("sym", "ETH-USD")
      .floatColumn("price", 2615.54)
      .intColumn("qty", 7)
      .at(1_700_000_000_000_000n, "us");

    await sender.flush();
    await sender.close();

    // WAL apply is asynchronous — poll rather than sleeping a fixed interval.
    let rows: any[] = [];
    for (let i = 0; i < 60; i++) {
      const r = await query("select sym, price, qty from qwp_e2e");
      rows = r.dataset ?? [];
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    expect(rows.length).toBe(1);
    expect(rows[0][0]).toBe("ETH-USD");
    expect(rows[0][1]).toBeCloseTo(2615.54, 5);
    expect(rows[0][2]).toBe(7);
  }, 180_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/qwp/integration.test.ts`
Expected: FAIL. Confirm *why* before proceeding — a `Sender.connect()` error means wiring, a server NACK or dropped connection means the frame bytes are wrong. If the server closes without a response, dump the frame with `console.log(frame.toString("hex"))` in `QwpTransport.send` and compare against spec 6.2 by hand.

- [ ] **Step 3: Fix whatever the failure reveals**

No new code is planned here — Tasks 1–11 should already be sufficient. Expected failure modes and where to look:

| Symptom | Likely cause |
|---|---|
| Upgrade fails with 404 | `WRITE_PATH` wrong, or QWP ingress disabled in the image |
| Server closes immediately after the frame | header magic/version/flags wrong (Task 4) |
| Rows land with shifted values | null-header or value-compaction bug (Task 4, spec 6.2.1) |
| Symbol column empty | inline dictionary index encoding (Task 4) |

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/qwp/integration.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Run everything and commit**

```bash
npx vitest run && npx tsc --noEmit && npx eslint src/**
git add test/qwp/integration.test.ts
git commit -m "test(qwp): add end-to-end ws:// ingest test against QuestDB"
```

---

## Self-Review

**1. Spec coverage for PRs 1–3.** Frame codec + defrag + control frames + masking (Tasks 5, 6, 8 — spec 3.2.1, 3.2.2). Handshake + upgrade classification (Task 7 — spec 6.5, 6.5.1). Header + varint + four types + null bitmap + compaction (Tasks 1, 2, 4 — spec 6.0–6.3, 6.2.1). Row lifecycle rules (Task 3 — spec 6.5.3). Options wiring, all four sites + the `createBuffer` ordering hazard + `protocol_version` rejection (Task 11 — spec 3.5, 9.2). QWP auto-flush row default (Task 10 — spec 9.1). e2e (Task 12).

**Deliberately deferred, with the spec section that covers them:** TLS trust-store mapping (6.5.2 — `tls_verify` is wired in Task 10, `tls_roots`/PEM/PKCS#12 is not), cap-splitting (5.1), commit frame (5.1.1), `auto_flush_bytes` and the per-transport interval hook (9.1), the three callback surfaces (4.2), connect-mode derivation (4.3), `reset()` semantics (4.1), row rollback on a throwing setter (4.1.1). Each belongs to Plan 2 or later; none is silently dropped.

**2. Placeholder scan.** No TBDs. Every code step carries complete code. Task 12 Step 3 is the one step without pre-written code — deliberately, since it is a debugging step whose content depends on the failure, and it ships a symptom→cause table rather than "handle errors".

**3. Type consistency.** `writeVarint`/`varintSize`/`readVarint` (Task 1) are used with those exact names in Task 4. `ColumnBuffer.values/nulls/size` (Task 3) are consumed with those names in Task 4. `encodeFrame(tables)` (Task 4) is called in Task 9. `QwpWebSocket.connect/sendBinary/close/maxBatchSize` (Task 8) are used in Task 10. `WS`/`WSS` (Task 11) are imported in the same task's edits to `buffer/index.ts` and `transport/index.ts`. `QwpBuffer` satisfies `SenderBuffer` — enforced by `tsc --noEmit` in Task 9 Step 4, not by inspection.

**Known ordering wrinkle, stated rather than hidden:** Task 10's test cannot pass until Task 11 lands, because `SenderOptions` rejects `ws::` until then. Task 10 Step 4 says so explicitly and Task 11 Step 4 re-runs it. Reordering would require `QwpTransport` to exist before the factory that returns it, which is worse.

**4. API assumptions verified against the current `main`** — three defects were found and fixed during this review rather than left for the implementer:

- `Sender.fromConfig` is **`static async`**; the integration test now `await`s it.
- The integration test originally passed `auto_flush=off`, which spec 9.2 records as **rejected for WebSocket**. Removed.
- It also used `Wait.forLogMessage` with a guessed log pattern. The existing `test/sender.integration.test.ts` uses no wait strategy, so the plan now follows that pattern and relies on its own polling loop.

Confirmed sound: `Sender.connect(): Promise<boolean>` exists and is the right call for a connection-oriented transport; `new SenderOptions(configString)` reaches `parseProtocolVersion` via `parseConfigurationString`, so Task 11's constructor-throws test is valid; and `testcontainers` is already a devDependency.

**Still unverified, and flagged as the plan's main risk:** that `questdb/questdb:nightly` has QWP ingress enabled on port 9000 by default. Task 12 Step 2 says to confirm the failure reason before changing code, and a 404 on the upgrade points here rather than at our bytes. If the image needs a flag, that is a container-config fix in Task 12, not a redesign.
