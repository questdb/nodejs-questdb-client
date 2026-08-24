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
  binary,
  bool,
  byte,
  char,
  date,
  decimal64,
  decimal128,
  decimal256,
  designatedTimestamp,
  double,
  doubleArray,
  encodeQwpIngressFrame,
  float32,
  float64,
  geohash,
  int32,
  int64,
  ipv4,
  long,
  long256,
  longArray,
  short,
  symbol as qwpSymbol,
  timestamp,
  uuid,
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
  it("validates a column call even when its value is nullish", async () => {
    // Omitting the column must not take the rest of the call's validation with
    // it. A nullish value used to return before the sender state, the row
    // state and the name were ever looked at, so the same call site raised on
    // rows that carried a value and stayed silent on rows that did not -- a
    // misspelled or over-long name first surfaced in production, on the row
    // that happened to be populated. The ILP senders fix this in
    // validateColumnCall(), and README.md documents the nullish rule as shared
    // by both, so the two must agree.
    const build = () =>
      new QwpSender(async () => new PublishingSession(), {
        autoFlush: false,
        maxNameLength: 16,
      });

    for (const value of [null, undefined] as const) {
      // No table yet.
      expect(() => build().stringColumn("c", value)).toThrow(
        /table name must be set/i,
      );
      const table = () => build().table("t");
      expect(() => table().stringColumn("a".repeat(20), value)).toThrow(
        /too long/i,
      );
      expect(() => table().longColumn("bad.name", value)).toThrow(
        /illegal characters/i,
      );
      expect(() => table().symbol("bad-name", value)).toThrow(
        /illegal characters/i,
      );
      expect(() =>
        table().booleanColumn(123 as unknown as string, value),
      ).toThrow(/must be a string/i);
      // A constant that describes the column, not this row's value.
      expect(() => table().decimalColumn("d", value, 999)).toThrow(
        /decimal scale/i,
      );
      expect(() => table().geohashColumn("g", value, 0)).toThrow(
        /geohash precision/i,
      );
      // All four words absent is the LONG256 way of spelling a NULL.
      expect(() =>
        table().long256Column("bad.name", value, value, value, value),
      ).toThrow(/illegal characters/i);
      // dateColumn and the three fixed-width decimal setters returned on a
      // nullish value before validating anything -- commit 266438f fixed this
      // class and missed exactly these four.
      expect(() => table().dateColumn("bad.name", value)).toThrow(
        /illegal characters/i,
      );
      expect(() => table().decimal64Column("a".repeat(20), value, 2)).toThrow(
        /too long/i,
      );
      // The scale constant describes the column, not this row's value, so it is
      // checked whether or not the value is present.
      expect(() => table().decimal64Column("d", value, 999)).toThrow(
        /decimal scale/i,
      );
      expect(() => table().decimal128Column("d", value, 999)).toThrow(
        /decimal scale/i,
      );
      expect(() => table().decimal256Column("d", value, 999)).toThrow(
        /decimal scale/i,
      );
    }

    // A valid nullish call is still simply omitted.
    const sender = build();
    await sender
      .table("t")
      .stringColumn("skipped", null)
      .dateColumn("dateval", null)
      .decimal64Column("decval", null, 2)
      .longColumn("kept", 1n)
      .atNow();
    expect(sender.metrics.pendingRows).toBe(1);
    await sender.close();
  });

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

  it("omits a long256 column when all four words are nullish", async () => {
    // long256Column was the only column method whose value parameters did not
    // accept null or undefined, so the nullish rule README states for "every
    // column method" did not hold for it: a plain-JavaScript caller mapping an
    // optional field onto it got "Cannot convert null to a BigInt" and a
    // silently discarded row.
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });

    await sender
      .table("hashes")
      .long256Column("absent", null, null, null, null)
      .long256Column("alsoAbsent", undefined, undefined, undefined, undefined)
      .longColumn("kept", 7n)
      .atNow();
    await sender.flush();

    const table = session.sends[0].tables[0];
    expect(table.columns.map((c) => c.name)).toEqual(["kept"]);

    // A partial set is a caller mistake, not a NULL, and says so.
    expect(() =>
      sender.table("hashes").long256Column("partial", 1n, null, 3n, 4n),
    ).toThrow(/all four words, or none of them/);
  });

  it("rolls back the whole current row when a setter fails", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });

    sender.table("events").floatColumn("discarded", 1.5);
    expect(() => sender.stringColumn("bad", 42 as unknown as string)).toThrow(
      /only strings/,
    );
    // The failed row released its table, so the next row starts from table().
    await sender.table("events").longColumn("kept", 7n).atNow();
    await sender.flush();

    const table = session.sends[0].tables[0];
    expect(table.columns.map((item) => item.name)).toEqual(["kept"]);
  });

  it("encodes DATE on ingress as a raw int64, unlike TIMESTAMP", async () => {
    const frameFor = async (
      write: (sender: QwpSender) => QwpSender,
    ): Promise<number> => {
      const session = new RecordingSession();
      const sender = new QwpSender(async () => session, { autoFlush: false });
      await write(sender.table("t")).atNow();
      await sender.flush();
      return encodeQwpIngressFrame(
        session.sends[0].tables,
        session.sends[0].options,
      ).byteLength;
    };

    const date = await frameFor((s) => s.dateColumn("c", 1_700_000_000_000));
    const timestamp = await frameFor((s) =>
      s.timestampColumn("c", 1_700_000_000_000_000n),
    );
    const long = await frameFor((s) => s.longColumn("c", 1_700_000_000_000n));

    // QWP is asymmetric for DATE and this pins the ingress half. The server
    // parses it as a plain fixed-width int64 (QwpTableBlockCursor sends
    // TYPE_DATE to QwpFixedWidthColumnCursor), so it carries no per-column
    // encoding byte -- even though the egress result batch gives DATE that
    // byte and this package's decoder reads it. Making the two directions
    // "consistent" breaks ingest.
    expect(date).toBe(long);
    expect(date).toBe(timestamp - 1);
  });

  it("bounds close() even when the ACK drain is opted out", async () => {
    // close_flush_timeout_millis <= 0 is "fast close": it skips the ACK drain,
    // as the Java client does. It must not also remove the bound on the
    // publication -- that made 0, the value chosen to make close() cheapest,
    // the only value that could block forever on an unreachable server.
    class StallingSession extends RecordingSession {
      override publishTables(): Promise<void> {
        return new Promise<void>(() => undefined);
      }
      override publishTablesDelta(): Promise<void> {
        return this.publishTables();
      }
    }

    const sender = new QwpSender(async () => new StallingSession(), {
      autoFlush: false,
      closeFlushTimeoutMs: 0,
    });
    await sender.table("events").longColumn("value", 1n).atNow();

    const settled = await Promise.race([
      sender.close().then(
        () => "resolved",
        (error: Error) => error.constructor.name,
      ),
      new Promise((resolve) =>
        setTimeout(() => resolve("still pending"), 8_000),
      ),
    ]);
    expect(settled).toBe("QwpSenderCloseTimeoutError");
  }, 20_000);

  it("rolls back the row when a symbol value cannot be converted", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });

    // symbol() takes `unknown` and stringifies it, so the conversion itself can
    // throw. A null-prototype object has no toString; querystring.parse() and
    // several JSON parsers hand these back, so it is ordinary user data.
    sender.table("events").longColumn("value", 1n);
    expect(() =>
      sender.symbol("tag", Object.create(null) as unknown),
    ).toThrow();

    // The rejected row must not survive to be published by the next close.
    expect(() => sender.table("events")).not.toThrow();
    await sender.longColumn("value", 2n).atNow();
    await sender.flush();

    const table = session.sends[0].tables[0];
    expect(table.rowCount).toBe(1);
    expect(column(table, "value").values).toEqual([2n]);
  });

  it("does not merge a later row into one abandoned by a symbol failure", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });

    sender.table("events").longColumn("value", 1n);
    expect(() => sender.symbol("tag", { toString: null } as unknown)).toThrow();

    // Without the rollback the table stays selected, this symbol lands in the
    // abandoned row, the duplicate `value` is dropped by the dedup guard, and
    // one row carrying both rows' data is emitted.
    await sender
      .table("events")
      .symbol("tag", "second")
      .longColumn("value", 2n)
      .atNow();
    await sender.flush();

    const table = session.sends[0].tables[0];
    expect(table.rowCount).toBe(1);
    expect(column(table, "value").values).toEqual([2n]);
    expect(column(table, "tag").values).toEqual(["second"]);
  });

  it("does not let a discarded row pin the table schema", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });

    // 'a' only ever appeared in a row that was thrown away, so nothing about
    // it reached QuestDB and it must not constrain the column's type.
    sender.table("events").longColumn("a", 1n);
    expect(() => sender.stringColumn("b", 42 as unknown as string)).toThrow();
    await sender.table("events").stringColumn("a", "x").atNow();
    await sender.flush();

    const table = session.sends[0].tables[0];
    expect(column(table, "a").type).toBe(QWP_COLUMN_TYPE.VARCHAR);
  });

  it("does not let a cancelled row pin the table schema", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });

    sender.table("events").longColumn("a", 1n).cancelRow();
    await sender.table("events").stringColumn("a", "x").atNow();
    await sender.flush();

    expect(column(session.sends[0].tables[0], "a").type).toBe(
      QWP_COLUMN_TYPE.VARCHAR,
    );
  });

  it("still pins the schema learned from a row that was published", () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });

    // The rollback must not weaken per-table type consistency: this row was
    // completed, so its column types are real.
    sender.table("events").longColumn("a", 1n).atNow();
    expect(() => sender.table("events").stringColumn("a", "x")).toThrow(
      /column type mismatch/,
    );
  });

  it("keeps an earlier row's schema when a later row is discarded", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });

    await sender.table("events").longColumn("a", 1n).atNow();
    // Discarding this row may only roll back what this row introduced ('b'),
    // never what the committed row above learned ('a').
    sender.table("events").longColumn("b", 2n);
    expect(() => sender.stringColumn("bad", 42 as unknown as string)).toThrow();

    expect(() => sender.table("events").stringColumn("a", "x")).toThrow(
      /column type mismatch/,
    );
    await sender.table("events").longColumn("b", 3n).atNow();
    await sender.flush();
    expect(session.sends[0].tables[0].rowCount).toBe(2);
  });

  it("does not accumulate tables created by rows that were discarded", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });

    await sender.table("kept").longColumn("value", 1n).atNow();
    for (let index = 0; index < 100; index++) {
      sender.table(`transient-${index}`).longColumn("value", 1n);
      expect(() =>
        sender.stringColumn("bad", 42 as unknown as string),
      ).toThrow();
    }

    const staged = (sender as unknown as { tables: readonly unknown[] }).tables;
    expect(staged).toHaveLength(1);
    expect(sender.metrics.pendingRows).toBe(1);
  });

  it("keeps the sender usable after a failed row, without losing staged rows", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });

    await sender.table("events").longColumn("value", 1n).atNow();
    sender.table("events").symbol("kind", "start");
    expect(() => sender.stringColumn("label", 42 as unknown as string)).toThrow(
      /only strings/,
    );

    // Recovery no longer needs reset(), which would drop the completed row too.
    expect(() => sender.table("events")).not.toThrow();
    await sender.longColumn("value", 2n).atNow();
    await sender.flush();

    const table = session.sends[0].tables[0];
    expect(table.rowCount).toBe(2);
    expect(table.columns.map((item) => item.name)).toEqual(["value"]);
    expect(column(table, "value").values).toEqual([1n, 2n]);
  });

  it("refuses to continue a failed row implicitly", async () => {
    const sender = new QwpSender(async () => new RecordingSession(), {
      autoFlush: false,
    });

    sender.table("events").longColumn("value", 1n);
    expect(() => sender.stringColumn("label", 42 as unknown as string)).toThrow(
      /only strings/,
    );
    // Setters after the failure must not silently open a new row.
    expect(() => sender.longColumn("value", 2n)).toThrow(
      /table name must be set before adding columns/,
    );
    await expect(sender.atNow()).rejects.toThrow(
      /table name must be set before adding columns/,
    );
    expect(sender.metrics.pendingRows).toBe(0);
  });

  it("releases the row when the designated timestamp is rejected", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });

    sender.table("events").longColumn("value", 1n);
    await expect(sender.at(1.5, "us")).rejects.toThrow(/safe integer/);

    await sender.table("events").longColumn("value", 2n).atNow();
    await sender.flush();
    expect(column(session.sends[0].tables[0], "value").values).toEqual([2n]);
  });

  it("cancelRow() discards the row in progress and its table selection", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });

    await sender.table("events").longColumn("value", 1n).atNow();
    sender.table("events").longColumn("value", 99n).cancelRow();

    expect(sender.metrics.pendingRows).toBe(1);
    await sender.table("other").longColumn("value", 2n).atNow();
    await sender.flush();

    const tables = session.sends[0].tables;
    expect(tables.map((table) => table.name)).toEqual(["events", "other"]);
    expect(column(tables[0], "value").values).toEqual([1n]);
    expect(column(tables[1], "value").values).toEqual([2n]);
  });

  it("cancelRow() leaves a closed sender alone", async () => {
    const sender = new QwpSender(async () => new RecordingSession(), {
      autoFlush: false,
    });
    await sender.close();
    expect(() => sender.cancelRow()).toThrow(/closed/);
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

  it("compiles the remaining QuestDB column types into object rows", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });
    const typed = sender.writer("typed", {
      created_date: date(),
      letter: char(),
      payload: binary(),
      id: uuid(),
      hash: long256(),
      ip: ipv4(),
      location: geohash(20),
      price: decimal64(4),
      wide_price: decimal128(2),
      widest_price: decimal256(0),
      samples: doubleArray(),
      counters: longArray(),
      timestamp: designatedTimestamp("ns"),
    });

    await typed.row({
      created_date: 1_700_000_000_000n,
      letter: "Q",
      payload: Uint8Array.of(1, 2, 3),
      id: "123e4567-e89b-12d3-a456-426614174000",
      hash: "0x0102",
      ip: "192.168.0.1",
      // Base-32 geohash text carries five bits per character.
      location: "u33d",
      price: "123.4500",
      wide_price: 1_234n,
      widest_price: { unscaled: 42n, scale: 0 },
      samples: [
        [1.5, 2.5],
        [3.5, 4.5],
      ],
      counters: [1n, 2n, 3n],
      timestamp: 1_723_000_000_000_000_000n,
    });
    // The shapes the egress views hand back are valid ingress inputs.
    await typed.row({
      id: { low: 0x1122334455667788n, high: 0x99aabbccddeeff00n },
      hash: { words: [1n, 2n, 3n, 4n] },
      location: { bits: 7n, precisionBits: 20 },
      price: { unscaled: 1_234_500n, scale: 4 },
      samples: { dimensions: [2, 2], values: [1, 2, 3, 4] },
      ip: 0xc0a80002,
      timestamp: 1_723_000_001_000_000_000n,
    });
    await sender.flush();

    const table = session.sends[0].tables[0];
    expect(table.rowCount).toBe(2);
    expect(column(table, "created_date")).toMatchObject({
      type: QWP_COLUMN_TYPE.DATE,
      values: [1_700_000_000_000n],
      nulls: [false, true],
    });
    expect(column(table, "letter")).toMatchObject({
      type: QWP_COLUMN_TYPE.CHAR,
      values: ["Q"],
    });
    expect(column(table, "payload")).toMatchObject({
      type: QWP_COLUMN_TYPE.BINARY,
      values: [Uint8Array.of(1, 2, 3)],
    });
    expect(column(table, "id")).toMatchObject({
      type: QWP_COLUMN_TYPE.UUID,
      values: [
        // Canonical text and {low, high} limbs both encode little-endian.
        Uint8Array.of(
          0x00,
          0x40,
          0x17,
          0x14,
          0x66,
          0x42,
          0x56,
          0xa4,
          0xd3,
          0x12,
          0x9b,
          0xe8,
          0x67,
          0x45,
          0x3e,
          0x12,
        ),
        Uint8Array.of(
          0x88,
          0x77,
          0x66,
          0x55,
          0x44,
          0x33,
          0x22,
          0x11,
          0x00,
          0xff,
          0xee,
          0xdd,
          0xcc,
          0xbb,
          0xaa,
          0x99,
        ),
      ],
    });
    const hashes = column(table, "hash");
    expect(hashes.type).toBe(QWP_COLUMN_TYPE.LONG256);
    expect(hashes.values[0]).toEqual(
      Uint8Array.of(0x02, 0x01, ...new Uint8Array(30)),
    );
    expect(
      new DataView((hashes.values[1] as Uint8Array).buffer).getBigInt64(
        24,
        true,
      ),
    ).toBe(4n);
    expect(column(table, "ip")).toMatchObject({
      type: QWP_COLUMN_TYPE.IPV4,
      values: [0xc0a80001, 0xc0a80002],
    });
    expect(column(table, "location")).toMatchObject({
      type: QWP_COLUMN_TYPE.GEOHASH,
      geohashPrecision: 20,
      values: [855_148n, 7n],
    });
    expect(column(table, "price")).toMatchObject({
      type: QWP_COLUMN_TYPE.DECIMAL64,
      decimalScale: 4,
      values: [1_234_500n, 1_234_500n],
    });
    expect(column(table, "wide_price")).toMatchObject({
      type: QWP_COLUMN_TYPE.DECIMAL128,
      decimalScale: 2,
      values: [1_234n],
    });
    expect(column(table, "widest_price")).toMatchObject({
      type: QWP_COLUMN_TYPE.DECIMAL256,
      decimalScale: 0,
      values: [42n],
    });
    expect(column(table, "samples")).toMatchObject({
      type: QWP_COLUMN_TYPE.DOUBLE_ARRAY,
      values: [
        { dimensions: [2, 2], values: [1.5, 2.5, 3.5, 4.5] },
        { dimensions: [2, 2], values: [1, 2, 3, 4] },
      ],
    });
    expect(column(table, "counters")).toMatchObject({
      type: QWP_COLUMN_TYPE.LONG_ARRAY,
      values: [{ dimensions: [3], values: [1n, 2n, 3n] }],
    });
    expect(() => encodeQwpIngressFrame([table])).not.toThrow();
  });

  it("encodes a UUID identically from text, canonical bytes, and limbs", async () => {
    // The 16-byte form is canonical RFC 4122 order -- what uuid.parse() and
    // java.util.UUID hand back. Passing those bytes through verbatim would
    // store the UUID byte-reversed, silently, because 16 bytes is a valid
    // UUID whichever way round it is.
    const text = "123e4567-e89b-12d3-a456-426614174000";
    const canonical = Uint8Array.from([
      0x12, 0x3e, 0x45, 0x67, 0xe8, 0x9b, 0x12, 0xd3, 0xa4, 0x56, 0x42, 0x66,
      0x14, 0x17, 0x40, 0x00,
    ]);
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });

    await sender.table("t").uuidColumn("id", text).atNow();
    await sender.table("t").uuidColumn("id", canonical).atNow();
    const rows = sender.writer("t", { id: uuid() });
    await rows.row({ id: text });
    await rows.row({ id: canonical });
    await rows.row({
      id: { low: 0xa456426614174000n, high: 0x123e4567e89b12d3n },
    });
    await sender.flush();

    const values = column(session.sends[0].tables[0], "id").values;
    expect(values).toHaveLength(5);
    for (const encoded of values) {
      expect(encoded).toEqual(values[0]);
    }
    // Little-endian low limb first, matching the egress decoder.
    expect(values[0]).toEqual(
      Uint8Array.from([
        0x00, 0x40, 0x17, 0x14, 0x66, 0x42, 0x56, 0xa4, 0xd3, 0x12, 0x9b, 0xe8,
        0x67, 0x45, 0x3e, 0x12,
      ]),
    );
    await sender.close();
  });

  it("locks a decimal column's scale on its first value and rescales onto it", async () => {
    // A QWP column carries one scale per frame. The Java client's ColumnBuffer
    // locks it on the first value and rescales later ones onto it, so do the
    // same rather than rejecting every row after the first.
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });
    await sender.table("fx").decimalColumnText("mid", "1.500").atNow();
    await sender.table("fx").decimalColumnText("mid", "2.25").atNow();
    await sender.table("fx").decimalColumnText("mid", "3").atNow();
    await sender.flush();

    const mid = column(session.sends[0].tables[0], "mid");
    expect(session.sends[0].tables[0].rowCount).toBe(3);
    expect(mid.decimalScale).toBe(3);
    expect(mid.values).toEqual([1_500n, 2_250n, 3_000n]);
    await sender.close();
  });

  it("rejects a decimal the column's locked scale cannot represent", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });
    await sender.table("fx").decimalColumnText("mid", "1.5").atNow();
    // Scale 1 cannot carry 2.25 without dropping a digit, which is the one
    // case the Java client reports instead of rescaling.
    expect(() => sender.table("fx").decimalColumnText("mid", "2.25")).toThrow(
      /column 'mid' cannot rescale decimal from scale 2 to 1 without precision loss/,
    );
    await sender.flush();
    expect(column(session.sends[0].tables[0], "mid").values).toEqual([15n]);
    await sender.close();
  });

  it("keeps a decimal column's width stable across magnitudes", async () => {
    // The width came from each value's magnitude, so a larger second value
    // changed the column type and the row was discarded. Java takes the width
    // from the overload; the untyped setter therefore pins the widest.
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });
    await sender.table("fx").decimalColumn("mid", 12_345n, 2).atNow();
    await sender
      .table("fx")
      .decimalColumn("mid", 10n ** 25n, 2)
      .atNow();
    await sender.flush();

    const mid = column(session.sends[0].tables[0], "mid");
    expect(mid.type).toBe(QWP_COLUMN_TYPE.DECIMAL256);
    expect(mid.decimalScale).toBe(2);
    expect(mid.values).toEqual([12_345n, 10n ** 25n]);
    await sender.close();
  });

  it("rejects mixed timestamp units within one column", async () => {
    // TIMESTAMP and TIMESTAMP_NANOS are distinct column types; the Java client
    // rejects the second unit rather than promoting the column.
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });
    await sender.table("t").timestampColumn("seen", 5n, "us").atNow();
    expect(() =>
      sender.table("t").timestampColumn("seen", 7_000n, "ns"),
    ).toThrow(/column type mismatch for 'seen'/);
    await sender.close();
  });

  it("still rejects a genuine column family change", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });
    await sender.table("t").longColumn("v", 1n).atNow();
    expect(() => sender.table("t").stringColumn("v", "two")).toThrow(
      /column type mismatch for 'v'/,
    );
    await sender.close();
  });

  it("rejects rather than throwing when flushed after close", async () => {
    // The signature promises a Promise, so `sender.flush().catch(handler)` has
    // to catch this. A synchronous throw escapes that handler entirely and
    // becomes an uncaught exception when the caller is a timer or an event
    // handler -- the shape a periodic flush racing shutdown actually has.
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });
    await sender.table("t").intColumn("a", 1).atNow();
    await sender.close();

    for (const call of [
      () => sender.flush(),
      () => sender.flushAndGetSequence(),
      () => sender.commit(),
    ]) {
      let caught: unknown;
      // Deliberately not inside try/catch: a synchronous throw would escape.
      const settled = call().catch((error: unknown) => {
        caught = error;
      });
      await settled;
      expect(String(caught)).toContain("QWP sender is closed");
    }
  });

  it("aborts a first connect still negotiating when close() is called", async () => {
    // The reconnect loop owns an AbortController, but the first connect
    // bypasses it, so close() could only attach cleanup to the pending promise.
    // The socket and its deadline then outlived close() by the whole
    // connect/auth timeout, and a CLI or serverless process that closed and
    // expected to exit hung for that long.
    let received: AbortSignal | undefined;
    let settleConnect!: (session: QwpSenderSession) => void;
    const sender = new QwpSender(
      (signal) => {
        received = signal;
        return new Promise<QwpSenderSession>((resolve) => {
          settleConnect = resolve;
        });
      },
      { autoFlush: false, closeFlushTimeoutMs: 20 },
    );

    sender.connect().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toBeDefined();
    expect(received!.aborted).toBe(false);

    await sender.close().catch(() => undefined);
    expect(received!.aborted).toBe(true);

    // Let the abandoned connect settle so it cannot leak into another test.
    settleConnect(new RecordingSession());
  });

  it("does not open a new session once close() has returned", async () => {
    // close() bounds its flush with a deadline but cannot cancel it, so an
    // abandoned close flush stays runnable. getSession() clears sessionPromise
    // when a connect fails, so that leftover flush could dial the database
    // again and write rows after close() had already returned to the caller --
    // an application that closed a sender to stop writing kept writing.
    let sessions = 0;
    let failFirstConnect!: (error: Error) => void;
    // The first connect must still be pending when close() gives up, and fail
    // only afterwards: that is what clears sessionPromise while an abandoned
    // close flush is still runnable.
    const firstConnect = new Promise<QwpSenderSession>((_, reject) => {
      failFirstConnect = reject;
    });
    const sender = new QwpSender(
      async () => {
        sessions++;
        return sessions === 1 ? firstConnect : new RecordingSession();
      },
      { autoFlush: false, closeFlushTimeoutMs: 20 },
    );

    await sender.table("t").intColumn("a", 1).atNow();
    sender.flush().catch(() => undefined);
    await sender.close().catch(() => undefined);
    expect(sessions).toBe(1);

    failFirstConnect(new Error("first connect failed"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sessions).toBe(1);

    // And a fresh acquisition is refused outright rather than dialling.
    await expect(sender.flush()).rejects.toThrow("QWP sender is closed");
    expect(sessions).toBe(1);
  });

  it("loses no rows across back-to-back flushes", async () => {
    // The enqueue still has to run synchronously on the call, so two flushes
    // issued without awaiting cannot drop or duplicate staged rows.
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });
    await sender.table("t").intColumn("a", 1).atNow();
    const first = sender.flush();
    await sender.table("t").intColumn("a", 2).atNow();
    const second = sender.flush();
    await Promise.all([first, second]);
    const delivered = session.sends.reduce(
      (total, send) => total + send.tables[0].rowCount,
      0,
    );
    expect(delivered).toBe(2);
    expect(sender.metrics.pendingRows).toBe(0);
    await sender.close();
  });

  it("validates fixed precision and scale when compiling the schema", () => {
    const sender = new QwpSender(async () => new RecordingSession(), {
      autoFlush: false,
    });
    expect(() => geohash(0)).toThrow(/between 1 and 60 bits/);
    expect(() => geohash(61)).toThrow(/between 1 and 60 bits/);
    expect(() => decimal64(19)).toThrow(
      /decimal64 scale must be between 0 and 18/,
    );
    expect(() => decimal128(39)).toThrow(/between 0 and 38/);
    expect(() => decimal256(-1)).toThrow(/between 0 and 76/);
    expect(() =>
      sender.writer("typed", { location: geohash(5) }),
    ).not.toThrow();
  });

  it("rejects values that do not fit the compiled column type", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });
    const typed = sender.writer("typed", {
      letter: char(),
      payload: binary(),
      id: uuid(),
      hash: long256(),
      ip: ipv4(),
      location: geohash(20),
      price: decimal64(2),
      samples: doubleArray(),
      counters: longArray(),
      timestamp: designatedTimestamp("ns"),
    });
    const rejects = async (
      row: object,
      message: RegExp,
      columnName: string,
    ) => {
      await expect(
        typed.row({ timestamp: 1n, ...row } as never),
      ).rejects.toMatchObject({ name: "QwpWriterRowError", columnName });
      await expect(
        typed.row({ timestamp: 1n, ...row } as never),
      ).rejects.toThrow(message);
    };

    await rejects({ letter: "QQ" }, /one UTF-16 code unit/, "letter");
    await rejects({ payload: [1, 2, 3] }, /only Uint8Array values/, "payload");
    await rejects({ id: "not-a-uuid" }, /canonical UUID/, "id");
    await rejects({ hash: "0102" }, /0x-prefixed hex/, "hash");
    await rejects({ hash: [1n, 2n] }, /exactly four 64-bit words/, "hash");
    await rejects({ ip: "0.0.0.0" }, /NULL sentinel/, "ip");
    await rejects({ location: "u33" }, /column is 20 bits/, "location");
    await rejects({ location: 1n << 21n }, /does not fit/, "location");
    await rejects(
      { location: { bits: 1n, precisionBits: 25 } },
      /precision mismatch/,
      "location",
    );
    await rejects(
      { price: "1.005" },
      /not exactly representable at scale 2/,
      "price",
    );
    await rejects({ price: 1n << 70n }, /exceeds signed int64/, "price");
    await rejects({ samples: [1n, 2n] }, /only number values/, "samples");
    await rejects({ counters: [[1n], [2n, 3n]] }, /irregular/, "counters");
    await rejects(
      { samples: { dimensions: [2, 2], values: [1, 2, 3] } },
      /needs 4 value\(s\), received 3/,
      "samples",
    );
    expect(sender.metrics.pendingRows).toBe(0);

    // Trailing zeros rescale exactly, so the same column still accepts text.
    await typed.row({ price: "1.50", timestamp: 2n });
    await sender.flush();
    expect(column(session.sends[0].tables[0], "price").values).toEqual([150n]);
  });

  it("reconciles compiled precision and scale with the fluent row API", async () => {
    const sender = new QwpSender(async () => new RecordingSession(), {
      autoFlush: false,
    });
    const typed = sender.writer("typed", { location: geohash(20) });

    await sender.table("typed").geohashColumn("location", 3n, 25).atNow();
    await expect(typed.row({ location: 7n })).rejects.toThrow(
      /conflicts with the sender's staged schema/,
    );
    expect(sender.metrics.pendingRows).toBe(1);
  });

  it("rejects a wrong-typed geohash or decimal value at the call site", async () => {
    const session = new RecordingSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });

    // None of these was rejected by the BigInt range guard: a non-numeric
    // string makes both comparisons undefined, and everything else compares
    // numerically. They reached BigInt() inside the frame encoder instead,
    // where they either stored a different number than a compiled writer
    // stores for the same input -- "12" is 34 as base-32 geohash text, not 12
    // -- or threw long after the row had been staged, leaving a sender that
    // could never flush or close.
    for (const value of [
      "12",
      "u33d",
      "",
      true,
      1.5,
      Number.NaN,
      [3],
      { bits: 3n },
    ]) {
      expect(() =>
        sender.table("geo").geohashColumn("g", value as unknown as bigint, 20),
      ).toThrow(/geohashColumn accepts only bigint raw bits/);
      // The rejected row takes its table selection with it.
      expect(sender.metrics.pendingRows).toBe(0);
    }

    // signedBigEndianToBigInt() iterates its argument and a string is
    // iterable, so "12345" coerced character by character into 0x0102030405
    // and "x" stored 0 -- both silently, with no error anywhere.
    for (const value of ["12345", "x", 12_345, true]) {
      expect(() =>
        sender.table("fx").decimalColumn("d", value as unknown as bigint, 2),
      ).toThrow(/decimalColumn accepts only bigint or Int8Array values/);
      expect(sender.metrics.pendingRows).toBe(0);
    }

    // The rejections leave the sender usable and the accepted forms alone.
    await sender
      .table("geo")
      .geohashColumn("g", 34n, 20)
      .decimalColumn("d", 12_345n, 2)
      .decimalColumn("absent", new Int8Array(0), 2)
      .atNow();
    await sender.flush();

    const [table] = session.sends[0].tables;
    expect(table.columns.map((candidate) => candidate.name)).toEqual([
      "g",
      "d",
    ]);
    expect(column(table, "g").values).toEqual([34n]);
    expect(column(table, "d").values).toEqual([12_345n]);
  });

  it("keeps auto-flush accurate when reset() lands during a flush", async () => {
    // reset() zeroes the pending counters synchronously, while a flush already
    // in flight subtracts its own snapshot after its await. Both ran against
    // the same counters, so the rows were retired twice: pendingRows went
    // negative and stayed there, delaying every later row- and byte-triggered
    // auto-flush by that offset for the sender's life.
    let releaseSend!: () => void;
    const parked = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let entered!: () => void;
    const inSend = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let armed = true;
    let frames = 0;

    // flush() publishes locally by default, so park that rather than sendTables.
    class ParkingSession extends RecordingSession {
      override async publishTables(
        tables: readonly QwpTableBuffer[],
        options?: QwpIngressEncodeOptions,
      ): Promise<void> {
        if (armed) {
          armed = false;
          entered();
          await parked;
        }
        frames++;
        return super.publishTables(tables, options);
      }
    }

    const sender = new QwpSender(async () => new ParkingSession(), {
      autoFlush: true,
      autoFlushRows: 3,
      closeFlushTimeoutMs: 0,
    });

    for (const value of [1n, 2n]) {
      sender.table("t").longColumn("v", value);
      await sender.at(1_000n);
    }
    expect(sender.metrics.pendingRows).toBe(2);

    const flushing = sender.flush();
    await inSend;
    sender.reset();
    expect(sender.metrics.pendingRows).toBe(0);

    releaseSend();
    await flushing;
    // The parked flush must not retire rows the reset already dropped.
    expect(sender.metrics.pendingRows).toBe(0);
    expect(sender.metrics.pendingBytes).toBe(0);

    // Row-triggered auto-flush still fires on the row it was configured for.
    const before = frames;
    for (const value of [3n, 4n, 5n]) {
      sender.table("t").longColumn("v", value);
      await sender.at(2_000n);
    }
    expect(frames - before).toBe(1);
    await sender.close();
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
    ).rejects.toMatchObject({
      columnName: "prise",
      rowIndex: undefined,
    } satisfies Partial<QwpWriterRowError>);
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
