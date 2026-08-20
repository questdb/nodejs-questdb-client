import { describe, expect, it } from "vitest";
import {
  QWP_COLUMN_TYPE,
  QWP_STATUS,
  QwpIngressEncodeOptions,
  QwpIngressResponse,
  QwpSender,
  QwpSenderCloseTimeoutError,
  QwpSenderSession,
  QwpTableBuffer,
  QwpWriterRowError,
  bool,
  byte,
  designatedTimestamp,
  double,
  encodeQwpIngressFrame,
  float32,
  float64,
  int32,
  int64,
  long,
  short,
  symbol as qwpSymbol,
  timestamp,
  varchar,
} from "../../src/qwp";

class RecordingSession implements QwpSenderSession {
  readonly sends: {
    tables: readonly QwpTableBuffer[];
    options?: QwpIngressEncodeOptions;
  }[] = [];
  readonly durable: QwpIngressResponse[] = [];
  deltaSendCount = 0;
  publicationCount = 0;
  closeCount = 0;
  publishedFrameSequence = -1n;
  acknowledgedFrameSequence = -1n;

  async sendTables(
    tables: readonly QwpTableBuffer[],
    options?: QwpIngressEncodeOptions,
  ): Promise<QwpIngressResponse> {
    this.sends.push({ tables, options });
    const sequence = ++this.publishedFrameSequence;
    this.acknowledgedFrameSequence = sequence;
    return {
      status: QWP_STATUS.OK,
      sequence,
      tables: tables.map((table) => ({
        name: table.name,
        sequenceTransaction: BigInt(table.rowCount),
      })),
    };
  }

  sendTablesDelta(
    tables: readonly QwpTableBuffer[],
    options?: Pick<QwpIngressEncodeOptions, "gorilla" | "deferCommit">,
  ): Promise<QwpIngressResponse> {
    this.deltaSendCount++;
    return this.sendTables(tables, options);
  }

  async publishTables(
    tables: readonly QwpTableBuffer[],
    options?: QwpIngressEncodeOptions,
  ): Promise<void> {
    this.publicationCount++;
    this.sends.push({ tables, options });
    const sequence = ++this.publishedFrameSequence;
    if (!options?.deferCommit) this.acknowledgedFrameSequence = sequence;
  }

  async publishTablesDelta(
    tables: readonly QwpTableBuffer[],
    options?: Pick<QwpIngressEncodeOptions, "gorilla" | "deferCommit">,
  ): Promise<void> {
    this.deltaSendCount++;
    await this.publishTables(tables, options);
  }

  async waitForDurable(response: QwpIngressResponse): Promise<void> {
    this.durable.push(response);
  }

  async close(): Promise<void> {
    this.closeCount++;
  }
}

class CommitAwareSession extends RecordingSession {
  private readonly deferred: {
    resolve: (response: QwpIngressResponse) => void;
  }[] = [];

  override sendTables(
    tables: readonly QwpTableBuffer[],
    options?: QwpIngressEncodeOptions,
  ): Promise<QwpIngressResponse> {
    this.sends.push({ tables, options });
    const sequence = ++this.publishedFrameSequence;
    const response = {
      status: QWP_STATUS.OK,
      sequence,
      tables: tables.map((table) => ({
        name: table.name,
        sequenceTransaction: BigInt(table.rowCount),
      })),
    } satisfies QwpIngressResponse;
    if (options?.deferCommit) {
      return new Promise((resolve) => this.deferred.push({ resolve }));
    }
    this.acknowledgedFrameSequence = sequence;
    for (const pending of this.deferred.splice(0)) pending.resolve(response);
    return Promise.resolve(response);
  }
}

class ClosingUnblocksSession extends RecordingSession {
  private rejectSend?: (error: Error) => void;

  sendTables(
    tables: readonly QwpTableBuffer[],
    options?: QwpIngressEncodeOptions,
  ): Promise<QwpIngressResponse> {
    this.sends.push({ tables, options });
    return new Promise((_resolve, reject) => {
      this.rejectSend = reject;
    });
  }

  async close(): Promise<void> {
    this.closeCount++;
    this.rejectSend?.(new Error("session closed"));
  }
}

class PublishingSession extends RecordingSession {
  publicationAttempts = 0;
  failPublication = false;

  async publishTables(
    tables: readonly QwpTableBuffer[],
    options?: QwpIngressEncodeOptions,
  ): Promise<void> {
    this.publicationAttempts++;
    this.sends.push({ tables, options });
    if (this.failPublication) throw new Error("journal is full");
    this.publishedFrameSequence++;
  }

  publishTablesDelta(
    tables: readonly QwpTableBuffer[],
    options?: Pick<QwpIngressEncodeOptions, "gorilla" | "deferCommit">,
  ): Promise<void> {
    this.deltaSendCount++;
    return this.publishTables(tables, options);
  }

  async waitForAcknowledged(target: bigint): Promise<void> {
    if (target > this.acknowledgedFrameSequence) {
      this.acknowledgedFrameSequence = target;
    }
  }
}

class WatermarkSession extends PublishingSession {
  private readonly waiters = new Set<{
    target: bigint;
    resolve: () => void;
  }>();

  waitForAcknowledged(target: bigint): Promise<void> {
    if (target < 0n || this.acknowledgedFrameSequence >= target) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.add({ target, resolve }));
  }

  acknowledgeThrough(sequence: bigint): void {
    this.acknowledgedFrameSequence = sequence;
    for (const waiter of this.waiters) {
      if (waiter.target > sequence) continue;
      this.waiters.delete(waiter);
      waiter.resolve();
    }
  }
}

class DeferredWatermarkSession extends PublishingSession {
  override sendTablesDelta(
    tables: readonly QwpTableBuffer[],
    options?: Pick<QwpIngressEncodeOptions, "gorilla" | "deferCommit">,
  ): Promise<QwpIngressResponse> {
    if (!options?.deferCommit) return super.sendTablesDelta(tables, options);
    this.deltaSendCount++;
    this.sends.push({ tables, options });
    this.publishedFrameSequence++;
    return new Promise<QwpIngressResponse>(() => undefined);
  }
}

function column(table: QwpTableBuffer, name: string) {
  const result = table.columns.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`missing column '${name}'`);
  return result;
}

describe("QWP high-level sender", () => {
  it("uses the Java-compatible local-publication flush boundary by default", async () => {
    const session = new PublishingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });
    await sender.table("events").longColumn("value", 42n).atNow();

    await expect(sender.flush()).resolves.toBe(true);
    expect(session.publicationAttempts).toBe(1);
    expect(session.acknowledgedFrameSequence).toBe(-1n);
    expect(sender.publishedSequence).toBe(0n);
    expect(sender.acknowledgedSequence).toBe(-1n);

    session.acknowledgedFrameSequence = 0n;
    await sender.close();
  });

  it("retains explicit server-ACK flush behavior", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, {
      autoFlush: false,
      awaitServerAck: true,
    });
    await sender.table("events").longColumn("value", 42n).atNow();

    await expect(sender.flush()).resolves.toBe(true);
    expect(session.deltaSendCount).toBe(1);
    expect(session.publicationCount).toBe(0);
    expect(sender.acknowledgedSequence).toBe(0n);
    await sender.close();
  });

  it("validates the byte auto-flush threshold", () => {
    const session = new RecordingSession();
    expect(
      () =>
        new QwpSender(async () => session, {
          autoFlushBytes: -1,
        }),
    ).toThrow(/autoFlushBytes must be a non-negative safe integer/);
    expect(
      () =>
        new QwpSender(async () => session, {
          autoFlushBytes: 1.5,
        }),
    ).toThrow(/autoFlushBytes must be a non-negative safe integer/);
  });

  it("validates the close flush timeout", () => {
    const session = new RecordingSession();
    expect(
      () =>
        new QwpSender(async () => session, {
          closeFlushTimeoutMs: -1,
        }),
    ).toThrow(/closeFlushTimeoutMs must be a non-negative safe integer/);
    expect(
      () =>
        new QwpSender(async () => session, {
          closeFlushTimeoutMs: 1.5,
        }),
    ).toThrow(/closeFlushTimeoutMs must be a non-negative safe integer/);
  });

  it("applies a configurable Java-compatible identifier length", async () => {
    const session = new RecordingSession();
    expect(
      () => new QwpSender(async () => session, { maxNameLength: 15 }),
    ).toThrow(/maxNameLength must be a safe integer of at least 16/);

    const defaultSender = new QwpSender(async () => session);
    expect(() => defaultSender.table("t".repeat(128))).toThrow(
      /table name too long.*maxLength=127/,
    );
    await defaultSender.close();

    const sender = new QwpSender(async () => session, {
      autoFlush: false,
      maxNameLength: 256,
    });
    await sender
      .table("t".repeat(128))
      .longColumn("c".repeat(128), 42n)
      .atNow();
    await sender.flush();
    expect(session.sends.at(-1)?.tables[0].name).toHaveLength(128);
    expect(session.sends.at(-1)?.tables[0].columns[0].name).toHaveLength(128);
    await sender.close();
  });

  it("uses case-insensitive column identity in the fluent sender", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });

    await sender
      .table("events")
      .longColumn("Value", 1n)
      .longColumn("VALUE", 99n)
      .atNow();
    await sender.table("events").longColumn("value", 2n).atNow();
    await sender.flush();

    const table = session.sends[0].tables[0];
    expect(table.columns).toHaveLength(1);
    expect(column(table, "Value").values).toEqual([1n, 2n]);
    expect(() => column(table, "VALUE")).toThrow(/missing column/);
    await sender.close();
  });

  it("rejects illegal identifiers before publishing", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });

    expect(() => sender.table("bad/table")).toThrow(
      /table name contains illegal characters/,
    );
    expect(() => sender.table("events").longColumn("bad-column", 1n)).toThrow(
      /column name contains illegal characters/,
    );
    expect(session.sends).toHaveLength(0);
    await sender.close();
  });

  it("returns a publication sequence and waits for its ACK independently", async () => {
    const session = new WatermarkSession();
    const sender = new QwpSender(async () => session, {
      autoFlush: false,
      awaitServerAck: true,
    });
    await sender.table("events").longColumn("value", 42n).atNow();

    await expect(sender.flushAndGetSequence()).resolves.toBe(0n);
    expect(sender.publishedSequence).toBe(0n);
    expect(sender.acknowledgedSequence).toBe(-1n);

    let acknowledged = false;
    const waiting = sender.waitForAcknowledged(0n, 1_000).then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);

    session.acknowledgeThrough(0n);
    await waiting;
    expect(sender.acknowledgedSequence).toBe(0n);
    await expect(sender.flushAndGetSequence()).resolves.toBe(-1n);
    await sender.close();
  });

  it("returns the commit sequence without awaiting deferred transaction ACKs", async () => {
    const session = new DeferredWatermarkSession();
    const sender = new QwpSender(async () => session, {
      autoFlushRows: 1,
      autoFlushIntervalMs: 0,
      awaitServerAck: true,
      transactional: true,
    });

    await sender.table("events").longColumn("value", 42n).atNow();
    expect(sender.publishedSequence).toBe(0n);
    await expect(sender.flushAndGetSequence()).resolves.toBe(1n);
    expect(session.sends[1]).toMatchObject({
      tables: [],
      options: { deferCommit: false },
    });
    await sender.close();
  });

  it("retains rows until publication-only flush succeeds", async () => {
    const session = new PublishingSession();
    const sender = new QwpSender(async () => session, {
      autoFlush: false,
      awaitServerAck: false,
    });
    await sender.table("events").longColumn("value", 42n).atNow();

    session.failPublication = true;
    await expect(sender.flush()).rejects.toThrow("journal is full");
    expect(sender.metrics).toMatchObject({
      pendingRows: 1,
      totalRowsPublished: 0,
      totalFlushFailures: 1,
    });

    session.failPublication = false;
    await expect(sender.flush()).resolves.toBe(true);
    expect(session.publicationAttempts).toBe(2);
    expect(session.deltaSendCount).toBe(2);
    expect(sender.metrics).toMatchObject({
      pendingRows: 0,
      totalRowsPublished: 1,
      totalFlushes: 2,
    });
    await sender.close();
  });

  it("publishes transactional auto-flushes without waiting for ACKs", async () => {
    const session = new PublishingSession();
    const sender = new QwpSender(async () => session, {
      autoFlushRows: 1,
      autoFlushIntervalMs: 0,
      awaitServerAck: false,
      transactional: true,
    });

    await sender.table("events").longColumn("value", 1n).atNow();
    expect(session.sends[0].options).toMatchObject({ deferCommit: true });
    expect(sender.metrics).toMatchObject({
      deferredRows: 1,
      pendingRows: 0,
    });

    await expect(sender.commit()).resolves.toBe(true);
    expect(session.sends[1].options).toMatchObject({ deferCommit: false });
    expect(session.sends[1].tables).toEqual([]);
    expect(sender.metrics).toMatchObject({
      deferredRows: 0,
      totalTransactionsCommitted: 1,
    });
    await sender.close();
  });

  it("bounds an in-flight flush before closing its session", async () => {
    const session = new ClosingUnblocksSession();
    const sender = new QwpSender(async () => session, {
      autoFlush: false,
      awaitServerAck: true,
      closeFlushTimeoutMs: 10,
    });
    await sender.table("events").longColumn("value", 42n).atNow();
    const flushing = sender.flush().catch((error: unknown) => error);
    await Promise.resolve();

    await expect(sender.close()).rejects.toBeInstanceOf(
      QwpSenderCloseTimeoutError,
    );
    await expect(flushing).resolves.toEqual(
      expect.objectContaining({ message: "session closed" }),
    );
    expect(session.closeCount).toBe(1);
    expect(sender.metrics.totalFlushFailures).toBe(1);
    expect(sender.metrics.connected).toBe(false);
  });

  it("publishes completed rows and drains their ACK on close", async () => {
    const session = new WatermarkSession();
    const sender = new QwpSender(async () => session, {
      autoFlush: false,
      closeFlushTimeoutMs: 1_000,
    });
    await sender.table("events").longColumn("value", 42n).atNow();

    let closed = false;
    const closing = sender.close().then(() => {
      closed = true;
    });
    await expect.poll(() => session.sends.length).toBe(1);
    expect(session.sends[0].tables[0].rowCount).toBe(1);
    expect(sender.metrics.pendingRows).toBe(0);
    expect(closed).toBe(false);

    session.acknowledgeThrough(0n);
    await closing;
    expect(session.closeCount).toBe(1);
    expect(sender.metrics.closed).toBe(true);
  });

  it("closes and reports when the close ACK drain times out", async () => {
    const session = new WatermarkSession();
    const sender = new QwpSender(async () => session, {
      autoFlush: false,
      closeFlushTimeoutMs: 10,
    });
    await sender.table("events").longColumn("value", 42n).atNow();

    await expect(sender.close()).rejects.toMatchObject({
      name: "QwpSenderCloseTimeoutError",
      timeoutMs: 10,
      targetSequence: 0n,
      acknowledgedSequence: -1n,
    } satisfies Partial<QwpSenderCloseTimeoutError>);
    expect(session.sends).toHaveLength(1);
    expect(session.closeCount).toBe(1);
    expect(sender.metrics).toMatchObject({
      pendingRows: 0,
      connected: false,
      closed: true,
    });
  });

  it("publishes on close without draining when the timeout is zero", async () => {
    const session = new WatermarkSession();
    const sender = new QwpSender(async () => session, {
      autoFlush: false,
      closeFlushTimeoutMs: 0,
    });
    await sender.table("events").longColumn("value", 42n).atNow();

    await expect(sender.close()).resolves.toBeUndefined();
    expect(session.sends).toHaveLength(1);
    expect(session.acknowledgedFrameSequence).toBe(-1n);
    expect(session.closeCount).toBe(1);
  });

  it("uses the existing Sender fluent API and preserves an unfinished row", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });

    await sender
      .table("trades")
      .symbol("symbol", "ETH-USD")
      .floatColumn("price", 2_615.54)
      .intColumn("amount", 2)
      .at(1_700_000_000_000, "ms");
    sender.table("trades").intColumn("amount", 3);

    await expect(sender.flush()).resolves.toBe(true);
    expect(session.sends).toHaveLength(1);
    expect(session.deltaSendCount).toBe(1);
    const first = session.sends[0].tables[0];
    expect(first.name).toBe("trades");
    expect(first.rowCount).toBe(1);
    expect(column(first, "symbol")).toMatchObject({
      type: QWP_COLUMN_TYPE.SYMBOL,
      values: ["ETH-USD"],
    });
    expect(column(first, "price")).toMatchObject({
      type: QWP_COLUMN_TYPE.DOUBLE,
      values: [2_615.54],
    });
    expect(column(first, "amount")).toMatchObject({
      type: QWP_COLUMN_TYPE.LONG,
      values: [2n],
    });
    expect(column(first, "")).toMatchObject({
      type: QWP_COLUMN_TYPE.TIMESTAMP,
      values: [1_700_000_000_000_000n],
    });

    await sender.atNow();
    await expect(sender.flush()).resolves.toBe(true);
    expect(session.sends[1].tables[0].rowCount).toBe(1);
    expect(column(session.sends[1].tables[0], "amount").values).toEqual([3n]);
    await sender.close();
    expect(session.closeCount).toBe(1);
  });

  it("supports QWP-specific types without exposing QwpTableBuffer", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });

    await sender
      .table("typed")
      .byteColumn("byte_value", 7)
      .shortColumn("short_value", 12_000)
      .int32Column("int_value", 2_000_000)
      .longColumn("long_value", 9_000_000_000n)
      .float32Column("float_value", 1.5)
      .doubleColumn("double_value", 2.5)
      .longArrayColumn("longs", [1n, 2n, 3n])
      .binaryColumn("bytes", Uint8Array.of(1, 2, 3))
      .charColumn("letter", "Q")
      .decimalColumnText("price", "123.4500")
      .decimal64Column("precise_price", 1_234_500n, 4)
      .geohashColumn("location", 7n, 12)
      .dateColumn("created_date", 1_700_000_000_000n)
      .timestampColumn("created_ns", 1_700_000_000_123_456_789n, "ns")
      .uuidColumn("id", "123e4567-e89b-12d3-a456-426614174000")
      .long256Column("hash", 1n, 2n, 3n, 4n)
      .ipv4Column("ip", "192.168.0.1")
      .atNow();
    await sender.flush();

    const table = session.sends[0].tables[0];
    expect(column(table, "byte_value").type).toBe(QWP_COLUMN_TYPE.BYTE);
    expect(column(table, "short_value").type).toBe(QWP_COLUMN_TYPE.SHORT);
    expect(column(table, "int_value").type).toBe(QWP_COLUMN_TYPE.INT);
    expect(column(table, "long_value").type).toBe(QWP_COLUMN_TYPE.LONG);
    expect(column(table, "float_value").type).toBe(QWP_COLUMN_TYPE.FLOAT);
    expect(column(table, "double_value").type).toBe(QWP_COLUMN_TYPE.DOUBLE);
    expect(column(table, "longs").type).toBe(QWP_COLUMN_TYPE.LONG_ARRAY);
    expect(column(table, "bytes").type).toBe(QWP_COLUMN_TYPE.BINARY);
    expect(column(table, "letter").type).toBe(QWP_COLUMN_TYPE.CHAR);
    expect(column(table, "price")).toMatchObject({
      type: QWP_COLUMN_TYPE.DECIMAL256,
      decimalScale: 4,
      values: [1_234_500n],
    });
    expect(column(table, "precise_price")).toMatchObject({
      type: QWP_COLUMN_TYPE.DECIMAL64,
      decimalScale: 4,
    });
    expect(column(table, "location")).toMatchObject({
      type: QWP_COLUMN_TYPE.GEOHASH,
      geohashPrecision: 12,
    });
    expect(column(table, "created_ns")).toMatchObject({
      type: QWP_COLUMN_TYPE.TIMESTAMP_NANOS,
      values: [1_700_000_000_123_456_789n],
    });
    expect(column(table, "created_date").type).toBe(QWP_COLUMN_TYPE.DATE);
    expect(column(table, "id").type).toBe(QWP_COLUMN_TYPE.UUID);
    expect(column(table, "hash").type).toBe(QWP_COLUMN_TYPE.LONG256);
    expect(column(table, "ip")).toMatchObject({
      type: QWP_COLUMN_TYPE.IPV4,
      values: [0xc0a80001],
    });
    expect(() => encodeQwpIngressFrame([table])).not.toThrow();
  });

  it("rolls back the whole current row when a setter fails", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });

    sender.table("events").floatColumn("discarded", 1.5);
    expect(() => sender.stringColumn("bad", 42 as unknown as string)).toThrow(
      /only strings/,
    );
    await sender.longColumn("kept", 7n).atNow();
    await sender.flush();

    const table = session.sends[0].tables[0];
    expect(table.columns.map((item) => item.name)).toEqual(["kept"]);
  });

  it("compiles a typed table writer and appends object rows", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });
    const trades = sender.writer("trades", {
      symbol: qwpSymbol(),
      side: qwpSymbol(),
      venue: varchar(),
      active: bool(),
      flags: byte(),
      partition: short(),
      sequence: int32(),
      quantity: int64(),
      spread: float32(),
      price: float64(),
      received: timestamp("ms"),
      timestamp: designatedTimestamp("ns"),
    });

    await trades.row({
      symbol: "ETH-USD",
      side: "sell",
      venue: "LDN",
      active: true,
      flags: 1,
      partition: 2,
      sequence: 3,
      quantity: 42n,
      spread: 0.25,
      price: 2_615.54,
      received: 1_723_000_000_000,
      timestamp: 1_723_000_000_000_000_000n,
    });
    await trades.rows([
      {
        symbol: "BTC-USD",
        price: 39_269.98,
        timestamp: 1_723_000_001_000_000_000n,
      },
    ]);
    async function* moreRows() {
      yield {
        symbol: "SOL-USD",
        quantity: 7n,
        timestamp: 1_723_000_002_000_000_000n,
      };
    }
    await trades.rows(moreRows());

    expect(sender.metrics).toMatchObject({
      totalRowsStaged: 3,
      pendingRows: 3,
    });
    await sender.flush();

    const table = session.sends[0].tables[0];
    expect(table.name).toBe("trades");
    expect(table.rowCount).toBe(3);
    expect(column(table, "symbol")).toMatchObject({
      type: QWP_COLUMN_TYPE.SYMBOL,
      values: ["ETH-USD", "BTC-USD", "SOL-USD"],
      nulls: [false, false, false],
    });
    expect(column(table, "side")).toMatchObject({
      values: ["sell"],
      nulls: [false, true, true],
    });
    expect(column(table, "quantity")).toMatchObject({
      type: QWP_COLUMN_TYPE.LONG,
      values: [42n, 7n],
      nulls: [false, true, false],
    });
    // Widths are pinned deliberately: the fluent API's floatColumn() and
    // intColumn() are 64-bit, so the writer's names must not drift.
    expect(column(table, "spread")).toMatchObject({
      type: QWP_COLUMN_TYPE.FLOAT,
      values: [0.25],
    });
    expect(column(table, "price")).toMatchObject({
      type: QWP_COLUMN_TYPE.DOUBLE,
      values: [2_615.54, 39_269.98],
    });
    expect(column(table, "sequence")).toMatchObject({
      type: QWP_COLUMN_TYPE.INT,
      values: [3],
    });
    expect(column(table, "received")).toMatchObject({
      type: QWP_COLUMN_TYPE.TIMESTAMP,
      values: [1_723_000_000_000_000n],
    });
    expect(column(table, "")).toMatchObject({
      type: QWP_COLUMN_TYPE.TIMESTAMP_NANOS,
      values: [
        1_723_000_000_000_000_000n,
        1_723_000_001_000_000_000n,
        1_723_000_002_000_000_000n,
      ],
    });
  });

  it("maps width aliases onto the same column types", () => {
    expect(double()).toEqual(float64());
    expect(long()).toEqual(int64());
    expect(float32()).not.toEqual(float64());
    expect(int32()).not.toEqual(int64());
  });

  it("reports an open fluent row ahead of object-row validation", async () => {
    const sender = new QwpSender(async () => new RecordingSession(), {
      autoFlush: false,
    });
    const trades = sender.writer("trades", {
      price: double(),
      timestamp: designatedTimestamp("ns"),
    });

    sender.table("trades").symbol("side", "buy");
    // Both faults apply; the conflicting fluent row is the actionable one.
    await expect(
      trades.row({ price: "nope", timestamp: 1n } as never),
    ).rejects.toMatchObject({
      name: "QwpWriterRowError",
      columnName: undefined,
    });
    await expect(trades.row({ price: 1, timestamp: 1n })).rejects.toThrow(
      /a fluent row is already in progress/,
    );

    // Closing the fluent row hands the table back to the writer.
    await sender.at(5n, "ns");
    await trades.row({ price: 1, timestamp: 1n });
    expect(sender.metrics.pendingRows).toBe(2);
  });

  it("rejects invalid object rows without poisoning writer state", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });
    const trades = sender.writer("trades", {
      symbol: qwpSymbol(),
      price: double(),
      quantity: long(),
      timestamp: designatedTimestamp("ns"),
    });

    await expect(
      trades.row({
        symbol: "bad",
        price: "not-a-number",
        timestamp: 1n,
      } as never),
    ).rejects.toMatchObject({
      name: "QwpWriterRowError",
      tableName: "trades",
      columnName: "price",
      rowIndex: undefined,
    });
    expect(sender.metrics.pendingRows).toBe(0);

    await expect(
      trades.rows([
        { symbol: "ETH-USD", price: 2_615.54, timestamp: 2n },
        {
          symbol: "BTC-USD",
          price: 39_269.98,
          timestamp: undefined,
        } as never,
      ]),
    ).rejects.toMatchObject({
      name: "QwpWriterRowError",
      columnName: "timestamp",
      rowIndex: 1,
    });
    expect(sender.metrics.pendingRows).toBe(1);

    await trades.row({
      symbol: "SOL-USD",
      quantity: 7n,
      timestamp: 3n,
    });
    await sender.flush();
    const table = session.sends[0].tables[0];
    expect(table.rowCount).toBe(2);
    expect(column(table, "symbol").values).toEqual(["ETH-USD", "SOL-USD"]);
  });

  it("rejects unknown keys and invalid compiled schemas", async () => {
    const sender = new QwpSender(async () => new RecordingSession(), {
      autoFlush: false,
    });
    const trades = sender.writer("trades", {
      price: double(),
      timestamp: designatedTimestamp("ns"),
    });

    await expect(
      trades.row({ price: 1, timestamp: 1n, prise: 2 } as never),
    ).rejects.toMatchObject<QwpWriterRowError>({
      columnName: "prise",
      rowIndex: undefined,
    });
    expect(() =>
      sender.writer("trades", {
        timestamp: designatedTimestamp("ns"),
        received: designatedTimestamp("us"),
      }),
    ).toThrow(/more than one designated timestamp/);
    expect(() =>
      sender.writer("trades", {
        Price: double(),
        price: double(),
      }),
    ).toThrow(/duplicate case-insensitive/);
    expect(() => sender.writer("trades", { price: {} as never })).toThrow(
      /invalid QWP writer descriptor/,
    );
  });

  it("keeps compiled rows atomic across concurrent calls and sender reset", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });
    const events = sender.writer("events", {
      value: long(),
      timestamp: designatedTimestamp("ns"),
    });

    await Promise.all([
      events.row({ value: 1n, timestamp: 10n }),
      events.row({ value: 2n, timestamp: 20n }),
    ]);
    sender.reset();
    await events.row({ value: 3n, timestamp: 30n });
    await sender.flush();

    expect(session.sends[0].tables[0].rowCount).toBe(1);
    expect(column(session.sends[0].tables[0], "value").values).toEqual([3n]);
  });

  it("can await durable ACKs and auto-flush by row count", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, {
      autoFlushRows: 1,
      autoFlushIntervalMs: 0,
      awaitDurableAck: true,
    });

    await sender.table("events").longColumn("value", 42n).atNow();
    expect(session.sends).toHaveLength(1);
    expect(session.durable).toHaveLength(1);
    await expect(sender.flush()).resolves.toBe(false);
  });

  it("auto-flushes by estimated buffered bytes", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, {
      autoFlushRows: 0,
      autoFlushBytes: 16,
      autoFlushIntervalMs: 0,
    });

    await sender.table("events").longColumn("value", 1n).atNow();
    expect(session.sends).toHaveLength(0);
    expect(sender.metrics).toMatchObject({
      pendingRows: 1,
      pendingBytes: 8,
      autoFlushBytes: 16,
      effectiveAutoFlushBytes: 16,
    });

    await sender.table("events").longColumn("value", 2n).atNow();
    expect(session.sends).toHaveLength(1);
    expect(session.sends[0].tables[0].rowCount).toBe(2);
    expect(sender.metrics).toMatchObject({ pendingRows: 0, pendingBytes: 0 });
    await sender.close();
  });

  it("counts variable-width values by UTF-8 and binary payload bytes", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, {
      autoFlushRows: 0,
      autoFlushBytes: 13,
      autoFlushIntervalMs: 0,
    });

    await sender
      .table("events")
      .stringColumn("message", "é")
      .binaryColumn("payload", Uint8Array.of(1, 2, 3))
      .atNow();

    expect(session.sends).toHaveLength(1);
    expect(sender.metrics.pendingBytes).toBe(0);
    await sender.close();
  });

  it("clamps an enabled byte trigger below the connected server batch cap", async () => {
    const session = Object.assign(new RecordingSession(), {
      maxBatchSizeBytes: 20,
    });
    const sender = new QwpSender(async () => session, {
      autoFlushRows: 0,
      autoFlushBytes: 100,
      autoFlushIntervalMs: 0,
    });
    await sender.connect();
    expect(sender.metrics.effectiveAutoFlushBytes).toBe(18);

    await sender.table("events").longColumn("value", 1n).atNow();
    await sender.table("events").longColumn("value", 2n).atNow();
    expect(session.sends).toHaveLength(0);
    await sender.table("events").longColumn("value", 3n).atNow();
    expect(session.sends).toHaveLength(1);
    expect(session.sends[0].tables[0].rowCount).toBe(3);
    await sender.close();
  });

  it("does not let a server batch cap enable an opted-out byte trigger", async () => {
    const session = Object.assign(new RecordingSession(), {
      maxBatchSizeBytes: 20,
    });
    const sender = new QwpSender(async () => session, {
      autoFlushRows: 0,
      autoFlushBytes: 0,
      autoFlushIntervalMs: 0,
    });
    await sender.connect();
    expect(sender.metrics.effectiveAutoFlushBytes).toBe(0);

    await sender.table("events").longColumn("value", 1n).atNow();
    expect(session.sends).toHaveLength(0);
    expect(sender.metrics).toMatchObject({ pendingRows: 1, pendingBytes: 8 });
    await sender.flush();
    await sender.close();
  });

  it("preserves pending byte accounting when publication fails", async () => {
    const session = new PublishingSession();
    session.failPublication = true;
    const sender = new QwpSender(async () => session, {
      autoFlushRows: 0,
      autoFlushBytes: 8,
      autoFlushIntervalMs: 0,
      awaitServerAck: false,
    });

    await expect(
      sender.table("events").longColumn("value", 1n).atNow(),
    ).rejects.toThrow("journal is full");
    expect(sender.metrics).toMatchObject({ pendingRows: 1, pendingBytes: 8 });

    session.failPublication = false;
    await expect(sender.flush()).resolves.toBe(true);
    expect(sender.metrics).toMatchObject({ pendingRows: 0, pendingBytes: 0 });
    await sender.close();
  });

  it("defers transactional auto-flush and commits without waiting on its withheld ACK", async () => {
    const session = new CommitAwareSession();
    const sender = new QwpSender(async () => session, {
      autoFlushRows: 1,
      autoFlushIntervalMs: 0,
      transactional: true,
      awaitDurableAck: true,
    });

    await expect(
      sender.table("events").longColumn("value", 42n).atNow(),
    ).resolves.toBeUndefined();
    expect(session.sends).toHaveLength(1);
    expect(session.sends[0]).toMatchObject({
      options: { deferCommit: true },
    });
    expect(session.durable).toHaveLength(0);

    await expect(sender.commit()).resolves.toBe(true);
    expect(session.sends).toHaveLength(2);
    expect(session.sends[1].tables).toHaveLength(0);
    expect(session.sends[1]).toMatchObject({
      options: { deferCommit: false },
    });
    expect(session.durable).toHaveLength(1);
    expect(sender.metrics).toMatchObject({
      totalRowsStaged: 1,
      totalRowsPublished: 1,
      totalFlushes: 2,
      totalFlushFailures: 0,
      totalTransactionsCommitted: 1,
      pendingRows: 0,
      deferredRows: 0,
      connected: true,
      closing: false,
      closed: false,
    });
    expect(Object.isFrozen(sender.metrics)).toBe(true);
    await expect(sender.flush()).resolves.toBe(false);
  });

  it("uses an explicit data flush to close a deferred transaction", async () => {
    const session = new CommitAwareSession();
    const sender = new QwpSender(async () => session, {
      autoFlushRows: 2,
      autoFlushIntervalMs: 0,
      transactional: true,
    });

    await sender.table("events").longColumn("value", 1n).atNow();
    await sender.table("events").longColumn("value", 2n).atNow();
    await sender.table("events").longColumn("value", 3n).atNow();

    expect(session.sends).toHaveLength(1);
    expect(session.sends[0].options?.deferCommit).toBe(true);
    expect(session.sends[0].tables[0].rowCount).toBe(2);
    await expect(sender.flush()).resolves.toBe(true);
    expect(session.sends[1].tables[0].rowCount).toBe(1);
    expect(session.sends[1].options?.deferCommit).toBe(false);
  });

  it("warns when close abandons an uncommitted transactional auto-flush", async () => {
    const session = new CommitAwareSession();
    const messages: (string | Error)[] = [];
    const sender = new QwpSender(async () => session, {
      autoFlushRows: 1,
      autoFlushIntervalMs: 0,
      transactional: true,
      log: (level, message) => {
        if (level === "warn") messages.push(message);
      },
    });

    await sender.table("events").longColumn("value", 42n).atNow();
    await sender.close();
    expect(session.sends).toHaveLength(1);
    expect(messages).toEqual([
      expect.stringContaining("1 deferred row(s) awaiting commit"),
    ]);
  });

  it("publishes staged transactional rows without implicitly committing them", async () => {
    const session = new PublishingSession();
    const messages: (string | Error)[] = [];
    const sender = new QwpSender(async () => session, {
      autoFlush: false,
      transactional: true,
      closeFlushTimeoutMs: 0,
      log: (level, message) => {
        if (level === "warn") messages.push(message);
      },
    });
    await sender.table("events").longColumn("value", 42n).atNow();

    await sender.close();
    expect(session.sends).toHaveLength(1);
    expect(session.sends[0]).toMatchObject({
      options: { deferCommit: true },
    });
    expect(session.sends[0].tables[0].rowCount).toBe(1);
    expect(messages).toEqual([
      expect.stringContaining("1 deferred row(s) awaiting commit"),
    ]);
  });

  it("allows the high-level sender to opt out of symbol deltas", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, {
      autoFlush: false,
      encode: { symbolDictionary: "full" },
    });
    await sender.table("trades").symbol("symbol", "ETH-USD").atNow();
    await sender.flush();
    expect(session.deltaSendCount).toBe(0);
    expect(session.sends).toHaveLength(1);
    await sender.close();
  });
});
