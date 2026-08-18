import { describe, expect, it } from "vitest";
import {
  QWP_COLUMN_TYPE,
  QWP_STATUS,
  QwpIngressEncodeOptions,
  QwpIngressResponse,
  QwpSender,
  QwpSenderSession,
  QwpTableBuffer,
  encodeQwpIngressFrame,
} from "../../src/qwp";

class RecordingSession implements QwpSenderSession {
  readonly sends: {
    tables: readonly QwpTableBuffer[];
    options?: QwpIngressEncodeOptions;
  }[] = [];
  readonly durable: QwpIngressResponse[] = [];
  deltaSendCount = 0;
  closeCount = 0;

  async sendTables(
    tables: readonly QwpTableBuffer[],
    options?: QwpIngressEncodeOptions,
  ): Promise<QwpIngressResponse> {
    this.sends.push({ tables, options });
    return {
      status: QWP_STATUS.OK,
      sequence: BigInt(this.sends.length - 1),
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
    const response = {
      status: QWP_STATUS.OK,
      sequence: BigInt(this.sends.length - 1),
      tables: tables.map((table) => ({
        name: table.name,
        sequenceTransaction: BigInt(table.rowCount),
      })),
    } satisfies QwpIngressResponse;
    if (options?.deferCommit) {
      return new Promise((resolve) => this.deferred.push({ resolve }));
    }
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
  }

  publishTablesDelta(
    tables: readonly QwpTableBuffer[],
    options?: Pick<QwpIngressEncodeOptions, "gorilla" | "deferCommit">,
  ): Promise<void> {
    this.deltaSendCount++;
    return this.publishTables(tables, options);
  }
}

function column(table: QwpTableBuffer, name: string) {
  const result = table.columns.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`missing column '${name}'`);
  return result;
}

describe("QWP high-level sender", () => {
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

  it("closes its session before waiting for an in-flight flush", async () => {
    const session = new ClosingUnblocksSession();
    const sender = new QwpSender(async () => session, { autoFlush: false });
    await sender.table("events").longColumn("value", 42n).atNow();
    const flushing = sender.flush().catch((error: unknown) => error);
    await Promise.resolve();

    await expect(sender.close()).resolves.toBeUndefined();
    await expect(flushing).resolves.toEqual(
      expect.objectContaining({ message: "session closed" }),
    );
    expect(session.closeCount).toBe(1);
    expect(sender.metrics.totalFlushFailures).toBe(1);
    expect(sender.metrics.connected).toBe(false);
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
      expect.stringContaining("1 auto-flushed row(s) awaiting commit"),
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
