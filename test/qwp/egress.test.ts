import { describe, expect, it } from "vitest";
import {
  decodeQwpEgressMessage,
  encodeQwpFrame,
  encodeQwpGorilla,
  QWP_COLUMN_TYPE,
  QWP_EGRESS_CAPABILITY,
  QWP_EGRESS_MESSAGE,
  QWP_FLAG_DELTA_SYMBOL_DICTIONARY,
  QWP_FLAG_GORILLA,
  QWP_STATUS,
  QwpBinaryConnection,
  QwpByteReader,
  QwpByteWriter,
  QwpConnectionCloseInfo,
  QwpEgressQueryError,
  QwpEgressSession,
  QwpResultBatchDecoder,
  readQwpVarint,
  writeQwpVarint,
} from "../../src/qwp";
import { QwpAsyncQueue } from "../../src/qwp/internal/async-queue";

const RESULT_FLAGS = QWP_FLAG_DELTA_SYMBOL_DICTIONARY | QWP_FLAG_GORILLA;

function writeString(writer: QwpByteWriter, value: string): void {
  const bytes = new TextEncoder().encode(value);
  writeQwpVarint(writer, bytes.length);
  writer.writeBytes(bytes);
}

function writeU16String(writer: QwpByteWriter, value: string): void {
  const bytes = new TextEncoder().encode(value);
  writer.writeUint16(bytes.length).writeBytes(bytes);
}

function serverInfo(): Uint8Array {
  const payload = new QwpByteWriter();
  payload
    .writeUint8(QWP_EGRESS_MESSAGE.SERVER_INFO)
    .writeUint8(0)
    .writeBigUint64(1n)
    .writeUint32(QWP_EGRESS_CAPABILITY.QUERY_FLAGS)
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

function resultEnd(requestId = 0n): Uint8Array {
  const payload = new QwpByteWriter();
  payload.writeUint8(QWP_EGRESS_MESSAGE.RESULT_END).writeBigUint64(requestId);
  writeQwpVarint(payload, 1);
  writeQwpVarint(payload, 3);
  return encodeQwpFrame(payload.toUint8Array());
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

function queryError(requestId: bigint, message: string): Uint8Array {
  const bytes = new TextEncoder().encode(message);
  const payload = new QwpByteWriter();
  payload
    .writeUint8(QWP_EGRESS_MESSAGE.QUERY_ERROR)
    .writeBigUint64(requestId)
    .writeUint8(QWP_STATUS.PARSE_ERROR)
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
  readonly closed: Promise<QwpConnectionCloseInfo>;

  constructor() {
    let resolve!: (info: QwpConnectionCloseInfo) => void;
    this.closed = new Promise((res) => {
      resolve = res;
    });
    this.resolveClosed = resolve;
  }

  send(payload: Uint8Array): Promise<void> {
    this.sent.push(payload.slice());
    return Promise.resolve();
  }

  close(code = 1000, reason = ""): Promise<void> {
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
});

describe("QwpEgressSession", () => {
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
