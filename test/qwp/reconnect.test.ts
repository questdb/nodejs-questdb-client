import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectQwpNodeIngress,
  QwpNodeFileReplayStore,
  QwpReplayStoreError,
  QwpReplayStoreFullError,
  QwpReplayStoreLockedError,
} from "../../src/qwp/node";
import {
  QWP_RECONNECT_EVENT_KIND,
  QWP_COLUMN_TYPE,
  QWP_EGRESS_CAPABILITY,
  QWP_EGRESS_MESSAGE,
  QWP_STATUS,
  QWP_UPGRADE_ERROR_KIND,
  QwpBinaryConnection,
  QwpByteWriter,
  QwpConnectionCloseInfo,
  QwpEgressReplayRequiredError,
  QwpEgressSession,
  QwpIngressSession,
  QwpIngressReplayRecord,
  QwpIngressReplayStore,
  QwpHandshakeMetadata,
  QwpSymbolDictionary,
  QwpTableBuffer,
  QwpReconnectEvent,
  QwpReconnectExhaustedError,
  QwpReplayRejectedError,
  QwpUpgradeError,
  encodeQwpFrame,
  encodeQwpDurableAckPollFrame,
  encodeQwpIngressFrame,
  decodeQwpIngressSymbolDictionaryDelta,
  writeQwpVarint,
} from "../../src/qwp";
import { QwpAsyncQueue } from "../../src/qwp/internal/async-queue";
import { createQwpFailoverConnectionFactory } from "../../src/qwp/internal/failover";

function ingressResponse(
  status: number,
  sequence: bigint,
  tables: readonly [string, bigint][] = [],
): Uint8Array {
  const writer = new QwpByteWriter()
    .writeUint8(status)
    .writeBigUint64(sequence);
  if (status === QWP_STATUS.OK) writeIngressTables(writer, tables);
  else writer.writeUint16(0);
  return writer.toUint8Array();
}

function durableResponse(tables: readonly [string, bigint][]): Uint8Array {
  const writer = new QwpByteWriter().writeUint8(QWP_STATUS.DURABLE_ACK);
  writeIngressTables(writer, tables);
  return writer.toUint8Array();
}

function writeIngressTables(
  writer: QwpByteWriter,
  tables: readonly [string, bigint][],
): void {
  writer.writeUint16(tables.length);
  for (const [name, transaction] of tables) {
    const bytes = new TextEncoder().encode(name);
    writer
      .writeUint16(bytes.length)
      .writeBytes(bytes)
      .writeBigInt64(transaction);
  }
}

function writeUint16String(writer: QwpByteWriter, value: string): void {
  const bytes = new TextEncoder().encode(value);
  writer.writeUint16(bytes.length).writeBytes(bytes);
}

function serverInfo(node: string): Uint8Array {
  const payload = new QwpByteWriter()
    .writeUint8(QWP_EGRESS_MESSAGE.SERVER_INFO)
    .writeUint8(0)
    .writeBigUint64(1n)
    .writeUint32(QWP_EGRESS_CAPABILITY.QUERY_FLAGS)
    .writeBigInt64(123n);
  writeUint16String(payload, "cluster");
  writeUint16String(payload, node);
  return encodeQwpFrame(payload.toUint8Array());
}

function emptyResultBatch(requestId = 0n, batchSequence = 0): Uint8Array {
  const payload = new QwpByteWriter()
    .writeUint8(QWP_EGRESS_MESSAGE.RESULT_BATCH)
    .writeBigUint64(requestId);
  writeQwpVarint(payload, batchSequence);
  writeQwpVarint(payload, 0); // table name
  writeQwpVarint(payload, 0); // row count
  if (batchSequence === 0) writeQwpVarint(payload, 0); // column count
  return encodeQwpFrame(payload.toUint8Array(), 0, 1);
}

function resultEnd(requestId = 0n): Uint8Array {
  const payload = new QwpByteWriter()
    .writeUint8(QWP_EGRESS_MESSAGE.RESULT_END)
    .writeBigUint64(requestId);
  writeQwpVarint(payload, 1);
  writeQwpVarint(payload, 0);
  return encodeQwpFrame(payload.toUint8Array());
}

function symbolTable(symbol: string): QwpTableBuffer {
  const table = new QwpTableBuffer("trades");
  table
    .getOrCreateColumn("symbol", QWP_COLUMN_TYPE.SYMBOL)!
    .values.push(symbol);
  table.nextRow();
  return table;
}

class FakeConnection implements QwpBinaryConnection {
  readonly messages: AsyncIterable<Uint8Array>;
  readonly sent: Uint8Array[] = [];
  readonly closed: Promise<QwpConnectionCloseInfo>;
  private readonly incoming = new QwpAsyncQueue<Uint8Array>();
  private readonly resolveClosed: (info: QwpConnectionCloseInfo) => void;
  private closedSettled = false;

  constructor(
    readonly endpoint: string,
    readonly handshake: QwpHandshakeMetadata = { qwpVersion: 1 },
  ) {
    this.messages = this.incoming;
    let resolveClosed!: (info: QwpConnectionCloseInfo) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.resolveClosed = resolveClosed;
  }

  send(payload: Uint8Array): Promise<void> {
    this.sent.push(payload.slice());
    return Promise.resolve();
  }

  close(code = 1000, reason = ""): Promise<void> {
    this.finish({ code, reason, wasClean: code === 1000 });
    return Promise.resolve();
  }

  receive(payload: Uint8Array): void {
    this.incoming.push(payload);
  }

  drop(): void {
    this.finish({ code: 1006, reason: "connection lost", wasClean: false });
  }

  private finish(info: QwpConnectionCloseInfo): void {
    if (this.closedSettled) return;
    this.closedSettled = true;
    this.incoming.end();
    this.resolveClosed(info);
  }
}

class TrackingReplayStore implements QwpIngressReplayStore {
  readonly records = new Map<bigint, Uint8Array>();
  closeCount = 0;

  async load(): Promise<readonly QwpIngressReplayRecord[]> {
    return Array.from(this.records, ([frameSequence, payload]) => ({
      frameSequence,
      payload,
    }));
  }

  async append(record: QwpIngressReplayRecord): Promise<void> {
    this.records.set(record.frameSequence, record.payload.slice());
  }

  async acknowledgeThrough(frameSequence: bigint): Promise<void> {
    for (const sequence of this.records.keys()) {
      if (sequence <= frameSequence) this.records.delete(sequence);
    }
  }

  async close(): Promise<void> {
    this.closeCount++;
  }
}

class FailOnceDictionaryReplayStore extends TrackingReplayStore {
  readonly symbols: string[] = [];
  appendAttempts = 0;

  override async append(record: QwpIngressReplayRecord): Promise<void> {
    this.appendAttempts++;
    if (this.appendAttempts === 1) throw new Error("journal is full");
    await super.append(record);
  }

  async loadSymbolDictionary(): Promise<readonly string[]> {
    return this.symbols.slice();
  }

  async appendSymbolDictionary(
    startId: number,
    entries: readonly string[],
  ): Promise<void> {
    if (startId !== this.symbols.length) throw new Error("dictionary gap");
    this.symbols.push(...entries);
  }
}

describe("QWP endpoint failover", () => {
  it("walks all endpoints and rotates away from the last successful one", async () => {
    const attempts: string[] = [];
    let primaryAvailable = false;
    const factory = createQwpFailoverConnectionFactory(
      "primary",
      ["secondary"],
      async (endpoint) => {
        attempts.push(String(endpoint));
        if (endpoint === "primary" && !primaryAvailable) {
          throw new QwpUpgradeError("primary unavailable", {
            kind: QWP_UPGRADE_ERROR_KIND.TRANSPORT,
            retryable: true,
            tryNextEndpoint: true,
          });
        }
        return new FakeConnection(String(endpoint));
      },
    );

    await expect(factory()).resolves.toMatchObject({ endpoint: "secondary" });
    primaryAvailable = true;
    await expect(factory()).resolves.toMatchObject({ endpoint: "primary" });
    expect(attempts).toEqual(["primary", "secondary", "primary"]);
  });

  it("does not leak invalid credentials to another endpoint", async () => {
    const attempts: string[] = [];
    const authenticationError = new QwpUpgradeError("unauthorized", {
      kind: QWP_UPGRADE_ERROR_KIND.AUTHENTICATION,
      retryable: false,
      tryNextEndpoint: false,
    });
    const factory = createQwpFailoverConnectionFactory(
      "primary",
      ["secondary"],
      async (endpoint) => {
        attempts.push(String(endpoint));
        throw authenticationError;
      },
    );

    await expect(factory()).rejects.toBe(authenticationError);
    expect(attempts).toEqual(["primary"]);
  });
});

describe("QWP ingress reconnect and replay", () => {
  it("publishes while initially offline and drains after a background connection", async () => {
    const connection = new FakeConnection("primary");
    const replayStore = new TrackingReplayStore();
    let releaseOnline!: () => void;
    const online = new Promise<void>((resolve) => {
      releaseOnline = resolve;
    });
    let factoryCalls = 0;
    const session = await QwpIngressSession.connect(
      async () => {
        if (factoryCalls++ === 0) {
          throw new QwpUpgradeError("offline", {
            kind: QWP_UPGRADE_ERROR_KIND.TRANSPORT,
            retryable: true,
            tryNextEndpoint: true,
          });
        }
        await online;
        return connection;
      },
      {
        backgroundStoreAndForward: true,
        reconnect: {
          maxAttempts: 0,
          maxDurationMs: 0,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
        replayStore,
      },
    );

    await expect(
      session.publishFrame(Uint8Array.of(1)),
    ).resolves.toBeUndefined();
    await expect(
      session.publishFrame(Uint8Array.of(2)),
    ).resolves.toBeUndefined();
    expect(Array.from(replayStore.records.keys())).toEqual([0n, 1n]);
    expect(connection.sent).toEqual([]);
    expect(session.metrics).toMatchObject({
      pendingResponses: 0,
      pendingReplayFrames: 2,
      totalFramesSent: 0,
    });

    releaseOnline();
    await vi.waitFor(() =>
      expect(connection.sent).toEqual([Uint8Array.of(1), Uint8Array.of(2)]),
    );
    connection.receive(ingressResponse(QWP_STATUS.OK, 1n));
    await vi.waitFor(() => expect(replayStore.records.size).toBe(0));
    expect(session.metrics).toMatchObject({
      acknowledgedSequence: 1n,
      pendingReplayFrames: 0,
      totalFramesSent: 2,
    });
    await session.close();
  });

  it("retries a delta publication after journal backpressure", async () => {
    const replayStore = new FailOnceDictionaryReplayStore();
    const session = await QwpIngressSession.connect(
      async () => {
        throw new QwpUpgradeError("offline", {
          kind: QWP_UPGRADE_ERROR_KIND.TRANSPORT,
          retryable: true,
          tryNextEndpoint: true,
        });
      },
      {
        backgroundStoreAndForward: true,
        reconnect: {
          maxAttempts: 0,
          maxDurationMs: 0,
          initialBackoffMs: 10_000,
          maxBackoffMs: 10_000,
        },
        replayStore,
      },
    );

    await expect(
      session.publishTablesDelta([symbolTable("ETH-USD")]),
    ).rejects.toThrow("journal is full");
    expect(replayStore.symbols).toEqual(["ETH-USD"]);
    expect(replayStore.records.size).toBe(0);

    await expect(
      session.publishTablesDelta([symbolTable("ETH-USD")]),
    ).resolves.toBeUndefined();
    expect(replayStore.appendAttempts).toBe(2);
    expect(
      decodeQwpIngressSymbolDictionaryDelta(replayStore.records.get(1n)!),
    ).toEqual({ startId: 0, entries: ["ETH-USD"] });
    await session.close();
  });

  it("replays only unacknowledged browser frames and translates wire ACKs", async () => {
    const first = new FakeConnection("primary");
    const second = new FakeConnection("secondary");
    const connections = [first, second];
    const events: QwpReconnectEvent[] = [];
    const session = await QwpIngressSession.connect(
      async () => {
        const connection = connections.shift();
        if (!connection) throw new Error("no connection available");
        return connection;
      },
      {
        ackTimeoutMs: 1_000,
        reconnect: {
          maxAttempts: 1,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
          onEvent: (event) => events.push(event),
        },
      },
    );

    const acknowledged = session.sendFrame(Uint8Array.of(1));
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    first.receive(ingressResponse(QWP_STATUS.OK, 0n));
    await expect(acknowledged).resolves.toMatchObject({ sequence: 0n });

    const pending = session.sendFrame(Uint8Array.of(2));
    await vi.waitFor(() => expect(first.sent).toHaveLength(2));
    first.drop();
    await vi.waitFor(() => expect(second.sent).toEqual([Uint8Array.of(2)]));
    second.receive(ingressResponse(QWP_STATUS.OK, 0n));

    await expect(pending).resolves.toMatchObject({ sequence: 1n });
    expect(events.map((event) => event.kind)).toEqual([
      QWP_RECONNECT_EVENT_KIND.CONNECTED,
      QWP_RECONNECT_EVENT_KIND.RECONNECTING,
      QWP_RECONNECT_EVENT_KIND.FAILED_OVER,
    ]);
    expect(events.every((event) => event.timestampMs > 0)).toBe(true);
    expect(session.metrics).toMatchObject({
      publishedSequence: 1n,
      acknowledgedSequence: 1n,
      totalFramesPublished: 2,
      totalFramesSent: 3,
      totalBytesSent: 3,
      totalFramesReplayed: 1,
      totalBytesReplayed: 1,
      totalReconnectAttempts: 1,
      totalReconnectsSucceeded: 1,
      totalFailovers: 1,
      totalReconnectErrors: 0,
      replayPublishedFrameSequence: 1n,
      replayAcknowledgedFrameSequence: 1n,
      pendingReplayFrames: 0,
      pendingReplayBytes: 0,
    });
    await session.close();
  });

  it("restores browser-memory symbol dictionaries before replay", async () => {
    const first = new FakeConnection("primary");
    const second = new FakeConnection("secondary");
    const connections = [first, second];
    const session = await QwpIngressSession.connect(
      async () => {
        const connection = connections.shift();
        if (!connection) throw new Error("no connection available");
        return connection;
      },
      {
        ackTimeoutMs: 1_000,
        reconnect: {
          maxAttempts: 1,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    );

    const firstTable = symbolTable("ETH-USD");
    const acknowledged = session.sendTablesDelta([firstTable]);
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    expect(decodeQwpIngressSymbolDictionaryDelta(first.sent[0])).toEqual({
      startId: 0,
      entries: ["ETH-USD"],
    });
    first.receive(ingressResponse(QWP_STATUS.OK, 0n));
    await acknowledged;

    const pending = session.sendTablesDelta([symbolTable("BTC-USD")]);
    await vi.waitFor(() => expect(first.sent).toHaveLength(2));
    expect(decodeQwpIngressSymbolDictionaryDelta(first.sent[1])).toEqual({
      startId: 1,
      entries: ["BTC-USD"],
    });
    first.drop();

    await vi.waitFor(() => expect(second.sent).toHaveLength(2));
    expect(decodeQwpIngressSymbolDictionaryDelta(second.sent[0])).toEqual({
      startId: 0,
      entries: ["ETH-USD", "BTC-USD"],
    });
    expect(second.sent[1]).toEqual(first.sent[1]);
    second.receive(ingressResponse(QWP_STATUS.OK, 0n));
    second.receive(ingressResponse(QWP_STATUS.OK, 1n));
    await expect(pending).resolves.toMatchObject({ sequence: 1n });
    await session.close();
  });

  it("chunks reconnect dictionary catch-up under the negotiated batch cap", async () => {
    const first = new FakeConnection("primary");
    const second = new FakeConnection("secondary", {
      qwpVersion: 1,
      maxBatchSizeBytes: 22,
    });
    const connections = [first, second];
    const session = await QwpIngressSession.connect(
      async () => {
        const connection = connections.shift();
        if (!connection) throw new Error("no connection available");
        return connection;
      },
      {
        ackTimeoutMs: 1_000,
        reconnect: {
          maxAttempts: 1,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    );
    for (const [index, symbol] of ["ETH-USD", "BTC-USD"].entries()) {
      const pending = session.sendTablesDelta([symbolTable(symbol)]);
      await vi.waitFor(() => expect(first.sent).toHaveLength(index + 1));
      first.receive(ingressResponse(QWP_STATUS.OK, BigInt(index)));
      await pending;
    }

    first.drop();
    await vi.waitFor(() => expect(second.sent).toHaveLength(2));
    expect(second.sent.every((frame) => frame.byteLength <= 22)).toBe(true);
    expect(decodeQwpIngressSymbolDictionaryDelta(second.sent[0])).toEqual({
      startId: 0,
      entries: ["ETH-USD"],
    });
    expect(decodeQwpIngressSymbolDictionaryDelta(second.sent[1])).toEqual({
      startId: 1,
      entries: ["BTC-USD"],
    });
    await session.close();
  });

  it("does not double-send a frame queued while replay is connecting", async () => {
    const first = new FakeConnection("primary");
    const second = new FakeConnection("secondary");
    let releaseSecond!: () => void;
    const secondReady = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let factoryCalls = 0;
    const session = await QwpIngressSession.connect(
      async () => {
        if (factoryCalls++ === 0) return first;
        await secondReady;
        return second;
      },
      {
        reconnect: {
          maxAttempts: 1,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    );

    const ambiguous = session.sendFrame(Uint8Array.of(1));
    await vi.waitFor(() => expect(first.sent).toEqual([Uint8Array.of(1)]));
    first.drop();
    await vi.waitFor(() => expect(factoryCalls).toBe(2));
    const queued = session.sendFrame(Uint8Array.of(2));
    releaseSecond();

    await vi.waitFor(() =>
      expect(second.sent).toEqual([Uint8Array.of(1), Uint8Array.of(2)]),
    );
    second.receive(ingressResponse(QWP_STATUS.OK, 1n));
    await expect(Promise.all([ambiguous, queued])).resolves.toEqual([
      expect.objectContaining({ sequence: 1n }),
      expect.objectContaining({ sequence: 1n }),
    ]);
    await session.close();
  });

  it("fails pending sends with a typed reconnect exhaustion error", async () => {
    const first = new FakeConnection("primary");
    const replayStore = new TrackingReplayStore();
    let factoryCalls = 0;
    const session = await QwpIngressSession.connect(
      async () => {
        if (factoryCalls++ === 0) return first;
        throw new QwpUpgradeError("offline", {
          kind: QWP_UPGRADE_ERROR_KIND.TRANSPORT,
          retryable: true,
          tryNextEndpoint: true,
        });
      },
      {
        replayStore,
        reconnect: {
          maxAttempts: 2,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    );
    const pending = session.sendFrame(Uint8Array.of(1));
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    first.drop();

    await expect(pending).rejects.toBeInstanceOf(QwpReconnectExhaustedError);
    expect(factoryCalls).toBe(3);
    await vi.waitFor(() => expect(replayStore.closeCount).toBe(1));
    await session.close();
    expect(replayStore.closeCount).toBe(1);
  });

  it("reconnects and replays a transient ingress NACK without advancing", async () => {
    const first = new FakeConnection("primary");
    const second = new FakeConnection("secondary");
    const connections = [first, second];
    const session = await QwpIngressSession.connect(
      async () => {
        const connection = connections.shift();
        if (!connection) throw new Error("no connection available");
        return connection;
      },
      {
        reconnect: {
          maxAttempts: 1,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    );
    const pending = session.sendFrame(Uint8Array.of(9));
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    first.receive(ingressResponse(QWP_STATUS.WRITE_ERROR, 0n));
    await vi.waitFor(() => expect(second.sent).toEqual([Uint8Array.of(9)]));
    second.receive(ingressResponse(QWP_STATUS.OK, 0n));

    await expect(pending).resolves.toMatchObject({
      status: QWP_STATUS.OK,
      sequence: 0n,
    });
    expect(session.metrics).toMatchObject({
      totalNacks: 1,
      totalFramesSent: 2,
      totalFramesReplayed: 1,
      totalReconnectAttempts: 1,
      totalReconnectsSucceeded: 1,
    });
    await session.close();
  });

  it("stops replaying a repeatedly rejected poison frame", async () => {
    const first = new FakeConnection("primary");
    const second = new FakeConnection("secondary");
    const connections = [first, second];
    const session = await QwpIngressSession.connect(
      async () => {
        const connection = connections.shift();
        if (!connection) throw new Error("no connection available");
        return connection;
      },
      {
        reconnect: {
          maxAttempts: 1,
          maxFrameRejections: 2,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    );
    const pending = session.sendFrame(Uint8Array.of(9));
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    first.receive(ingressResponse(QWP_STATUS.WRITE_ERROR, 0n));
    await vi.waitFor(() => expect(second.sent).toHaveLength(1));
    second.receive(ingressResponse(QWP_STATUS.WRITE_ERROR, 0n));

    await expect(pending).rejects.toBeInstanceOf(QwpReplayRejectedError);
    expect(connections).toHaveLength(0);
    await session.close();
  });

  it("durably trims cumulative transaction ranges at ordered ACK checkpoints", async () => {
    const connection = new FakeConnection("primary", {
      qwpVersion: 1,
      durableAckEnabled: true,
    });
    const replayStore = new TrackingReplayStore();
    const session = await QwpIngressSession.connect(async () => connection, {
      ackTimeoutMs: 1_000,
      durableAckKeepaliveMs: 0,
      reconnect: { maxAttempts: 1 },
      replayStore,
    });
    const deferred = encodeQwpIngressFrame([symbolTable("ETH-USD")], {
      deferCommit: true,
    });
    const transactionCommit = encodeQwpIngressFrame([symbolTable("BTC-USD")]);
    const laterCommit = encodeQwpIngressFrame([symbolTable("SOL-USD")]);

    const responses = [
      session.sendFrame(deferred),
      session.sendFrame(transactionCommit),
      session.sendFrame(laterCommit),
    ];
    await vi.waitFor(() => expect(connection.sent).toHaveLength(3));
    connection.receive(ingressResponse(QWP_STATUS.OK, 1n, [["trades", 42n]]));
    connection.receive(ingressResponse(QWP_STATUS.OK, 2n, [["trades", 50n]]));
    await expect(Promise.all(responses)).resolves.toHaveLength(3);
    expect(Array.from(replayStore.records.keys())).toEqual([0n, 1n, 2n]);

    connection.receive(durableResponse([["trades", 41n]]));
    await vi.waitFor(() => expect(session.metrics.totalDurableAcks).toBe(1));
    expect(Array.from(replayStore.records.keys())).toEqual([0n, 1n, 2n]);

    connection.receive(durableResponse([["trades", 42n]]));
    await vi.waitFor(() =>
      expect(Array.from(replayStore.records.keys())).toEqual([2n]),
    );
    expect(session.metrics.replayAcknowledgedFrameSequence).toBe(1n);

    connection.receive(durableResponse([["trades", 50n]]));
    await vi.waitFor(() => expect(replayStore.records.size).toBe(0));
    expect(session.metrics.replayAcknowledgedFrameSequence).toBe(2n);
    await session.close();
  });

  it("recovers a persisted Node dictionary before replay and continues its IDs", async () => {
    const directory = await createTemporaryDirectory();
    const dictionary = new QwpSymbolDictionary();
    const seededTable = new QwpTableBuffer("trades");
    for (const symbol of ["ETH-USD", "BTC-USD"]) {
      seededTable
        .getOrCreateColumn("symbol", QWP_COLUMN_TYPE.SYMBOL)!
        .values.push(symbol);
      seededTable.nextRow();
    }
    const replayFrame = encodeQwpIngressFrame([seededTable], {
      dictionary,
      confirmedMaxSymbolId: -1,
    });
    const seed = new QwpNodeFileReplayStore({ directory });
    await seed.load();
    await seed.appendSymbolDictionary(0, dictionary.entriesFrom(0));
    await seed.append({ frameSequence: 5n, payload: replayFrame });
    await seed.close();

    const connection = new FakeConnection("primary");
    const session = await QwpIngressSession.connect(async () => connection, {
      ackTimeoutMs: 1_000,
      reconnect: { maxAttempts: 1 },
      replayStore: new QwpNodeFileReplayStore({ directory }),
    });
    expect(connection.sent).toHaveLength(2);
    expect(decodeQwpIngressSymbolDictionaryDelta(connection.sent[0])).toEqual({
      startId: 0,
      entries: ["ETH-USD", "BTC-USD"],
    });
    expect(connection.sent[1]).toEqual(replayFrame);
    connection.receive(ingressResponse(QWP_STATUS.OK, 0n));
    connection.receive(ingressResponse(QWP_STATUS.OK, 1n));
    await vi.waitFor(async () =>
      expect(
        (await readdir(directory)).filter((name) => name.endsWith(".qwp")),
      ).toEqual([]),
    );

    const current = session.sendTablesDelta([symbolTable("SOL-USD")]);
    await vi.waitFor(() => expect(connection.sent).toHaveLength(3));
    expect(decodeQwpIngressSymbolDictionaryDelta(connection.sent[2])).toEqual({
      startId: 2,
      entries: ["SOL-USD"],
    });
    connection.receive(ingressResponse(QWP_STATUS.OK, 2n));
    await expect(current).resolves.toMatchObject({ sequence: 0n });
    await session.close();

    const verify = new QwpNodeFileReplayStore({ directory });
    await expect(verify.load()).resolves.toEqual([]);
    await expect(verify.loadSymbolDictionary()).resolves.toEqual([
      "ETH-USD",
      "BTC-USD",
      "SOL-USD",
    ]);
    await verify.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("recovers a Node journal before new frames and removes it after ACK", async () => {
    const directory = await createTemporaryDirectory();
    const seed = new QwpNodeFileReplayStore({ directory });
    await seed.load();
    await seed.append({ frameSequence: 5n, payload: Uint8Array.of(5) });
    await seed.close();

    const connection = new FakeConnection("primary");
    const session = await QwpIngressSession.connect(async () => connection, {
      reconnect: { maxAttempts: 1 },
      replayStore: new QwpNodeFileReplayStore({ directory }),
    });
    expect(connection.sent).toEqual([Uint8Array.of(5)]);

    connection.receive(ingressResponse(QWP_STATUS.OK, 0n));
    const current = session.sendFrame(Uint8Array.of(6));
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2));
    connection.receive(ingressResponse(QWP_STATUS.OK, 1n));
    await expect(current).resolves.toMatchObject({ sequence: 0n });
    await session.close();

    const verify = new QwpNodeFileReplayStore({ directory });
    await expect(verify.load()).resolves.toEqual([]);
    await verify.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("retires a wholly deferred recovered transaction without replaying it", async () => {
    const directory = await createTemporaryDirectory();
    const firstDeferred = encodeQwpIngressFrame([symbolTable("ETH-USD")], {
      deferCommit: true,
    });
    const secondDeferred = encodeQwpIngressFrame([symbolTable("BTC-USD")], {
      deferCommit: true,
    });
    const seed = new QwpNodeFileReplayStore({ directory });
    await seed.load();
    await seed.append({ frameSequence: 5n, payload: firstDeferred });
    await seed.append({ frameSequence: 6n, payload: secondDeferred });
    await seed.append({
      frameSequence: 7n,
      payload: encodeQwpDurableAckPollFrame(),
    });
    await seed.close();

    const connection = new FakeConnection("primary");
    const session = await QwpIngressSession.connect(async () => connection, {
      reconnect: { maxAttempts: 1 },
      replayStore: new QwpNodeFileReplayStore({ directory }),
    });
    expect(connection.sent).toEqual([]);
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".qwp")),
    ).toEqual([]);
    expect(session.metrics).toMatchObject({
      replayPublishedFrameSequence: 7n,
      replayAcknowledgedFrameSequence: 7n,
      pendingReplayFrames: 0,
      totalFramesReplayed: 0,
    });

    const currentFrame = encodeQwpIngressFrame([symbolTable("SOL-USD")]);
    const current = session.sendFrame(currentFrame);
    await vi.waitFor(() => expect(connection.sent).toEqual([currentFrame]));
    connection.receive(ingressResponse(QWP_STATUS.OK, 0n));
    await expect(current).resolves.toMatchObject({ sequence: 0n });
    await session.close();

    const verify = new QwpNodeFileReplayStore({ directory });
    await expect(verify.load()).resolves.toEqual([]);
    await verify.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("replays a committed prefix before retiring its deferred recovery tail", async () => {
    const directory = await createTemporaryDirectory();
    const committed = encodeQwpIngressFrame([symbolTable("ETH-USD")]);
    const deferred = encodeQwpIngressFrame([symbolTable("BTC-USD")], {
      deferCommit: true,
    });
    const seed = new QwpNodeFileReplayStore({ directory });
    await seed.load();
    await seed.append({ frameSequence: 5n, payload: committed });
    await seed.append({ frameSequence: 6n, payload: deferred });
    await seed.append({
      frameSequence: 7n,
      payload: encodeQwpDurableAckPollFrame(),
    });
    await seed.close();

    const connection = new FakeConnection("primary", {
      qwpVersion: 1,
      durableAckEnabled: true,
    });
    const session = await QwpIngressSession.connect(async () => connection, {
      reconnect: { maxAttempts: 1 },
      replayStore: new QwpNodeFileReplayStore({ directory }),
      durableAckKeepaliveMs: 0,
    });
    expect(connection.sent).toEqual([committed]);

    connection.receive(ingressResponse(QWP_STATUS.OK, 0n, [["trades", 42n]]));
    await vi.waitFor(() => expect(session.metrics.pendingReplayFrames).toBe(3));
    connection.receive(durableResponse([["trades", 42n]]));
    await vi.waitFor(async () =>
      expect(
        (await readdir(directory)).filter((name) => name.endsWith(".qwp")),
      ).toEqual([]),
    );
    expect(session.metrics).toMatchObject({
      replayAcknowledgedFrameSequence: 7n,
      pendingReplayFrames: 0,
      totalFramesReplayed: 1,
    });

    const currentFrame = encodeQwpIngressFrame([symbolTable("SOL-USD")]);
    const current = session.sendFrame(currentFrame);
    await vi.waitFor(() =>
      expect(connection.sent).toEqual([committed, currentFrame]),
    );
    connection.receive(ingressResponse(QWP_STATUS.OK, 1n, [["trades", 43n]]));
    await expect(current).resolves.toMatchObject({ sequence: 0n });
    connection.receive(durableResponse([["trades", 43n]]));
    await vi.waitFor(async () =>
      expect(
        (await readdir(directory)).filter((name) => name.endsWith(".qwp")),
      ).toEqual([]),
    );
    await session.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("replays deferred recovery frames when a commit frame covers them", async () => {
    const directory = await createTemporaryDirectory();
    const deferred = encodeQwpIngressFrame([symbolTable("ETH-USD")], {
      deferCommit: true,
    });
    const commit = encodeQwpIngressFrame([symbolTable("BTC-USD")]);
    const seed = new QwpNodeFileReplayStore({ directory });
    await seed.load();
    await seed.append({ frameSequence: 5n, payload: deferred });
    await seed.append({ frameSequence: 6n, payload: commit });
    await seed.close();

    const connection = new FakeConnection("primary", {
      qwpVersion: 1,
      durableAckEnabled: true,
    });
    const session = await QwpIngressSession.connect(async () => connection, {
      reconnect: { maxAttempts: 1 },
      replayStore: new QwpNodeFileReplayStore({ directory }),
      durableAckKeepaliveMs: 0,
    });
    expect(connection.sent).toEqual([deferred, commit]);
    connection.receive(ingressResponse(QWP_STATUS.OK, 1n, [["trades", 42n]]));
    await vi.waitFor(async () =>
      expect(
        (await readdir(directory)).filter((name) => name.endsWith(".qwp")),
      ).toHaveLength(2),
    );
    connection.receive(durableResponse([["trades", 42n]]));
    await vi.waitFor(async () =>
      expect(
        (await readdir(directory)).filter((name) => name.endsWith(".qwp")),
      ).toEqual([]),
    );
    await session.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("retains Node journal records until a negotiated durable ACK", async () => {
    const directory = await createTemporaryDirectory();
    const connection = new FakeConnection("primary", {
      qwpVersion: 1,
      durableAckEnabled: true,
    });
    const session = await QwpIngressSession.connect(async () => connection, {
      reconnect: { maxAttempts: 1 },
      replayStore: new QwpNodeFileReplayStore({ directory }),
      durableAckKeepaliveMs: 0,
    });
    const pending = session.sendFrame(Uint8Array.of(7));
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
    connection.receive(ingressResponse(QWP_STATUS.OK, 0n, [["trades", 42n]]));
    await expect(pending).resolves.toMatchObject({ sequence: 0n });
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".qwp")),
    ).toHaveLength(1);

    connection.receive(durableResponse([["trades", 42n]]));
    await vi.waitFor(async () =>
      expect(
        (await readdir(directory)).filter((name) => name.endsWith(".qwp")),
      ).toEqual([]),
    );
    await session.close();
    await rm(directory, { recursive: true, force: true });
  });
});

describe("QWP egress reconnect and replay", () => {
  it("retries the initial connection until one provides SERVER_INFO", async () => {
    const first = new FakeConnection("primary");
    const second = new FakeConnection("secondary");
    const connections = [first, second];
    const connecting = QwpEgressSession.connect(
      async () => {
        const connection = connections.shift();
        if (!connection) throw new Error("no connection available");
        queueMicrotask(() => {
          if (connection === first) connection.drop();
          else connection.receive(serverInfo("two"));
        });
        return connection;
      },
      {
        serverInfoTimeoutMs: 100,
        reconnect: {
          maxAttempts: 2,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    );

    await expect(connecting).resolves.toMatchObject({
      handshake: { qwpVersion: 1 },
    });
    const session = await connecting;
    await session.close();
  });

  it("refreshes the negotiated Zstd level after failover", async () => {
    const first = new FakeConnection("primary", {
      qwpVersion: 1,
      contentEncoding: "zstd;level=5",
      negotiatedCompression: { codec: "zstd", level: 5 },
    });
    const second = new FakeConnection("secondary", {
      qwpVersion: 1,
      contentEncoding: "zstd;level=1",
      negotiatedCompression: { codec: "zstd", level: 1 },
    });
    const connections = [first, second];
    const session = await QwpEgressSession.connect(
      async () => {
        const connection = connections.shift();
        if (!connection) throw new Error("no connection available");
        queueMicrotask(() =>
          connection.receive(serverInfo(connection.endpoint)),
        );
        return connection;
      },
      {
        reconnect: {
          maxAttempts: 1,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    );
    expect(session.negotiatedZstdLevel).toBe(5);

    first.drop();
    await vi.waitFor(() => expect(session.negotiatedZstdLevel).toBe(1));
    expect(session.handshake.contentEncoding).toBe("zstd;level=1");
    await session.close();
  });

  it("discards queued batches, invokes reset, and replays an opted-in query", async () => {
    const first = new FakeConnection("primary");
    const second = new FakeConnection("secondary");
    const connections = [first, second];
    const resets: bigint[] = [];
    const session = await QwpEgressSession.connect(
      async () => {
        const connection = connections.shift();
        if (!connection) throw new Error("no connection available");
        queueMicrotask(() =>
          connection.receive(
            serverInfo(connection.endpoint === "primary" ? "one" : "two"),
          ),
        );
        return connection;
      },
      {
        reconnect: {
          maxAttempts: 1,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
        onReplayReset: (event) => resets.push(event.requestId!),
      },
    );
    const query = await session.query("select * from x");
    expect(first.sent).toHaveLength(1);

    // Leave this batch queued; reconnect must discard it before replay.
    first.receive(emptyResultBatch());
    const iterator = query[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    // Queue another stale prefix batch to exercise queue clearing.
    first.receive(emptyResultBatch(0n, 1));
    first.drop();

    await vi.waitFor(() => expect(resets).toEqual([0n]));
    await vi.waitFor(() => expect(second.sent).toEqual(first.sent));
    second.receive(emptyResultBatch());
    second.receive(resultEnd());

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
    await expect(query.completion).resolves.toMatchObject({
      kind: "result-end",
    });
    await session.close();
  });

  it("fails rather than silently replaying an active operation without reset", async () => {
    const first = new FakeConnection("primary");
    const second = new FakeConnection("secondary");
    const connections = [first, second];
    const session = await QwpEgressSession.connect(
      async () => {
        const connection = connections.shift();
        if (!connection) throw new Error("no connection available");
        queueMicrotask(() =>
          connection.receive(serverInfo(connection.endpoint)),
        );
        return connection;
      },
      {
        reconnect: {
          maxAttempts: 1,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    );
    const query = await session.query("update x set n = n + 1");
    first.drop();

    await expect(query.completion).rejects.toBeInstanceOf(
      QwpEgressReplayRequiredError,
    );
    await session.close();
  });
});

describe("QWP Node file replay store", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function trackedDirectory(): Promise<string> {
    const directory = await createTemporaryDirectory();
    directories.push(directory);
    return directory;
  }

  it("survives restart and deletes only the acknowledged prefix", async () => {
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({ directory });
    await expect(first.load()).resolves.toEqual([]);
    await first.append({ frameSequence: 0n, payload: Uint8Array.of(1, 2) });
    await first.append({ frameSequence: 1n, payload: Uint8Array.of(3, 4) });
    await first.close();

    const second = new QwpNodeFileReplayStore({ directory });
    await expect(second.load()).resolves.toEqual([
      { frameSequence: 0n, payload: Uint8Array.of(1, 2) },
      { frameSequence: 1n, payload: Uint8Array.of(3, 4) },
    ]);
    await second.acknowledgeThrough(0n);
    await second.close();

    const third = new QwpNodeFileReplayStore({ directory });
    await expect(third.load()).resolves.toEqual([
      { frameSequence: 1n, payload: Uint8Array.of(3, 4) },
    ]);
    await third.close();
  });

  it("holds an exclusive directory lock for the store lifetime", async () => {
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({ directory });
    await first.load();

    const second = new QwpNodeFileReplayStore({ directory });
    await expect(second.load()).rejects.toMatchObject({
      name: "QwpReplayStoreLockedError",
      directory,
      holderPid: process.pid,
      holderHostname: hostname(),
    } satisfies Partial<QwpReplayStoreLockedError>);

    await first.append({ frameSequence: 0n, payload: Uint8Array.of(7) });
    await first.close();
    await expect(second.load()).resolves.toEqual([
      { frameSequence: 0n, payload: Uint8Array.of(7) },
    ]);
    await second.close();
  });

  it("recovers a lock left by a terminated local process", async () => {
    const directory = await trackedDirectory();
    const lockDirectory = join(directory, ".qwp.lock");
    await mkdir(lockDirectory);
    await writeFile(
      join(lockDirectory, "owner.json"),
      JSON.stringify({
        version: 1,
        token: "abandoned",
        pid: 2_147_483_647,
        hostname: hostname(),
        createdAtMs: 0,
      }),
    );

    const stores = [
      new QwpNodeFileReplayStore({ directory }),
      new QwpNodeFileReplayStore({ directory }),
    ];
    const outcomes = await Promise.allSettled(
      stores.map((store) => store.load()),
    );
    const winner = outcomes.findIndex(
      (outcome) => outcome.status === "fulfilled",
    );
    const loser = winner === 0 ? 1 : 0;
    expect(winner).not.toBe(-1);
    expect(outcomes[loser]).toMatchObject({
      status: "rejected",
      reason: { name: "QwpReplayStoreLockedError" },
    });
    expect(
      (await readdir(directory)).filter((name) =>
        name.startsWith(".qwp.lock.abandoned-"),
      ),
    ).toEqual([]);
    await stores[winner].close();
    await expect(stores[loser].load()).resolves.toEqual([]);
    await stores[loser].close();
    expect(await readdir(directory)).toEqual([]);
  });

  it("recovers a persisted dictionary and truncates a torn append tail", async () => {
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({ directory });
    await first.load();
    await first.appendSymbolDictionary(0, ["ETH-USD", "BTC-USD"]);
    await first.close();
    await writeFile(
      join(directory, "symbols.qwpdict"),
      Uint8Array.of(1, 2, 3),
      { flag: "a" },
    );

    const recovered = new QwpNodeFileReplayStore({ directory });
    await recovered.load();
    await expect(recovered.loadSymbolDictionary()).resolves.toEqual([
      "ETH-USD",
      "BTC-USD",
    ]);
    await recovered.appendSymbolDictionary(2, ["SOL-USD"]);
    await recovered.close();

    const verify = new QwpNodeFileReplayStore({ directory });
    await verify.load();
    await expect(verify.loadSymbolDictionary()).resolves.toEqual([
      "ETH-USD",
      "BTC-USD",
      "SOL-USD",
    ]);
    await verify.close();
  });

  it("enforces its configured disk budget before writing", async () => {
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxBytes: 54,
    });
    await store.load();
    await expect(
      store.append({ frameSequence: 0n, payload: Uint8Array.of(1, 2, 3) }),
    ).rejects.toBeInstanceOf(QwpReplayStoreFullError);
    expect(await readdir(directory)).toEqual([".qwp.lock"]);
    await store.close();
  });

  it("fails closed when a persisted record is corrupt", async () => {
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({ directory });
    await first.load();
    await first.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
    await first.close();
    const [record] = (await readdir(directory)).filter((name) =>
      name.endsWith(".qwp"),
    );
    await writeFile(join(directory, record), Uint8Array.of(0));

    const recovered = new QwpNodeFileReplayStore({ directory });
    await expect(recovered.load()).rejects.toBeInstanceOf(QwpReplayStoreError);
    await recovered.close();
  });

  it("requires persistence when Node ingress reconnection is enabled", async () => {
    await expect(
      connectQwpNodeIngress(
        { url: "ws://127.0.0.1:1/write/v4" },
        { reconnect: { maxAttempts: 1 } },
      ),
    ).rejects.toThrow(/persistent storeAndForward directory/);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "qwp-replay-"));
}
