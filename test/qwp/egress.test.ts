import { describe, expect, it, vi } from "vitest";
import {
  decodeQwpEgressMessage,
  encodeQwpFrame,
  encodeQwpGorilla,
  QWP_COLUMN_TYPE,
  QWP_EGRESS_CAPABILITY,
  QWP_EGRESS_MESSAGE,
  QWP_FLAG_DELTA_SYMBOL_DICTIONARY,
  QWP_FLAG_GORILLA,
  QWP_FLAG_ZSTD,
  QWP_DEFAULT_EGRESS_INITIAL_CREDIT,
  QWP_DEFAULT_EGRESS_SERVER_INFO_TIMEOUT_MS,
  QWP_MAX_CELLS_PER_BATCH,
  QWP_MAX_COLUMNS_PER_TABLE,
  QWP_MAX_ZSTD_DECOMPRESSED_SIZE,
  QWP_QUERY_FLAG_RESET_DICTIONARY,
  QWP_RESET_MASK_DICTIONARY,
  QWP_STATUS,
  QwpBinaryConnection,
  QwpByteReader,
  QwpByteWriter,
  QwpConnectionCloseInfo,
  QwpEgressQueryAbandonedError,
  QwpEgressQueryCancelTimeoutError,
  QwpEgressQueryError,
  QwpEgressQueryTimeoutError,
  QwpEgressSession,
  QwpResultBatchDecoder,
  QwpTableBuffer,
  QwpResultBatchView,
  QwpResultRowView,
  readQwpVarint,
  writeQwpVarint,
} from "../../src/qwp";
import { decompressQwpZstdFrame } from "../../src/_qwp/_core/zstd";
import { QwpAsyncQueue } from "../../src/_qwp/_internal/async-queue";

const RESULT_FLAGS = QWP_FLAG_DELTA_SYMBOL_DICTIONARY | QWP_FLAG_GORILLA;

// One standard Zstd frame with a declared 409-byte content size and an actual
// compressed block. Its body is a 100-row QWP table of INT values equal to 42.
const COMPRESSED_INT_RESULT_BODY = Uint8Array.from([
  40, 181, 47, 253, 96, 153, 0, 157, 0, 0, 96, 0, 0, 0, 100, 1, 1, 120, 4, 0,
  42, 0, 0, 1, 0, 138, 171, 46, 9,
]);

// A 37,006-byte RESULT_BATCH body containing 1,000 distinct, repetitive
// symbols, compressed by Zstd to 659 bytes. Its dictionary count legitimately
// exceeds the compressed payload length.
const COMPRESSED_LARGE_DELTA_RESULT_BODY = Buffer.from(
  "KLUv/WSOjzUUAMY/dBewpZAODMMwDENOQ5WTlDKllE4PJAcqEmsAYABzANu2bdu2bdu2bdu2bdu2bZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZL0kXA5hX8kXE5hPhIupyAfCZdTiI+Eyyn4I+FyCv1IuJwCPxIup7CPhMsp6CPhcgoDAAQCAgQBbdu2bdu2bdu2bdu2bdu2bdu2bdu2bdu2bdu2bdu2bdu2bduWJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJLdt27Zt27Zt27Zt27Zt27Zt27Zt27YtIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIhERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERtm3btm3btm3btm3btm3btm3btm3btm3btm3btm3btm3btm3btt22DUEQ/P////////////////////////////////////////////////8/MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMyMiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiISg+moIvBbA/LX2A0SQBD4/xUERvAH////8/////7//+v//3/9///f//9/+///t/////f//3f////u/////f//3v//3/v//7///9/3//99////7////f7/v9/////7/7+////39///f///9+//f//+///f/3///f/vv/////f/73////7v/////v/93//f//3/Ee/8/3f39aLfF31f1Pui74u+XeT7ou+LfvctogsAoJ2KWwFDNyrb",
  "base64",
);

function writeString(writer: QwpByteWriter, value: string): void {
  const bytes = new TextEncoder().encode(value);
  writeQwpVarint(writer, bytes.length);
  writer.writeBytes(bytes);
}

function writeU16String(writer: QwpByteWriter, value: string): void {
  const bytes = new TextEncoder().encode(value);
  writer.writeUint16(bytes.length).writeBytes(bytes);
}

function serverInfo(
  capabilities: number = QWP_EGRESS_CAPABILITY.QUERY_FLAGS,
): Uint8Array {
  const payload = new QwpByteWriter();
  payload
    .writeUint8(QWP_EGRESS_MESSAGE.SERVER_INFO)
    .writeUint8(0)
    .writeBigUint64(1n)
    .writeUint32(capabilities)
    .writeBigInt64(123n);
  writeU16String(payload, "cluster");
  writeU16String(payload, "node");
  return encodeQwpFrame(payload.toUint8Array());
}

function firstResultBatch(requestId = 0n): Uint8Array {
  const payload = new QwpByteWriter();
  payload.writeUint8(QWP_EGRESS_MESSAGE.RESULT_BATCH).writeBigUint64(requestId);
  writeQwpVarint(payload, 0);

  // Connection-scoped SYMBOL delta: [alpha, beta].
  writeQwpVarint(payload, 0);
  writeQwpVarint(payload, 2);
  writeString(payload, "alpha");
  writeString(payload, "beta");

  writeQwpVarint(payload, 0); // table name
  writeQwpVarint(payload, 3); // rows
  writeQwpVarint(payload, 4); // columns
  for (const [name, type] of [
    ["id", QWP_COLUMN_TYPE.INT],
    ["name", QWP_COLUMN_TYPE.VARCHAR],
    ["sym", QWP_COLUMN_TYPE.SYMBOL],
    ["ts", QWP_COLUMN_TYPE.TIMESTAMP],
  ] as const) {
    writeString(payload, name);
    payload.writeUint8(type);
  }

  payload.writeUint8(1).writeUint8(0b00000010); // id row 1 is NULL
  payload.writeInt32(7).writeInt32(9);

  payload.writeUint8(0); // name has no nulls
  payload.writeUint32(0).writeUint32(1).writeUint32(3).writeUint32(3);
  payload.writeUtf8("abb");

  payload.writeUint8(0); // symbols reference the connection dictionary
  writeQwpVarint(payload, 0);
  writeQwpVarint(payload, 1);
  writeQwpVarint(payload, 0);

  payload.writeUint8(0).writeUint8(1); // Gorilla timestamp column
  payload.writeBytes(encodeQwpGorilla([100n, 200n, 300n]));

  return encodeQwpFrame(payload.toUint8Array(), RESULT_FLAGS, 1);
}

function emptyResultBatch(
  requestId: bigint,
  batchSequence: number,
): Uint8Array {
  const payload = new QwpByteWriter();
  payload.writeUint8(QWP_EGRESS_MESSAGE.RESULT_BATCH).writeBigUint64(requestId);
  writeQwpVarint(payload, batchSequence);
  writeQwpVarint(payload, 0); // empty dictionary delta start
  writeQwpVarint(payload, 0); // empty dictionary delta count
  writeQwpVarint(payload, 0); // table name
  writeQwpVarint(payload, 0); // rows
  if (batchSequence === 0) writeQwpVarint(payload, 0); // initial schema
  return encodeQwpFrame(
    payload.toUint8Array(),
    QWP_FLAG_DELTA_SYMBOL_DICTIONARY,
    1,
  );
}

function resultEnd(requestId = 0n, totalRows = 3n): Uint8Array {
  const payload = new QwpByteWriter();
  payload.writeUint8(QWP_EGRESS_MESSAGE.RESULT_END).writeBigUint64(requestId);
  writeQwpVarint(payload, 1);
  writeQwpVarint(payload, totalRows);
  return encodeQwpFrame(payload.toUint8Array());
}

function cacheReset(mask: number): Uint8Array {
  const payload = new QwpByteWriter();
  payload.writeUint8(QWP_EGRESS_MESSAGE.CACHE_RESET).writeUint8(mask);
  return encodeQwpFrame(payload.toUint8Array());
}

/** A one-row RESULT_BATCH of a single DECIMAL column carrying `scale`. */
function decimalBatch(type: number, scale: number, words: number): Uint8Array {
  const payload = new QwpByteWriter();
  payload.writeUint8(QWP_EGRESS_MESSAGE.RESULT_BATCH).writeBigUint64(0n);
  writeQwpVarint(payload, 0); // batch sequence
  writeQwpVarint(payload, 0); // empty delta dictionary start
  writeQwpVarint(payload, 0); // empty delta dictionary count
  writeQwpVarint(payload, 0); // table name
  writeQwpVarint(payload, 1); // rows
  writeQwpVarint(payload, 1); // columns
  writeString(payload, "d");
  payload.writeUint8(type);
  payload.writeUint8(0); // no nulls
  payload.writeUint8(scale); // scale byte, unvalidated on the wire
  for (let word = 0; word < words; word++) payload.writeBigInt64(0n);
  return encodeQwpFrame(
    payload.toUint8Array(),
    QWP_FLAG_DELTA_SYMBOL_DICTIONARY,
    1,
  );
}

function compressedIntResultBatch(requestId = 0n): Uint8Array {
  const payload = new QwpByteWriter();
  payload.writeUint8(QWP_EGRESS_MESSAGE.RESULT_BATCH).writeBigUint64(requestId);
  writeQwpVarint(payload, 0);
  payload.writeBytes(COMPRESSED_INT_RESULT_BODY);
  return encodeQwpFrame(
    payload.toUint8Array(),
    QWP_FLAG_DELTA_SYMBOL_DICTIONARY | QWP_FLAG_ZSTD,
    1,
  );
}

function compressedLargeDeltaResultBatch(requestId = 0n): Uint8Array {
  const payload = new QwpByteWriter();
  payload.writeUint8(QWP_EGRESS_MESSAGE.RESULT_BATCH).writeBigUint64(requestId);
  writeQwpVarint(payload, 0);
  payload.writeBytes(COMPRESSED_LARGE_DELTA_RESULT_BODY);
  return encodeQwpFrame(
    payload.toUint8Array(),
    QWP_FLAG_DELTA_SYMBOL_DICTIONARY | QWP_FLAG_ZSTD,
    1,
  );
}

/**
 * A Zstd frame of RAW and RLE blocks. RLE is what detaches a declared grid
 * from the bytes on the wire: one byte encodes a whole run, so an all-NULL
 * bitmap of any size compresses to almost nothing.
 */
function rleZstdFrame(
  blocks: readonly (
    | { raw: number[] }
    | { rle: [byte: number, size: number] }
  )[],
  contentSize: number,
): Uint8Array {
  // Magic, then a single-segment descriptor with an 8-byte content size.
  const out = [0x28, 0xb5, 0x2f, 0xfd, 0xe0];
  let size = BigInt(contentSize);
  for (let index = 0; index < 8; index++) {
    out.push(Number(size & 0xffn));
    size >>= 8n;
  }
  blocks.forEach((block, index) => {
    const last = index === blocks.length - 1 ? 1 : 0;
    const [kind, length] =
      "raw" in block ? [0, block.raw.length] : [1, block.rle[1]];
    const header = last | (kind << 1) | (length << 3);
    out.push(header & 0xff, (header >>> 8) & 0xff, (header >>> 16) & 0xff);
    out.push(...("raw" in block ? block.raw : [block.rle[0]]));
  });
  return Uint8Array.from(out);
}

/** A compressed RESULT_BATCH declaring an all-NULL grid of the given shape. */
function compressedAllNullBatch(rows: number, columns: number): Uint8Array {
  const schema = new QwpByteWriter();
  writeQwpVarint(schema, 0); // table name
  writeQwpVarint(schema, rows);
  writeQwpVarint(schema, columns);
  for (let index = 0; index < columns; index++) {
    writeString(schema, `c${index}`);
    schema.writeUint8(QWP_COLUMN_TYPE.BOOLEAN);
  }
  const schemaBytes = Array.from(schema.toUint8Array());
  const bitmapBytes = Math.ceil(rows / 8);
  const blocks: ({ raw: number[] } | { rle: [number, number] })[] = [
    { raw: schemaBytes },
  ];
  for (let index = 0; index < columns; index++) {
    blocks.push({ raw: [1] }); // null flag
    blocks.push({ rle: [0xff, bitmapBytes] }); // every row NULL
  }
  const body = rleZstdFrame(
    blocks,
    schemaBytes.length + columns * (1 + bitmapBytes),
  );
  const payload = new QwpByteWriter();
  payload.writeUint8(QWP_EGRESS_MESSAGE.RESULT_BATCH).writeBigUint64(1n);
  writeQwpVarint(payload, 0);
  payload.writeBytes(body);
  return encodeQwpFrame(payload.toUint8Array(), QWP_FLAG_ZSTD, 1);
}

/**
 * A compressed RESULT_BATCH declaring `count` zero-length delta dictionary
 * entries. Each costs one decompressed byte, so Zstd RLE packs millions of
 * them into a few hundred wire bytes -- the delta-dictionary analogue of the
 * all-NULL grid flood above.
 */
function deltaDictionaryFloodBatch(count: number): Uint8Array {
  const header = new QwpByteWriter();
  writeQwpVarint(header, 0); // delta dictionary start
  writeQwpVarint(header, count); // delta dictionary count
  const headerBytes = Array.from(header.toUint8Array());

  const grid = new QwpByteWriter();
  writeQwpVarint(grid, 0); // table name
  writeQwpVarint(grid, 0); // rows
  writeQwpVarint(grid, 0); // columns -- an empty, in-cap grid
  const gridBytes = Array.from(grid.toUint8Array());

  const ZSTD_BLOCK_MAX = 131072;
  const blocks: ({ raw: number[] } | { rle: [number, number] })[] = [
    { raw: headerBytes },
  ];
  for (let remaining = count; remaining > 0; ) {
    const run = Math.min(remaining, ZSTD_BLOCK_MAX);
    blocks.push({ rle: [0x00, run] }); // `run` zero-length symbol entries
    remaining -= run;
  }
  blocks.push({ raw: gridBytes });

  const body = rleZstdFrame(
    blocks,
    headerBytes.length + count + gridBytes.length,
  );
  const payload = new QwpByteWriter();
  payload.writeUint8(QWP_EGRESS_MESSAGE.RESULT_BATCH).writeBigUint64(1n);
  writeQwpVarint(payload, 0); // batch sequence
  payload.writeBytes(body);
  return encodeQwpFrame(
    payload.toUint8Array(),
    QWP_FLAG_DELTA_SYMBOL_DICTIONARY | QWP_FLAG_ZSTD,
    1,
  );
}

function scalarResultBatch(): Uint8Array {
  const payload = new QwpByteWriter();
  payload.writeUint8(QWP_EGRESS_MESSAGE.RESULT_BATCH).writeBigUint64(0n);
  writeQwpVarint(payload, 0); // batch sequence
  writeQwpVarint(payload, 0); // empty delta start
  writeQwpVarint(payload, 0); // empty delta count
  writeQwpVarint(payload, 0); // table name
  writeQwpVarint(payload, 1); // rows
  const schema = [
    ["bool", QWP_COLUMN_TYPE.BOOLEAN],
    ["byte", QWP_COLUMN_TYPE.BYTE],
    ["short", QWP_COLUMN_TYPE.SHORT],
    ["char", QWP_COLUMN_TYPE.CHAR],
    ["long", QWP_COLUMN_TYPE.LONG],
    ["float", QWP_COLUMN_TYPE.FLOAT],
    ["double", QWP_COLUMN_TYPE.DOUBLE],
    ["date", QWP_COLUMN_TYPE.DATE],
    ["uuid", QWP_COLUMN_TYPE.UUID],
    ["long256", QWP_COLUMN_TYPE.LONG256],
    ["geohash", QWP_COLUMN_TYPE.GEOHASH],
    ["nanos", QWP_COLUMN_TYPE.TIMESTAMP_NANOS],
    ["doubles", QWP_COLUMN_TYPE.DOUBLE_ARRAY],
    ["longs", QWP_COLUMN_TYPE.LONG_ARRAY],
    ["dec64", QWP_COLUMN_TYPE.DECIMAL64],
    ["dec128", QWP_COLUMN_TYPE.DECIMAL128],
    ["dec256", QWP_COLUMN_TYPE.DECIMAL256],
    ["binary", QWP_COLUMN_TYPE.BINARY],
    ["ipv4", QWP_COLUMN_TYPE.IPV4],
  ] as const;
  writeQwpVarint(payload, schema.length);
  for (const [name, type] of schema) {
    writeString(payload, name);
    payload.writeUint8(type);
  }

  payload.writeUint8(0).writeUint8(1); // BOOLEAN
  payload.writeUint8(0).writeInt8(-2);
  payload.writeUint8(0).writeInt16(-3);
  payload.writeUint8(0).writeUint16("Q".charCodeAt(0));
  payload.writeUint8(0).writeBigInt64(-4n);
  payload.writeUint8(0).writeFloat32(1.5);
  payload.writeUint8(0).writeFloat64(-2.5);
  payload.writeUint8(0).writeUint8(0).writeBigInt64(123n); // DATE raw
  payload.writeUint8(0).writeBigUint64(1n).writeBigUint64(2n);
  payload
    .writeUint8(0)
    .writeBigInt64(1n)
    .writeBigInt64(2n)
    .writeBigInt64(3n)
    .writeBigInt64(4n);
  payload.writeUint8(0);
  writeQwpVarint(payload, 5);
  payload.writeUint8(0b10101);
  payload.writeUint8(0).writeUint8(0).writeBigInt64(456n); // NANOS raw
  payload
    .writeUint8(0)
    .writeUint8(2)
    .writeInt32(1)
    .writeInt32(2)
    .writeFloat64(1.25)
    .writeFloat64(2.5);
  payload
    .writeUint8(0)
    .writeUint8(1)
    .writeInt32(2)
    .writeBigInt64(10n)
    .writeBigInt64(20n);
  payload.writeUint8(0).writeUint8(2).writeBigInt64(1234n);
  payload.writeUint8(0).writeUint8(3).writeBigInt64(123456n).writeBigInt64(0n);
  payload
    .writeUint8(0)
    .writeUint8(4)
    .writeBigInt64(987654n)
    .writeBigInt64(0n)
    .writeBigInt64(0n)
    .writeBigInt64(0n);
  payload.writeUint8(0).writeUint32(0).writeUint32(3);
  payload.writeBytes(Uint8Array.of(1, 2, 3));
  payload.writeUint8(0).writeInt32(-1);

  return encodeQwpFrame(payload.toUint8Array(), RESULT_FLAGS, 1);
}

function queryError(
  requestId: bigint,
  message: string,
  status: number = QWP_STATUS.PARSE_ERROR,
): Uint8Array {
  const bytes = new TextEncoder().encode(message);
  const payload = new QwpByteWriter();
  payload
    .writeUint8(QWP_EGRESS_MESSAGE.QUERY_ERROR)
    .writeBigUint64(requestId)
    .writeUint8(status)
    .writeUint16(bytes.length)
    .writeBytes(bytes);
  return encodeQwpFrame(payload.toUint8Array());
}

class FakeConnection implements QwpBinaryConnection {
  readonly handshake = { qwpVersion: 1 };
  private readonly incoming = new QwpAsyncQueue<Uint8Array>();
  private readonly resolveClosed: (info: QwpConnectionCloseInfo) => void;
  readonly messages = this.incoming;
  readonly sent: Uint8Array[] = [];
  readonly closeCalls: { code: number; reason: string }[] = [];
  readonly closed: Promise<QwpConnectionCloseInfo>;
  onSend?: (payload: Uint8Array) => Promise<void>;
  onClose?: () => void;

  constructor() {
    let resolve!: (info: QwpConnectionCloseInfo) => void;
    this.closed = new Promise((res) => {
      resolve = res;
    });
    this.resolveClosed = resolve;
  }

  send(payload: Uint8Array): Promise<void> {
    this.sent.push(payload.slice());
    return this.onSend?.(payload) ?? Promise.resolve();
  }

  close(code = 1000, reason = ""): Promise<void> {
    this.closeCalls.push({ code, reason });
    this.onClose?.();
    this.incoming.end();
    this.resolveClosed({ code, reason, wasClean: true });
    return Promise.resolve();
  }

  receive(payload: Uint8Array): void {
    this.incoming.push(payload);
  }
}

describe("QWP result batch decoder", () => {
  it("decodes nullable, variable-width, symbol, and Gorilla columns", () => {
    const message = decodeQwpEgressMessage(firstResultBatch());
    expect(message.kind).toBe("result-batch");
    if (message.kind !== "result-batch") throw new Error("unexpected message");

    const batch = new QwpResultBatchDecoder().decode(message);
    expect(batch.rowCount).toBe(3);
    expect(batch.columns.map((column) => column.name)).toEqual([
      "id",
      "name",
      "sym",
      "ts",
    ]);
    expect(batch.columns[0].values).toEqual([7, null, 9]);
    expect(batch.columns[1].values).toEqual(["a", "bb", ""]);
    expect(batch.columns[2].values).toEqual(["alpha", "beta", "alpha"]);
    expect(batch.columns[3].values).toEqual([100n, 200n, 300n]);
    expect([...batch.rows()]).toEqual([
      [7, "a", "alpha", 100n],
      [null, "bb", "beta", 200n],
      [9, "", "alpha", 300n],
    ]);
  });

  it("decodes identifiers at the defensive egress byte bound", () => {
    // Query results may expose existing Java metadata created through another
    // protocol. Keep accepting up to 127 UTF-16 code units on egress, while
    // QWP ingress separately applies its 127-byte wire limit.
    for (const name of ["a".repeat(127), "é".repeat(127), "あ".repeat(127)]) {
      const payload = new QwpByteWriter();
      payload.writeUint8(QWP_EGRESS_MESSAGE.RESULT_BATCH).writeBigUint64(0n);
      writeQwpVarint(payload, 0); // batch sequence
      writeQwpVarint(payload, 0); // empty dictionary delta start
      writeQwpVarint(payload, 0); // empty dictionary delta count
      writeString(payload, name); // table name
      writeQwpVarint(payload, 0); // rows
      writeQwpVarint(payload, 1); // columns
      writeString(payload, name); // column name
      payload.writeUint8(QWP_COLUMN_TYPE.INT);
      payload.writeUint8(0); // null flag, still present for a zero-row column

      const message = decodeQwpEgressMessage(
        encodeQwpFrame(
          payload.toUint8Array(),
          QWP_FLAG_DELTA_SYMBOL_DICTIONARY,
          1,
        ),
      );
      if (message.kind !== "result-batch")
        throw new Error("unexpected message");
      const batch = new QwpResultBatchDecoder().decode(message);
      expect(batch.tableName).toBe(name);
      expect(batch.columns.map((column) => column.name)).toEqual([name]);
    }
  });

  it("exposes bounded zero-copy column views without value arrays", () => {
    const message = decodeQwpEgressMessage(firstResultBatch());
    if (message.kind !== "result-batch") throw new Error("unexpected message");

    const batch = new QwpResultBatchDecoder().decodeView(message);
    expect(batch).toBeInstanceOf(QwpResultBatchView);
    expect(batch.valid).toBe(true);
    expect(batch.rowCount).toBe(3);
    expect(batch.columns.map((column) => column.name)).toEqual([
      "id",
      "name",
      "sym",
      "ts",
    ]);

    const id = batch.column(0);
    expect(id.valuesBytes()!.buffer).toBe(message.body.buffer);
    expect(id.nullBitmapBytes()!.buffer).toBe(message.body.buffer);
    expect(id.nonNullIndexView()).toEqual(Int32Array.of(0, -1, 1));
    expect(id.getInt(0)).toBe(7);
    expect(id.isNull(1)).toBe(true);
    expect(id.getInt(1)).toBe(0);
    expect(id.getInt(2)).toBe(9);

    const name = batch.column(1);
    expect(new TextDecoder().decode(name.getUtf8View(1)!)).toBe("bb");
    expect(new TextDecoder().decode(name.stringBytes()!)).toBe("abb");
    const symbol = batch.column(2);
    expect(symbol.symbolIdView()).toEqual(Int32Array.of(0, 1, 0));
    expect(symbol.symbolDictionarySize).toBe(2);
    expect(symbol.getSymbolId(1)).toBe(1);
    expect(symbol.getSymbolForId(1)).toBe("beta");
    expect(symbol.getSymbol(2)).toBe("alpha");
    const timestamp = batch.column(3);
    expect(timestamp.valuesBytes()).toHaveLength(24);
    expect([0, 1, 2].map((row) => timestamp.getLong(row))).toEqual([
      100n,
      200n,
      300n,
    ]);

    const retained = batch.materialize();
    batch.release();
    expect(batch.valid).toBe(false);
    expect(() => batch.rowCount).toThrow(/no longer valid/i);
    expect(() => id.getInt(0)).toThrow(/no longer valid/i);
    expect([...retained.rows()]).toEqual([
      [7, "a", "alpha", 100n],
      [null, "bb", "beta", 200n],
      [9, "", "alpha", 300n],
    ]);
  });

  it("reuses one row-major view for row() and forEachRow()", () => {
    const message = decodeQwpEgressMessage(firstResultBatch());
    if (message.kind !== "result-batch") throw new Error("unexpected message");

    const batch = new QwpResultBatchDecoder().decodeView(message);
    const first = batch.row(0);
    expect(first).toBeInstanceOf(QwpResultRowView);
    expect(first.batch).toBe(batch);
    expect(first.rowIndex).toBe(0);
    expect(first.getInt(0)).toBe(7);
    expect(new TextDecoder().decode(first.getUtf8View(1)!)).toBe("a");
    expect(first.getSymbolId(2)).toBe(0);
    expect(first.getSymbol(2)).toBe("alpha");
    expect(first.getLong(3)).toBe(100n);

    const second = batch.row(1);
    expect(second).toBe(first);
    expect(first.rowIndex).toBe(1);
    expect(first.isNull(0)).toBe(true);
    expect(first.getInt(0)).toBe(0);
    expect(first.getString(1)).toBe("bb");

    const identities = new Set<QwpResultRowView>();
    const rows: unknown[][] = [];
    batch.forEachRow((row) => {
      identities.add(row);
      rows.push([
        row.rowIndex,
        row.get(0),
        row.getString(1),
        row.getSymbol(2),
        row.getLong(3),
      ]);
    });
    expect(identities.size).toBe(1);
    expect(rows).toEqual([
      [0, 7, "a", "alpha", 100n],
      [1, null, "bb", "beta", 200n],
      [2, 9, "", "alpha", 300n],
    ]);

    let visited = 0;
    expect(() =>
      batch.forEachRow((row) => {
        visited++;
        if (row.rowIndex === 1) throw new Error("stop rows");
      }),
    ).toThrow("stop rows");
    expect(visited).toBe(2);

    batch.release();
    expect(() => first.rowIndex).toThrow(/no longer valid/i);
    expect(() => first.getInt(0)).toThrow(/no longer valid/i);
  });

  it("does not invoke forEachRow for an empty batch", () => {
    const message = decodeQwpEgressMessage(emptyResultBatch(0n, 0));
    if (message.kind !== "result-batch") throw new Error("unexpected message");
    const batch = new QwpResultBatchDecoder().decodeView(message);
    const callback = vi.fn();
    batch.forEachRow(callback);
    expect(callback).not.toHaveBeenCalled();
    expect(() => batch.row(0)).toThrow("row index out of range: 0");
  });

  it("lazily reads every result type and detaches materialized binary", () => {
    const frame = scalarResultBatch();
    const message = decodeQwpEgressMessage(frame);
    if (message.kind !== "result-batch") throw new Error("unexpected message");
    const batch = new QwpResultBatchDecoder().decodeView(message);
    const row = batch.columns.map((column) => column.get(0));

    expect(row.slice(0, 8)).toEqual([true, -2, -3, "Q", -4n, 1.5, -2.5, 123n]);
    expect(row[8]).toEqual({ low: 1n, high: 2n });
    expect(row[9]).toEqual({ words: [1n, 2n, 3n, 4n] });
    expect(row[10]).toEqual({ bits: 21n, precisionBits: 5 });
    expect(row[11]).toBe(456n);
    expect(row[12]).toEqual({ dimensions: [1, 2], values: [1.25, 2.5] });
    expect(row[13]).toEqual({ dimensions: [2], values: [10n, 20n] });
    expect(row.slice(14, 17)).toEqual([
      { unscaled: 1234n, scale: 2 },
      { unscaled: 123456n, scale: 3 },
      { unscaled: 987654n, scale: 4 },
    ]);
    expect(batch.column(8).getUuidLow(0)).toBe(1n);
    expect(batch.column(8).getUuidHigh(0)).toBe(2n);
    expect(batch.column(9).getLong256Word(0, 3)).toBe(4n);
    expect(batch.column(10).getGeohashBits(0)).toBe(21n);
    expect(batch.column(12).getArrayDimensionCount(0)).toBe(2);
    expect(batch.column(14).getDecimalUnscaled(0)).toBe(1234n);
    expect(batch.column(14).bytesPerValue).toBe(8);
    expect(batch.column(17).getBinaryView(0)).toEqual(Uint8Array.of(1, 2, 3));
    expect(batch.column(18).getInt(0)).toBe(-1);

    const rowView = batch.row(0);
    expect(rowView.getBoolean(0)).toBe(true);
    expect(rowView.getByte(1)).toBe(-2);
    expect(rowView.getShort(2)).toBe(-3);
    expect(rowView.getChar(3)).toBe("Q");
    expect(rowView.getLong(4)).toBe(-4n);
    expect(rowView.getFloat(5)).toBe(1.5);
    expect(rowView.getDouble(6)).toBe(-2.5);
    expect(rowView.getUuidLow(8)).toBe(1n);
    expect(rowView.getUuidHigh(8)).toBe(2n);
    expect(rowView.getLong256Word(9, 3)).toBe(4n);
    expect(rowView.getGeohashBits(10)).toBe(21n);
    expect(rowView.getArrayDimensionCount(12)).toBe(2);
    expect(rowView.getArrayView(12)).toBeInstanceOf(Uint8Array);
    expect(rowView.getDecimalUnscaled(14)).toBe(1234n);
    expect(rowView.getBinaryView(17)).toEqual(Uint8Array.of(1, 2, 3));
    expect(rowView.getInt(18)).toBe(-1);

    const retained = batch.materialize();
    batch.column(17).getBinaryView(0)![0] = 99;
    expect(retained.get(0, 17)).toEqual(Uint8Array.of(1, 2, 3));
  });

  it("reuses batch and column view objects across decodes", () => {
    const decoder = new QwpResultBatchDecoder();
    const firstMessage = decodeQwpEgressMessage(scalarResultBatch());
    if (firstMessage.kind !== "result-batch") {
      throw new Error("unexpected message");
    }
    const first = decoder.decodeView(firstMessage);
    const firstColumn = first.column(0);
    const firstRow = first.row(0);
    first.release();
    decoder.resetQuerySchema();

    const secondMessage = decodeQwpEgressMessage(scalarResultBatch());
    if (secondMessage.kind !== "result-batch") {
      throw new Error("unexpected message");
    }
    const second = decoder.decodeView(secondMessage);
    expect(second).toBe(first);
    expect(second.column(0)).toBe(firstColumn);
    expect(second.row(0)).toBe(firstRow);
    expect(second.column(0).getBoolean(0)).toBe(true);
    expect(second.row(0).getBoolean(0)).toBe(true);
  });

  it("rejects a continuation batch before a schema-bearing batch", () => {
    const bytes = firstResultBatch();
    // RESULT_BATCH sequence is the byte immediately after kind + request ID.
    bytes[12 + 1 + 8] = 1;
    const message = decodeQwpEgressMessage(bytes);
    if (message.kind !== "result-batch") throw new Error("unexpected message");
    expect(() => new QwpResultBatchDecoder().decode(message)).toThrow(
      /sequence|schema/i,
    );
  });

  it("decodes the remaining scalar, decimal, binary, and array types", () => {
    const message = decodeQwpEgressMessage(scalarResultBatch());
    if (message.kind !== "result-batch") throw new Error("unexpected message");
    const batch = new QwpResultBatchDecoder().decode(message);
    const row = [...batch.rows()][0];

    expect(row.slice(0, 8)).toEqual([true, -2, -3, "Q", -4n, 1.5, -2.5, 123n]);
    expect(row[8]).toEqual({ low: 1n, high: 2n });
    expect(row[9]).toEqual({ words: [1n, 2n, 3n, 4n] });
    expect(row[10]).toEqual({ bits: 21n, precisionBits: 5 });
    expect(row[11]).toBe(456n);
    expect(row[12]).toEqual({ dimensions: [1, 2], values: [1.25, 2.5] });
    expect(row[13]).toEqual({ dimensions: [2], values: [10n, 20n] });
    expect(row.slice(14, 17)).toEqual([
      { unscaled: 1234n, scale: 2 },
      { unscaled: 123456n, scale: 3 },
      { unscaled: 987654n, scale: 4 },
    ]);
    expect(row[17]).toEqual(Uint8Array.of(1, 2, 3));
    expect(row[18]).toBe(-1);
  });

  it("decompresses a Zstd RESULT_BATCH body", () => {
    const message = decodeQwpEgressMessage(compressedIntResultBatch(7n));
    if (message.kind !== "result-batch") throw new Error("unexpected message");

    expect(message.body).toEqual(COMPRESSED_INT_RESULT_BODY);
    const batch = new QwpResultBatchDecoder().decode(message);
    expect(batch.requestId).toBe(7n);
    expect(batch.rowCount).toBe(100);
    expect(batch.columns[0]).toEqual({
      name: "x",
      type: QWP_COLUMN_TYPE.INT,
      values: new Array(100).fill(42),
    });
    expect(batch.get(99, 0)).toBe(42);
  });

  it("decodes a Zstd frame that carries a content checksum", () => {
    // Nothing verifies the four trailing bytes -- neither the frame walk nor
    // fzstd looks at them -- but they sit past the last block, so a decoder
    // that mistakes them for one more block, or appends after them, gets a
    // frame that no longer decodes.
    const size = COMPRESSED_INT_RESULT_BODY.byteLength;
    const checksummed = new Uint8Array(size + 4);
    checksummed.set(COMPRESSED_INT_RESULT_BODY);
    checksummed[4] |= 0x04; // content checksum flag
    checksummed.set(Uint8Array.of(9, 9, 9, 9), size);

    const message = decodeQwpEgressMessage(compressedIntResultBatch());
    if (message.kind !== "result-batch") throw new Error("unexpected message");
    const batch = new QwpResultBatchDecoder().decode({
      ...message,
      body: checksummed,
    });
    expect(batch.rowCount).toBe(100);
    expect(batch.get(99, 0)).toBe(42);
  });

  it("exposes a reusable view over a Zstd RESULT_BATCH", () => {
    const message = decodeQwpEgressMessage(compressedIntResultBatch(7n));
    if (message.kind !== "result-batch") throw new Error("unexpected message");

    const batch = new QwpResultBatchDecoder().decodeView(message);
    expect(batch.requestId).toBe(7n);
    expect(batch.rowCount).toBe(100);
    expect(batch.column(0).valuesBytes()).toHaveLength(400);
    expect(batch.column(0).getInt(99)).toBe(42);
  });

  it("bounds the grid a RESULT_BATCH declares, not only each dimension", () => {
    // The row and column caps are independent, so their product -- 1,048,576
    // rows of 2,048 columns -- is 2.1 billion cells. Decoding materializes
    // two rowCount-length arrays per column, and an all-NULL column is one
    // bit per cell before Zstd, so a few kilobytes of RLE-compressed bitmap
    // used to declare a grid no heap could hold: 1,727 wire bytes exhausted a
    // 1 GB heap and 6,655 aborted the process outright.
    for (const columns of [128, 480, 511]) {
      const wire = compressedAllNullBatch(1_048_576, columns);
      expect(wire.byteLength).toBeLessThan(8_000);
      const message = decodeQwpEgressMessage(wire);
      if (message.kind !== "result-batch")
        throw new Error("unexpected message");

      const before = process.memoryUsage().heapUsed;
      expect(() => new QwpResultBatchDecoder().decode(message)).toThrow(
        /above the client cap/,
      );
      // Rejected in prepare(), before a column is read -- reading one is what
      // allocates.
      expect(process.memoryUsage().heapUsed - before).toBeLessThan(50e6);
    }
  });

  it("still decodes a legitimate batch at the grid cap", () => {
    // The widest supported table, at the row count that exactly reaches the
    // cap: this must keep working.
    const rows = QWP_MAX_CELLS_PER_BATCH / QWP_MAX_COLUMNS_PER_TABLE;
    const message = decodeQwpEgressMessage(
      compressedAllNullBatch(rows, QWP_MAX_COLUMNS_PER_TABLE),
    );
    if (message.kind !== "result-batch") throw new Error("unexpected message");

    const batch = new QwpResultBatchDecoder().decode(message);
    expect(batch.rowCount).toBe(rows);
    expect(batch.columns).toHaveLength(QWP_MAX_COLUMNS_PER_TABLE);
    expect(batch.get(0, 0)).toBeNull();
  });

  it("bounds the delta symbol dictionary a RESULT_BATCH declares", () => {
    // A zero-length entry costs one decompressed byte, so a few hundred
    // Zstd-compressed bytes can declare millions of them. Reject beyond the
    // server's connection dictionary cap before entering the allocation loop.
    const wire = deltaDictionaryFloodBatch(2_000_001);
    expect(wire.byteLength).toBeLessThan(2_000);
    const message = decodeQwpEgressMessage(wire);
    if (message.kind !== "result-batch") throw new Error("unexpected message");

    const before = process.memoryUsage().heapUsed;
    expect(() => new QwpResultBatchDecoder().decode(message)).toThrow(
      /delta dictionary count out of range: 2000001/,
    );
    // Rejected before the entry loop -- reading one is what allocates.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(50e6);
  });

  it("still decodes a delta dictionary that fits its frame", () => {
    // A real delta carries actual symbols, so its entry count never exceeds the
    // bytes that transmitted it: the bound only rejects counts Zstd manufactured.
    const message = decodeQwpEgressMessage(firstResultBatch());
    if (message.kind !== "result-batch") throw new Error("unexpected message");
    const batch = new QwpResultBatchDecoder().decode(message);
    expect(batch.get(0, 2)).toBe("alpha");
    expect(batch.get(1, 2)).toBe("beta");
  });

  it("decodes a compressed delta larger than its wire payload", () => {
    const message = decodeQwpEgressMessage(compressedLargeDeltaResultBatch());
    if (message.kind !== "result-batch") throw new Error("unexpected message");
    expect(message.body.byteLength).toBeLessThan(1_000);
    expect(() => new QwpResultBatchDecoder().decode(message)).not.toThrow();
  });

  it("rejects a decimal scale byte the encoder would never send", () => {
    // The scale is a single wire byte; unchecked, a 255 decodes to a value off
    // by up to 10^237. Bound it like the adjacent GEOHASH precision and the
    // encoder (QWP_DECIMAL_MAX_SCALE: 18/38/76), on both decode paths.
    for (const [type, words, max] of [
      [QWP_COLUMN_TYPE.DECIMAL64, 1, 18],
      [QWP_COLUMN_TYPE.DECIMAL128, 2, 38],
      [QWP_COLUMN_TYPE.DECIMAL256, 4, 76],
    ] as const) {
      const decodeAt = (scale: number) => {
        const message = decodeQwpEgressMessage(
          decimalBatch(type, scale, words),
        );
        if (message.kind !== "result-batch") throw new Error("unexpected");
        return message;
      };
      expect(() =>
        new QwpResultBatchDecoder().decode(decodeAt(max + 1)),
      ).toThrow(/decimal scale out of range/);
      // The zero-copy view path reads the same byte.
      expect(() =>
        new QwpResultBatchDecoder().decodeView(decodeAt(255)),
      ).toThrow(/decimal scale out of range/);
      // The maximum the encoder allows still decodes.
      expect(() =>
        new QwpResultBatchDecoder().decode(decodeAt(max)),
      ).not.toThrow();
    }
  });

  it("requires a bounded, single Zstd frame", () => {
    const decodeBody = (body: Uint8Array) => {
      const bytes = compressedIntResultBatch();
      const message = decodeQwpEgressMessage(bytes);
      if (message.kind !== "result-batch") {
        throw new Error("unexpected message");
      }
      return new QwpResultBatchDecoder().decode({ ...message, body });
    };

    expect(() => decodeBody(Uint8Array.of(1, 2, 3, 4, 5))).toThrow(
      /zstd frame magic/i,
    );
    expect(() => decodeBody(Uint8Array.of(40, 181, 47, 253, 0, 0))).toThrow(
      /declared content size/i,
    );

    const overCap = BigInt(QWP_MAX_ZSTD_DECOMPRESSED_SIZE + 1);
    expect(() =>
      decodeBody(
        Uint8Array.of(
          40,
          181,
          47,
          253,
          0xa0,
          Number(overCap & 0xffn),
          Number((overCap >> 8n) & 0xffn),
          Number((overCap >> 16n) & 0xffn),
          Number((overCap >> 24n) & 0xffn),
        ),
      ),
    ).toThrow(/exceeds client cap/i);

    const withTrailingData = new Uint8Array(
      COMPRESSED_INT_RESULT_BODY.byteLength + 1,
    );
    withTrailingData.set(COMPRESSED_INT_RESULT_BODY);
    expect(() => decodeBody(withTrailingData)).toThrow(/exactly one frame/i);

    const wrongDeclaredSize = COMPRESSED_INT_RESULT_BODY.slice();
    wrongDeclaredSize[5]++;
    expect(() => decodeBody(wrongDeclaredSize)).toThrow(
      /does not match frame content size/i,
    );

    const tooSmallDeclaredSize = COMPRESSED_INT_RESULT_BODY.slice();
    tooSmallDeclaredSize[5]--;
    expect(() => decodeBody(tooSmallDeclaredSize)).toThrow(
      /output exceeds declared content size/i,
    );

    const reservedBlock = COMPRESSED_INT_RESULT_BODY.slice();
    reservedBlock[7] = (reservedBlock[7] & ~0x06) | 0x06;
    expect(() => decodeBody(reservedBlock)).toThrow(/reserved block type/i);
  });

  it("rejects an over-long Zstd frame whatever its output ends with", () => {
    // The over-run guard used to look for a run of one byte at the declared
    // size. A frame that ran long pushed that marker further out and left its
    // own bytes in front of it, so the run still matched whenever those bytes
    // happened to be the marker byte -- only min(overshoot, 8) of them had to,
    // making a one-byte overshoot a 1-in-256 bypass, and 0xa5 is a legal UTF-8
    // continuation byte, so a VARCHAR ending in one collided by accident. The
    // test above only passed because its fixture happens to decode to a 0x00.
    //
    // The bypass is not neutral: truncating the output to the declared size
    // also hides the "unexpected trailing byte(s)" the same bytes would raise
    // if they were declared honestly, so the client reports a complete,
    // successful result for a frame it is supposed to reject.
    const singleSegmentFrame = (
      declared: number,
      rleByte: number,
      emit: number,
    ) =>
      Uint8Array.from([
        0x28,
        0xb5,
        0x2f,
        0xfd, // magic
        0xe0, // single segment, 8-byte content size, no checksum
        declared,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        // One RLE block, flagged last, emitting `emit` copies of `rleByte`.
        1 | (1 << 1) | (emit << 3),
        ((1 | (1 << 1) | (emit << 3)) >>> 8) & 0xff,
        ((1 | (1 << 1) | (emit << 3)) >>> 16) & 0xff,
        rleByte,
      ]);

    // Exactly the shape that used to be accepted: declares 8, emits 16, and
    // the eight bytes past the declared size are the old marker byte.
    expect(() =>
      decompressQwpZstdFrame(singleSegmentFrame(8, 0xa5, 16)),
    ).toThrow(/exceeds declared content size/i);
    // Overshooting by one needed a single lucky byte.
    expect(() =>
      decompressQwpZstdFrame(singleSegmentFrame(8, 0xa5, 9)),
    ).toThrow(/exceeds declared content size/i);
    // Any other filler was always caught, and still is.
    expect(() =>
      decompressQwpZstdFrame(singleSegmentFrame(8, 0x5a, 16)),
    ).toThrow(/exceeds declared content size/i);
    // A frame that means what it says still round-trips.
    expect(decompressQwpZstdFrame(singleSegmentFrame(8, 0x42, 8))).toEqual(
      new Uint8Array(8).fill(0x42),
    );
  });
});

describe("QwpEgressSession", () => {
  it("validates SERVER_INFO timeouts before invoking its factory", async () => {
    let factoryCalls = 0;
    await expect(
      QwpEgressSession.connect(
        async () => {
          factoryCalls++;
          return new FakeConnection();
        },
        { serverInfoTimeoutMs: 0 },
      ),
    ).rejects.toThrow("serverInfoTimeoutMs must be a positive finite number");
    expect(factoryCalls).toBe(0);

    await expect(
      QwpEgressSession.connect(
        async () => {
          factoryCalls++;
          return new FakeConnection();
        },
        { initialCredit: -1 },
      ),
    ).rejects.toThrow("initialCredit must be a non-negative safe integer");
    expect(factoryCalls).toBe(0);

    await expect(
      QwpEgressSession.connect(
        async () => {
          factoryCalls++;
          return new FakeConnection();
        },
        { bufferPoolSize: 0 },
      ),
    ).rejects.toThrow("bufferPoolSize must be a positive safe integer");
    expect(factoryCalls).toBe(0);

    await expect(
      QwpEgressSession.connect(
        async () => {
          factoryCalls++;
          return new FakeConnection();
        },
        { queryTimeoutMs: -1 },
      ),
    ).rejects.toThrow("queryTimeoutMs must be a non-negative finite number");
    expect(factoryCalls).toBe(0);

    await expect(
      QwpEgressSession.connect(
        async () => {
          factoryCalls++;
          return new FakeConnection();
        },
        { cancelDrainTimeoutMs: 0 },
      ),
    ).rejects.toThrow("cancelDrainTimeoutMs must be a positive finite number");
    expect(factoryCalls).toBe(0);
  });

  it("closes the transport when SERVER_INFO does not arrive", async () => {
    vi.useFakeTimers();
    try {
      const connection = new FakeConnection();
      const session = new QwpEgressSession(connection, {
        serverInfoTimeoutMs: 25,
      });
      const ready = session.ready.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(25);
      await expect(ready).resolves.toEqual(
        expect.objectContaining({
          message: "timed out waiting for QWP SERVER_INFO",
        }),
      );
      expect(connection.closeCalls).toEqual([
        { code: 1002, reason: "missing QWP SERVER_INFO" },
      ]);
      await expect(session.closed).resolves.toMatchObject({ code: 1002 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the Java-compatible SERVER_INFO timeout by default", async () => {
    vi.useFakeTimers();
    try {
      const connection = new FakeConnection();
      const session = new QwpEgressSession(connection);
      const ready = session.ready.catch((error: unknown) => error);

      expect(QWP_DEFAULT_EGRESS_SERVER_INFO_TIMEOUT_MS).toBe(5_000);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(connection.closeCalls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await expect(ready).resolves.toMatchObject({
        message: "timed out waiting for QWP SERVER_INFO",
      });
      expect(connection.closeCalls).toEqual([
        { code: 1002, reason: "missing QWP SERVER_INFO" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("close interrupts an egress request whose send has not settled", async () => {
    const connection = new FakeConnection();
    const session = new QwpEgressSession(connection);
    connection.receive(serverInfo());
    await session.ready;
    let rejectSend!: (error: Error) => void;
    connection.onSend = () =>
      new Promise<void>((_resolve, reject) => {
        rejectSend = reject;
      });
    connection.onClose = () => rejectSend(new Error("transport closed"));
    const querying = session.query("select 1").catch((error: unknown) => error);
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));

    await expect(session.close()).resolves.toBeUndefined();
    await expect(querying).resolves.toEqual(
      expect.objectContaining({ message: "transport closed" }),
    );
  });

  it("waits for SERVER_INFO and streams a typed query result", async () => {
    const connection = new FakeConnection();
    const session = new QwpEgressSession(connection);
    connection.receive(serverInfo());
    await expect(session.ready).resolves.toMatchObject({
      kind: "server-info",
      clusterId: "cluster",
    });

    const query = await session.query("select * from x");
    const request = new QwpByteReader(connection.sent[0]);
    expect(request.readUint8()).toBe(QWP_EGRESS_MESSAGE.QUERY_REQUEST);
    expect(request.readBigUint64()).toBe(0n);
    const sqlLength = Number(readQwpVarint(request));
    expect(request.readUtf8(sqlLength)).toBe("select * from x");

    connection.receive(firstResultBatch());
    connection.receive(resultEnd());
    const batches = [];
    for await (const batch of query) batches.push(batch);
    expect(batches).toHaveLength(1);
    await expect(query.completion).resolves.toMatchObject({
      kind: "result-end",
      totalRows: 3n,
    });
    await session.close();
  });

  it("silently omits resetDictionary when QUERY_FLAGS is unavailable", async () => {
    const captureRequest = async (
      capabilities: number,
      resetDictionary: boolean,
    ): Promise<Uint8Array> => {
      const connection = new FakeConnection();
      const session = new QwpEgressSession(connection);
      connection.receive(serverInfo(capabilities));
      const query = await session.query("select 1", { resetDictionary });
      connection.receive(resultEnd(query.requestId, 0n));
      await query.completion;
      await session.close();
      return connection.sent[0];
    };

    const legacyBaseline = await captureRequest(0, false);
    const legacyReset = await captureRequest(0, true);
    expect(legacyReset).toEqual(legacyBaseline);

    const capableBaseline = await captureRequest(
      QWP_EGRESS_CAPABILITY.QUERY_FLAGS,
      false,
    );
    const capableReset = await captureRequest(
      QWP_EGRESS_CAPABILITY.QUERY_FLAGS,
      true,
    );
    expect(capableReset).toHaveLength(capableBaseline.byteLength + 1);
    expect(capableReset.subarray(0, capableBaseline.byteLength)).toEqual(
      capableBaseline,
    );
    expect(capableReset.at(-1)).toBe(QWP_QUERY_FLAG_RESET_DICTIONARY);
  });

  it("automatically replenishes credit after the consumer advances", async () => {
    const connection = new FakeConnection();
    const session = new QwpEgressSession(connection);
    connection.receive(serverInfo());
    const query = await session.query("select * from x", {
      initialCredit: 64,
    });
    const resultFrame = firstResultBatch(query.requestId);
    connection.receive(resultFrame);

    const iterator = query[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.rowCount).toBe(3);
    expect(connection.sent).toHaveLength(1);

    const next = iterator.next();
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2));
    const credit = new QwpByteReader(connection.sent[1]);
    expect(credit.readUint8()).toBe(QWP_EGRESS_MESSAGE.CREDIT);
    expect(credit.readBigUint64()).toBe(query.requestId);
    expect(readQwpVarint(credit)).toBe(BigInt(resultFrame.byteLength));
    expect(credit.remaining).toBe(0);

    connection.receive(resultEnd(query.requestId));
    await expect(next).resolves.toEqual({ value: undefined, done: true });
    await query.completion;
    await session.close();
  });

  it("bounds reusable views to an awaited callback and then replenishes credit", async () => {
    const connection = new FakeConnection();
    const session = new QwpEgressSession(connection);
    connection.receive(serverInfo());

    let enterHandler!: () => void;
    const handlerEntered = new Promise<void>((resolve) => {
      enterHandler = resolve;
    });
    let releaseHandler!: () => void;
    const handlerReleased = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let delivered: QwpResultBatchView | undefined;
    let retainedRows: readonly (readonly unknown[])[] = [];
    const query = await session.queryViews(
      "select * from x",
      async (batch, control) => {
        delivered = batch;
        expect(control.requestId).toBe(batch.requestId);
        expect(batch.valid).toBe(true);
        expect(batch.column(0).getInt(2)).toBe(9);
        retainedRows = [...batch.materialize().rows()];
        enterHandler();
        await handlerReleased;
        expect(batch.valid).toBe(true);
      },
      { initialCredit: 64 },
    );
    const resultFrame = firstResultBatch(query.requestId);
    connection.receive(resultFrame);

    await handlerEntered;
    expect(connection.sent).toHaveLength(1);
    releaseHandler();
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2));
    expect(delivered!.valid).toBe(false);
    expect(() => delivered!.column(0)).toThrow(/no longer valid/i);
    expect(retainedRows[2]).toEqual([9, "", "alpha", 300n]);

    const credit = new QwpByteReader(connection.sent[1]);
    expect(credit.readUint8()).toBe(QWP_EGRESS_MESSAGE.CREDIT);
    expect(credit.readBigUint64()).toBe(query.requestId);
    expect(readQwpVarint(credit)).toBe(BigInt(resultFrame.byteLength));
    connection.receive(resultEnd(query.requestId));
    await expect(query.completion).resolves.toMatchObject({ totalRows: 3n });
    await session.close();
  });

  it("decodes reusable views ahead through a bounded slot pool", async () => {
    const decodeView = vi.spyOn(QwpResultBatchDecoder.prototype, "decodeView");
    const connection = new FakeConnection();
    const session = new QwpEgressSession(connection, {
      initialCredit: 0,
      bufferPoolSize: 2,
    });
    connection.receive(serverInfo());

    const entered: number[] = [];
    const releases: Array<() => void> = [];
    const delivered: QwpResultBatchView[] = [];
    try {
      const query = await session.queryViews(
        "select * from x",
        async (batch) => {
          const sequence = Number(batch.batchSequence);
          delivered.push(batch);
          entered.push(sequence);
          await new Promise<void>((resolve) => {
            releases[sequence] = resolve;
          });
        },
      );

      connection.receive(emptyResultBatch(query.requestId, 0));
      connection.receive(emptyResultBatch(query.requestId, 1));
      connection.receive(emptyResultBatch(query.requestId, 2));
      connection.receive(resultEnd(query.requestId, 0n));

      await vi.waitFor(() => expect(decodeView).toHaveBeenCalledTimes(2));
      expect(entered).toEqual([0]);
      await Promise.resolve();
      expect(decodeView).toHaveBeenCalledTimes(2);

      releases[0]();
      await vi.waitFor(() => {
        expect(decodeView).toHaveBeenCalledTimes(3);
        expect(entered).toEqual([0, 1]);
      });

      releases[1]();
      await vi.waitFor(() => expect(entered).toEqual([0, 1, 2]));
      expect(new Set(delivered).size).toBe(2);

      releases[2]();
      await expect(query.completion).resolves.toMatchObject({ totalRows: 0n });
    } finally {
      decodeView.mockRestore();
      await session.close();
    }
  });

  it("cancels and drains when a result-view callback fails", async () => {
    const connection = new FakeConnection();
    const session = new QwpEgressSession(connection);
    connection.receive(serverInfo());
    const handlerError = new Error("consumer failed");
    let delivered: QwpResultBatchView | undefined;
    const query = await session.queryViews("select * from x", (batch) => {
      delivered = batch;
      throw handlerError;
    });

    connection.receive(firstResultBatch(query.requestId));
    await expect(query.completion).rejects.toBe(handlerError);
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2));
    expect(delivered!.valid).toBe(false);
    const cancel = new QwpByteReader(connection.sent[1]);
    expect(cancel.readUint8()).toBe(QWP_EGRESS_MESSAGE.CANCEL);
    expect(cancel.readBigUint64()).toBe(query.requestId);

    connection.receive(
      queryError(query.requestId, "cancelled by client", QWP_STATUS.CANCELLED),
    );
    await Promise.resolve();
    await Promise.resolve();
    const next = await session.query("select 2");
    connection.receive(resultEnd(next.requestId, 0n));
    await next.completion;
    await session.close();
  });

  it("keeps a query error ordered after an active result-view callback", async () => {
    const connection = new FakeConnection();
    const session = new QwpEgressSession(connection);
    connection.receive(serverInfo());

    let releaseHandler!: () => void;
    const handlerReleased = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let delivered: QwpResultBatchView | undefined;
    let enterHandler!: () => void;
    const handlerEntered = new Promise<void>((resolve) => {
      enterHandler = resolve;
    });
    const query = await session.queryViews("select * from x", async (batch) => {
      delivered = batch;
      enterHandler();
      await handlerReleased;
      expect(batch.valid).toBe(true);
    });

    connection.receive(firstResultBatch(query.requestId));
    connection.receive(queryError(query.requestId, "query failed"));
    await handlerEntered;

    await expect(session.query("select 2")).rejects.toThrow(
      "a QWP query is already active",
    );
    expect(delivered!.valid).toBe(true);

    releaseHandler();
    await expect(query.completion).rejects.toMatchObject({
      name: "QwpEgressQueryError",
      message: "query failed",
    });
    expect(delivered!.valid).toBe(false);

    const next = await session.query("select 2");
    connection.receive(resultEnd(next.requestId, 0n));
    await next.completion;
    await session.close();
  });

  it("does not clear the delta symbol dictionary under a live view callback", async () => {
    // A server-initiated CACHE_RESET cleared the connection symbol dictionary
    // in place immediately. Delta-mode views alias that array and resolve their
    // cells lazily, so a reset arriving mid-callback turned live SYMBOL cells to
    // undefined. The reset must drain in-flight views first, as its
    // client-initiated sibling does.
    const connection = new FakeConnection();
    const session = new QwpEgressSession(connection);
    connection.receive(serverInfo());

    let enterHandler!: () => void;
    const handlerEntered = new Promise<void>((resolve) => {
      enterHandler = resolve;
    });
    let releaseHandler!: () => void;
    const handlerReleased = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const before: unknown[] = [];
    const after: unknown[] = [];
    const query = await session.queryViews("select * from x", async (batch) => {
      // Column 2 is the delta SYMBOL column [alpha, beta] with ids [0, 1, 0].
      for (let row = 0; row < 3; row++)
        before.push(batch.row(row).getSymbol(2));
      enterHandler();
      await handlerReleased;
      for (let row = 0; row < 3; row++) after.push(batch.row(row).getSymbol(2));
    });

    connection.receive(firstResultBatch(query.requestId));
    await handlerEntered;

    // Inject the reset while the callback is parked reading the aliased dict.
    connection.receive(cacheReset(QWP_RESET_MASK_DICTIONARY));
    connection.receive(resultEnd(query.requestId, 3n));
    await Promise.resolve();
    await Promise.resolve();

    releaseHandler();
    await query.completion;

    expect(before).toEqual(["alpha", "beta", "alpha"]);
    expect(after).toEqual(["alpha", "beta", "alpha"]);
    await session.close();
  });

  it("defaults to Java-compatible unbounded credit and allows a bounded override", async () => {
    const connection = new FakeConnection();
    const session = new QwpEgressSession(connection);
    connection.receive(serverInfo());
    const query = await session.query("select * from x");
    const request = new QwpByteReader(connection.sent[0]);
    expect(request.readUint8()).toBe(QWP_EGRESS_MESSAGE.QUERY_REQUEST);
    expect(request.readBigUint64()).toBe(query.requestId);
    const sqlLength = Number(readQwpVarint(request));
    request.readBytes(sqlLength);
    expect(readQwpVarint(request)).toBe(
      BigInt(QWP_DEFAULT_EGRESS_INITIAL_CREDIT),
    );
    expect(QWP_DEFAULT_EGRESS_INITIAL_CREDIT).toBe(0);

    const resultFrame = firstResultBatch(query.requestId);
    connection.receive(resultFrame);
    const iterator = query[Symbol.asyncIterator]();
    await iterator.next();
    const next = iterator.next();
    await Promise.resolve();
    expect(connection.sent).toHaveLength(1);
    connection.receive(resultEnd(query.requestId));
    await next;
    await query.completion;
    await session.close();

    const boundedConnection = new FakeConnection();
    const bounded = new QwpEgressSession(boundedConnection, {
      initialCredit: 64,
    });
    boundedConnection.receive(serverInfo());
    const boundedQuery = await bounded.query("select 1");
    const boundedRequest = new QwpByteReader(boundedConnection.sent[0]);
    boundedRequest.readUint8();
    boundedRequest.readBigUint64();
    const boundedSqlLength = Number(readQwpVarint(boundedRequest));
    boundedRequest.readBytes(boundedSqlLength);
    expect(readQwpVarint(boundedRequest)).toBe(64n);
    boundedConnection.receive(resultEnd(boundedQuery.requestId));
    await boundedQuery.completion;
    await bounded.close();
  });

  it("bounds decoded materialized batches when wire credit is unbounded", async () => {
    const connection = new FakeConnection();
    const session = new QwpEgressSession(connection, {
      initialCredit: 0,
      bufferPoolSize: 2,
    });
    connection.receive(serverInfo());
    const query = await session.query("select * from x");
    connection.receive(emptyResultBatch(query.requestId, 0));
    connection.receive(emptyResultBatch(query.requestId, 1));
    connection.receive(emptyResultBatch(query.requestId, 2));
    connection.receive(resultEnd(query.requestId, 0n));

    let completed = false;
    void query.completion.then(() => {
      completed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toBe(false);

    const iterator = query[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await expect(query.completion).resolves.toMatchObject({ totalRows: 0n });
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
    expect(connection.sent).toHaveLength(1);
    await session.close();
  });

  it("interrupts a materialized-buffer wait during close", async () => {
    const connection = new FakeConnection();
    const session = new QwpEgressSession(connection, {
      initialCredit: 0,
      bufferPoolSize: 1,
    });
    connection.receive(serverInfo());
    const query = await session.query("select * from x");
    connection.receive(emptyResultBatch(query.requestId, 0));
    connection.receive(emptyResultBatch(query.requestId, 1));

    await expect(session.close()).resolves.toBeUndefined();
    await expect(query.completion).rejects.toMatchObject({
      name: "QwpEgressSessionClosedError",
    });
  });

  it("uses compressed RESULT_BATCH wire bytes for automatic credit", async () => {
    const connection = new FakeConnection();
    const session = new QwpEgressSession(connection);
    connection.receive(serverInfo());
    const query = await session.query("select 42", { initialCredit: 1 });
    const resultFrame = compressedIntResultBatch(query.requestId);
    connection.receive(resultFrame);

    const iterator = query[Symbol.asyncIterator]();
    await iterator.next();
    const next = iterator.next();
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2));
    const credit = new QwpByteReader(connection.sent[1]);
    expect(credit.readUint8()).toBe(QWP_EGRESS_MESSAGE.CREDIT);
    expect(credit.readBigUint64()).toBe(query.requestId);
    expect(readQwpVarint(credit)).toBe(BigInt(resultFrame.byteLength));

    connection.receive(resultEnd(query.requestId, 100n));
    await next;
    await query.completion;
    await session.close();
  });

  it("allows automatic credit replenishment to be disabled", async () => {
    const connection = new FakeConnection();
    const session = new QwpEgressSession(connection);
    connection.receive(serverInfo());
    const query = await session.query("select * from x", {
      initialCredit: 64,
      autoCredit: false,
    });
    connection.receive(firstResultBatch(query.requestId));

    const iterator = query[Symbol.asyncIterator]();
    await iterator.next();
    const next = iterator.next();
    await Promise.resolve();
    expect(connection.sent).toHaveLength(1);

    await query.grantCredit(64);
    expect(connection.sent).toHaveLength(2);
    connection.receive(resultEnd(query.requestId));
    await next;
    await query.completion;
    await session.close();
  });

  it("cancels and retires a query when result iteration is abandoned", async () => {
    const connection = new FakeConnection();
    const session = new QwpEgressSession(connection);
    connection.receive(serverInfo());
    const query = await session.query("select * from x", {
      initialCredit: 64,
    });
    const resultFrame = firstResultBatch(query.requestId);
    connection.receive(resultFrame);

    let batches = 0;
    for await (const _batch of query) {
      batches++;
      break;
    }

    expect(batches).toBe(1);
    await expect(query.completion).rejects.toMatchObject({
      name: "QwpEgressQueryAbandonedError",
      requestId: query.requestId,
    } satisfies Partial<QwpEgressQueryAbandonedError>);
    expect(connection.sent).toHaveLength(3);
    const cancel = new QwpByteReader(connection.sent[1]);
    expect(cancel.readUint8()).toBe(QWP_EGRESS_MESSAGE.CANCEL);
    expect(cancel.readBigUint64()).toBe(query.requestId);
    const credit = new QwpByteReader(connection.sent[2]);
    expect(credit.readUint8()).toBe(QWP_EGRESS_MESSAGE.CREDIT);
    expect(credit.readBigUint64()).toBe(query.requestId);
    expect(readQwpVarint(credit)).toBe(BigInt(resultFrame.byteLength));

    await expect(session.query("select 2")).rejects.toThrow(
      "a QWP query is already active",
    );
    connection.receive(
      queryError(query.requestId, "cancelled by client", QWP_STATUS.CANCELLED),
    );
    await Promise.resolve();
    await Promise.resolve();
    const nextQuery = await session.query("select 2");
    connection.receive(resultEnd(nextQuery.requestId, 0n));
    await nextQuery.completion;
    await session.close();
  });

  it("bounds completion waiting without cancelling the query", async () => {
    vi.useFakeTimers();
    try {
      const connection = new FakeConnection();
      const session = new QwpEgressSession(connection);
      connection.receive(serverInfo());
      const query = await session.query("select * from slow_table");

      expect(query.isDone()).toBe(false);
      await expect(query.awaitCompletion(0)).resolves.toBe(false);
      const waiting = query.awaitCompletion(25);
      await vi.advanceTimersByTimeAsync(25);
      await expect(waiting).resolves.toBe(false);
      expect(query.isDone()).toBe(false);
      expect(connection.sent).toHaveLength(1);
      await expect(session.query("select 2")).rejects.toThrow(
        "a QWP query is already active",
      );

      connection.receive(resultEnd(query.requestId, 0n));
      await query.completion;
      expect(query.isDone()).toBe(true);
      await expect(query.awaitCompletion(0)).resolves.toBe(true);
      expect(connection.sent).toHaveLength(1);
      await expect(query.awaitCompletion(-1)).rejects.toThrow(
        "completion timeoutMs must be a non-negative finite number",
      );

      const failed = await session.query("broken sql");
      const failureWait = failed.awaitCompletion(25);
      connection.receive(queryError(failed.requestId, "bad syntax"));
      await expect(failureWait).rejects.toMatchObject({
        name: "QwpEgressQueryError",
        message: "bad syntax",
      });
      expect(failed.isDone()).toBe(true);
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a query, sends CANCEL, and drains the terminal response", async () => {
    vi.useFakeTimers();
    try {
      const connection = new FakeConnection();
      const session = new QwpEgressSession(connection, {
        queryTimeoutMs: 25,
      });
      connection.receive(serverInfo());
      const query = await session.query(
        "select * from long_sequence(1000000)",
        {
          initialCredit: 64,
        },
      );
      const next = query[Symbol.asyncIterator]()
        .next()
        .catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(25);

      await expect(next).resolves.toMatchObject({
        name: "QwpEgressQueryTimeoutError",
        requestId: query.requestId,
        timeoutMs: 25,
      } satisfies Partial<QwpEgressQueryTimeoutError>);
      await expect(query.completion).rejects.toBeInstanceOf(
        QwpEgressQueryTimeoutError,
      );
      expect(connection.sent).toHaveLength(2);
      const cancel = new QwpByteReader(connection.sent[1]);
      expect(cancel.readUint8()).toBe(QWP_EGRESS_MESSAGE.CANCEL);
      expect(cancel.readBigUint64()).toBe(query.requestId);
      expect(cancel.remaining).toBe(0);

      await expect(session.query("select 2")).rejects.toThrow(
        "a QWP query is already active",
      );
      const lateBatch = firstResultBatch(query.requestId);
      connection.receive(lateBatch);
      await vi.waitFor(() => expect(connection.sent).toHaveLength(3));
      const drainCredit = new QwpByteReader(connection.sent[2]);
      expect(drainCredit.readUint8()).toBe(QWP_EGRESS_MESSAGE.CREDIT);
      expect(drainCredit.readBigUint64()).toBe(query.requestId);
      expect(readQwpVarint(drainCredit)).toBe(BigInt(lateBatch.byteLength));
      connection.receive(
        queryError(
          query.requestId,
          "cancelled by client",
          QWP_STATUS.CANCELLED,
        ),
      );
      await Promise.resolve();
      await Promise.resolve();

      const nextQuery = await session.query("select 2", { timeoutMs: 0 });
      connection.receive(resultEnd(nextQuery.requestId, 0n));
      await nextQuery.completion;
      expect(vi.getTimerCount()).toBe(0);
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails and closes a session when cancellation never terminates", async () => {
    vi.useFakeTimers();
    try {
      const connection = new FakeConnection();
      const session = new QwpEgressSession(connection, {
        queryTimeoutMs: 25,
        cancelDrainTimeoutMs: 50,
      });
      connection.receive(serverInfo());
      const query = await session.query("select * from long_sequence(1000000)");

      await vi.advanceTimersByTimeAsync(25);
      await expect(query.completion).rejects.toBeInstanceOf(
        QwpEgressQueryTimeoutError,
      );
      await vi.advanceTimersByTimeAsync(50);

      expect(connection.closeCalls).toEqual([
        { code: 1011, reason: "QWP cancellation drain timed out" },
      ]);
      await expect(session.query("select 2")).rejects.toMatchObject({
        name: "QwpEgressQueryCancelTimeoutError",
        requestId: query.requestId,
        timeoutMs: 50,
      } satisfies Partial<QwpEgressQueryCancelTimeoutError>);
      expect(vi.getTimerCount()).toBe(0);
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a query deadline when the query completes", async () => {
    vi.useFakeTimers();
    try {
      const connection = new FakeConnection();
      const session = new QwpEgressSession(connection);
      connection.receive(serverInfo());
      const query = await session.query("select 1", { timeoutMs: 25 });
      connection.receive(resultEnd(query.requestId, 0n));
      await query.completion;
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(25);
      expect(connection.sent).toHaveLength(1);
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("streams a Zstd-compressed result through the high-level session", async () => {
    const connection = new FakeConnection();
    const session = new QwpEgressSession(connection);
    connection.receive(serverInfo());
    const query = await session.query("select 42");

    connection.receive(compressedIntResultBatch(query.requestId));
    connection.receive(resultEnd(query.requestId, 100n));
    const batches = [];
    for await (const batch of query) batches.push(batch);

    expect(batches).toHaveLength(1);
    expect(batches[0].rowCount).toBe(100);
    expect(batches[0].get(99, 0)).toBe(42);
    await expect(query.completion).resolves.toMatchObject({ totalRows: 100n });
    await session.close();
  });

  it("surfaces QUERY_ERROR to iteration and completion", async () => {
    const connection = new FakeConnection();
    const session = new QwpEgressSession(connection);
    connection.receive(serverInfo());
    const query = await session.query("broken sql");
    connection.receive(queryError(query.requestId, "bad syntax"));

    const next = query[Symbol.asyncIterator]().next();
    await expect(next).rejects.toMatchObject({
      name: "QwpEgressQueryError",
      status: QWP_STATUS.PARSE_ERROR,
      message: "bad syntax",
    } satisfies Partial<QwpEgressQueryError>);
    await expect(query.completion).rejects.toBeInstanceOf(QwpEgressQueryError);
    await session.close();
  });
});
