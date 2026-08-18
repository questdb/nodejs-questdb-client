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
  QWP_MAX_ZSTD_DECOMPRESSED_SIZE,
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
  readQwpVarint,
  writeQwpVarint,
} from "../../src/qwp";
import { QwpAsyncQueue } from "../../src/qwp/internal/async-queue";

const RESULT_FLAGS = QWP_FLAG_DELTA_SYMBOL_DICTIONARY | QWP_FLAG_GORILLA;

// One standard Zstd frame with a declared 409-byte content size and an actual
// compressed block. Its body is a 100-row QWP table of INT values equal to 42.
const COMPRESSED_INT_RESULT_BODY = Uint8Array.from([
  40, 181, 47, 253, 96, 153, 0, 157, 0, 0, 96, 0, 0, 0, 100, 1, 1, 120, 4, 0,
  42, 0, 0, 1, 0, 138, 171, 46, 9,
]);

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

function resultEnd(requestId = 0n, totalRows = 3n): Uint8Array {
  const payload = new QwpByteWriter();
  payload.writeUint8(QWP_EGRESS_MESSAGE.RESULT_END).writeBigUint64(requestId);
  writeQwpVarint(payload, 1);
  writeQwpVarint(payload, totalRows);
  return encodeQwpFrame(payload.toUint8Array());
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
  status = QWP_STATUS.PARSE_ERROR,
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
