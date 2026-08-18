import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectQwpNodeIngress,
  QWP_SF_BACKPRESSURE_POLICY,
  QWP_SF_DURABILITY,
  QwpNodeFileReplayStore,
  QwpReplayStoreAppendTimeoutError,
  QwpReplayStoreCheckpointError,
  QwpReplayStoreCorruptionError,
  QwpReplayStoreError,
  QwpReplayStoreFullError,
  QwpReplayStoreLockedError,
  QwpReplayStoreSegmentTooLargeError,
} from "../../src/qwp/node";
import {
  QWP_RECONNECT_EVENT_KIND,
  QWP_COLUMN_TYPE,
  QWP_EGRESS_CAPABILITY,
  QWP_EGRESS_MESSAGE,
  QWP_QUERY_FLAG_RESET_DICTIONARY,
  QWP_SERVER_ROLE,
  QWP_STATUS,
  QWP_SENDER_ERROR_CATEGORY,
  QWP_SENDER_ERROR_POLICY,
  QWP_UPGRADE_ERROR_KIND,
  QwpBinaryConnection,
  QwpByteWriter,
  QwpConnectionCloseInfo,
  type QwpSenderError,
  QwpEgressSession,
  QwpEgressSessionClosedError,
  QwpIngressSession,
  QwpIngressSessionClosedError,
  QwpIngressReplayRecord,
  QwpIngressReplayStore,
  QwpHandshakeMetadata,
  QwpProtocolError,
  QwpSymbolDictionary,
  QwpTableBuffer,
  QwpReconnectEvent,
  QwpReconnectExhaustedError,
  QwpReplayRejectedError,
  QwpReplayDictionaryPersistenceError,
  QwpUnrecoverableReplayDictionaryError,
  QwpUpgradeError,
  encodeQwpFrame,
  encodeQwpDurableAckPollFrame,
  encodeQwpIngressFrame,
  encodeQwpQueryRequest,
  decodeQwpIngressSymbolDictionaryDelta,
  writeQwpVarint,
} from "../../src/qwp";
import { QwpAsyncQueue } from "../../src/qwp/internal/async-queue";
import { createQwpEgressFailoverConnectionFactory } from "../../src/qwp/internal/egress-routing";
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

function serverInfo(
  node: string,
  role = QWP_SERVER_ROLE.STANDALONE,
  zone?: string,
  capabilities = QWP_EGRESS_CAPABILITY.QUERY_FLAGS,
): Uint8Array {
  const advertisedCapabilities =
    capabilities | (zone === undefined ? 0 : QWP_EGRESS_CAPABILITY.ZONE);
  const payload = new QwpByteWriter()
    .writeUint8(QWP_EGRESS_MESSAGE.SERVER_INFO)
    .writeUint8(role)
    .writeBigUint64(1n)
    .writeUint32(advertisedCapabilities)
    .writeBigInt64(123n);
  writeUint16String(payload, "cluster");
  writeUint16String(payload, node);
  if (zone !== undefined) writeUint16String(payload, zone);
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

class FailingDictionaryPersistenceReplayStore extends TrackingReplayStore {
  appendSymbolDictionaryCalls = 0;

  async loadSymbolDictionary(): Promise<readonly string[]> {
    return [];
  }

  async appendSymbolDictionary(): Promise<void> {
    this.appendSymbolDictionaryCalls++;
    throw new Error("symbol dictionary disk is full");
  }
}

describe("QWP endpoint failover", () => {
  it("keeps a healthy endpoint sticky until a mid-stream failure", async () => {
    const attempts: string[] = [];
    let primaryAvailable = false;
    let lastSecondary: FakeConnection | undefined;
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
        const connection = new FakeConnection(String(endpoint));
        if (endpoint === "secondary") lastSecondary = connection;
        return connection;
      },
    );

    await expect(factory()).resolves.toMatchObject({ endpoint: "secondary" });
    primaryAvailable = true;
    const healthy = await factory();
    expect(healthy).toMatchObject({ endpoint: "secondary" });
    lastSecondary!.drop();
    await Promise.resolve();
    await expect(factory()).resolves.toMatchObject({ endpoint: "primary" });
    expect(attempts).toEqual(["primary", "secondary", "secondary", "primary"]);
  });

  it("validates target roles and continues the same endpoint sweep", async () => {
    const attempts: string[] = [];
    const primary = new FakeConnection("primary", {
      qwpVersion: 1,
      serverRole: "PRIMARY",
      serverZone: "eu-west-1b",
    });
    const replica = new FakeConnection("replica", {
      qwpVersion: 1,
      serverRole: "REPLICA",
      serverZone: "eu-west-1a",
    });
    const factory = createQwpFailoverConnectionFactory(
      "primary",
      ["replica"],
      async (endpoint) => {
        attempts.push(String(endpoint));
        return endpoint === "primary" ? primary : replica;
      },
      { target: "replica", zone: "EU-WEST-1A" },
    );

    await expect(factory()).resolves.toMatchObject({ endpoint: "replica" });
    await expect(primary.closed).resolves.toMatchObject({ code: 1000 });
    expect(attempts).toEqual(["primary", "replica"]);
  });

  it("ranks health before zone and zone before endpoint order", async () => {
    const attempts: string[] = [];
    const factory = createQwpFailoverConnectionFactory(
      "remote",
      ["local"],
      async (endpoint) => {
        attempts.push(String(endpoint));
        return new FakeConnection(String(endpoint), {
          qwpVersion: 1,
          serverRole: "REPLICA",
          serverZone: endpoint === "remote" ? "eu-west-1b" : "eu-west-1a",
        });
      },
      { target: "replica", zone: "eu-west-1a" },
    );

    await expect(factory()).resolves.toMatchObject({ endpoint: "remote" });
    await expect(factory()).resolves.toMatchObject({ endpoint: "remote" });
    expect(attempts).toEqual(["remote", "remote"]);

    const rejectedAttempts: string[] = [];
    const rejected = createQwpFailoverConnectionFactory(
      "remote",
      ["local"],
      async (endpoint) => {
        rejectedAttempts.push(String(endpoint));
        throw new QwpUpgradeError("role rejected", {
          kind: QWP_UPGRADE_ERROR_KIND.ROLE_REJECTED,
          retryable: true,
          tryNextEndpoint: true,
          serverRole: "PRIMARY",
          serverZone: endpoint === "remote" ? "eu-west-1b" : "eu-west-1a",
        });
      },
      { target: "replica", zone: "eu-west-1a" },
    );
    await expect(rejected()).rejects.toBeDefined();
    rejectedAttempts.length = 0;
    await expect(rejected()).rejects.toBeDefined();
    expect(rejectedAttempts).toEqual(["local", "remote"]);
  });

  it("demotes an endpoint when a send fails before the socket closes", async () => {
    const attempts: string[] = [];
    const primary = new FakeConnection("primary");
    vi.spyOn(primary, "send").mockRejectedValueOnce(new Error("send failed"));
    const factory = createQwpFailoverConnectionFactory(
      "primary",
      ["secondary"],
      async (endpoint) => {
        attempts.push(String(endpoint));
        return endpoint === "primary"
          ? primary
          : new FakeConnection("secondary");
      },
    );

    const connection = await factory();
    await expect(connection.send(Uint8Array.of(1))).rejects.toThrow(
      "send failed",
    );
    await expect(factory()).resolves.toMatchObject({ endpoint: "secondary" });
    expect(attempts).toEqual(["primary", "secondary"]);
  });

  it("rotates away from an endpoint that responds NOT_WRITABLE", async () => {
    const attempts: string[] = [];
    const connections: FakeConnection[] = [];
    const factory = createQwpFailoverConnectionFactory(
      "primary",
      ["secondary"],
      async (endpoint) => {
        attempts.push(String(endpoint));
        const connection = new FakeConnection(String(endpoint));
        connections.push(connection);
        return connection;
      },
    );
    const session = await QwpIngressSession.connect(factory, {
      reconnect: {
        maxAttempts: 1,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
      },
    });

    const pending = session.sendFrame(Uint8Array.of(9));
    const primary = connections[0];
    await vi.waitFor(() => expect(primary.sent).toHaveLength(1));
    primary.receive(ingressResponse(QWP_STATUS.NOT_WRITABLE, 0n));
    await vi.waitFor(() =>
      expect(
        connections.find((connection) => connection.endpoint === "secondary")
          ?.sent,
      ).toHaveLength(1),
    );
    const secondary = connections.find(
      (connection) => connection.endpoint === "secondary",
    )!;
    secondary.receive(ingressResponse(QWP_STATUS.OK, 0n));

    await expect(pending).resolves.toMatchObject({
      status: QWP_STATUS.OK,
      sequence: 0n,
    });
    expect(attempts).toEqual(["primary", "secondary"]);
    await session.close();
  });

  it("uses a NOT_WRITABLE endpoint only after other endpoints fail", async () => {
    const attempts: string[] = [];
    let secondaryAvailable = true;
    const factory = createQwpFailoverConnectionFactory(
      "primary",
      ["secondary"],
      async (endpoint) => {
        attempts.push(String(endpoint));
        if (endpoint === "secondary" && !secondaryAvailable) {
          throw new Error("secondary unavailable");
        }
        return new FakeConnection(String(endpoint));
      },
    );

    const primary = await factory();
    primary.deprioritizeEndpoint!();
    secondaryAvailable = false;
    await expect(factory()).resolves.toMatchObject({ endpoint: "primary" });
    expect(attempts).toEqual(["primary", "secondary", "primary"]);
  });

  it("uses SERVER_INFO for browser-compatible role validation", async () => {
    const primary = new FakeConnection("primary");
    primary.receive(serverInfo("primary", QWP_SERVER_ROLE.PRIMARY, "zone-b"));
    const replica = new FakeConnection("replica");
    replica.receive(serverInfo("replica", QWP_SERVER_ROLE.REPLICA, "zone-a"));
    const factory = createQwpEgressFailoverConnectionFactory(
      "primary",
      ["replica"],
      async (endpoint) => (endpoint === "primary" ? primary : replica),
      { target: "replica", zone: "zone-a" },
      100,
    );

    const connection = await factory();
    expect(connection.endpoint).toBe("replica");
    expect(connection.handshake).toMatchObject({
      serverRole: "REPLICA",
      serverZone: "zone-a",
    });
    const first = await connection.messages[Symbol.asyncIterator]().next();
    expect(first.done).toBe(false);
    await expect(primary.closed).resolves.toMatchObject({ code: 1000 });
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
  it("keeps default ingress initial connection establishment fail-fast", async () => {
    const failure = new Error("offline");
    let factoryCalls = 0;

    await expect(
      QwpIngressSession.connect(async () => {
        factoryCalls++;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(factoryCalls).toBe(1);
  });

  it("defaults memory-mode ingress reconnect on and replays an unacknowledged frame", async () => {
    const first = new FakeConnection("primary");
    const second = new FakeConnection("secondary");
    const connections = [first, second];
    const session = await QwpIngressSession.connect(async () => {
      const connection = connections.shift();
      if (!connection) throw new Error("no connection available");
      return connection;
    });

    const pending = session.sendFrame(Uint8Array.of(9));
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    first.drop();

    await vi.waitFor(() => expect(second.sent).toEqual(first.sent));
    second.receive(ingressResponse(QWP_STATUS.OK, 0n));
    await expect(pending).resolves.toMatchObject({
      status: QWP_STATUS.OK,
      sequence: 0n,
    });
    expect(session.metrics.totalFramesReplayed).toBe(1);
    await session.close();
  });

  it("allows automatic ingress reconnect to be disabled", async () => {
    const connection = new FakeConnection("primary");
    let factoryCalls = 0;
    const session = await QwpIngressSession.connect(
      async () => {
        factoryCalls++;
        return connection;
      },
      { reconnect: false },
    );
    const pending = session.sendFrame(Uint8Array.of(9));
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
    connection.drop();

    await expect(pending).rejects.toBeInstanceOf(QwpIngressSessionClosedError);
    expect(factoryCalls).toBe(1);
    await session.close();
  });

  it("applies full jitter to ingress reconnect backoff", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.25);
    try {
      const connection = new FakeConnection("primary");
      let factoryCalls = 0;
      const connecting = QwpIngressSession.connect(
        async () => {
          factoryCalls++;
          if (factoryCalls === 1) {
            throw new QwpUpgradeError("offline", {
              kind: QWP_UPGRADE_ERROR_KIND.TRANSPORT,
              retryable: true,
              tryNextEndpoint: true,
            });
          }
          return connection;
        },
        {
          reconnect: {
            maxAttempts: 2,
            initialBackoffMs: 100,
            maxBackoffMs: 100,
          },
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(factoryCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(24);
      expect(factoryCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      const session = await connecting;
      expect(factoryCalls).toBe(2);
      expect(random).toHaveBeenCalledTimes(1);
      await session.close();
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("supports fail-fast and bounded blocking persistent startup", async () => {
    const failFastStore = new TrackingReplayStore();
    let failFastCalls = 0;
    await expect(
      QwpIngressSession.connect(
        async () => {
          failFastCalls++;
          throw new QwpUpgradeError("offline", {
            kind: QWP_UPGRADE_ERROR_KIND.TRANSPORT,
            retryable: true,
            tryNextEndpoint: true,
          });
        },
        {
          backgroundStoreAndForward: true,
          initialConnectMode: "off",
          reconnect: {
            maxAttempts: 5,
            initialBackoffMs: 0,
            maxBackoffMs: 0,
          },
          replayStore: failFastStore,
        },
      ),
    ).rejects.toThrow("offline");
    expect(failFastCalls).toBe(1);

    const connected = new FakeConnection("primary");
    const synchronousStore = new TrackingReplayStore();
    let synchronousCalls = 0;
    const session = await QwpIngressSession.connect(
      async () => {
        if (synchronousCalls++ === 0) {
          throw new QwpUpgradeError("starting", {
            kind: QWP_UPGRADE_ERROR_KIND.TRANSPORT,
            retryable: true,
            tryNextEndpoint: true,
          });
        }
        return connected;
      },
      {
        backgroundStoreAndForward: true,
        initialConnectMode: "sync",
        reconnect: {
          maxAttempts: 2,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
        replayStore: synchronousStore,
      },
    );
    expect(synchronousCalls).toBe(2);
    expect(session.handshake).toEqual({ qwpVersion: 1 });
    await session.close();
  });

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
    expect(session.publishedFrameSequence).toBe(1n);
    expect(session.acknowledgedFrameSequence).toBe(-1n);
    const acknowledged = session.waitForAcknowledged(1n, 1_000);

    releaseOnline();
    await vi.waitFor(() =>
      expect(connection.sent).toEqual([Uint8Array.of(1), Uint8Array.of(2)]),
    );
    connection.receive(ingressResponse(QWP_STATUS.OK, 1n));
    await expect(acknowledged).resolves.toBeUndefined();
    await vi.waitFor(() => expect(replayStore.records.size).toBe(0));
    expect(session.acknowledgedFrameSequence).toBe(1n);
    expect(session.metrics).toMatchObject({
      acknowledgedSequence: 1n,
      pendingReplayFrames: 0,
      totalFramesSent: 2,
    });
    await session.close();
  });

  it("keeps an asynchronous initial authentication rejection terminal", async () => {
    const replayStore = new TrackingReplayStore();
    let factoryCalls = 0;
    const session = await QwpIngressSession.connect(
      async () => {
        factoryCalls++;
        throw new QwpUpgradeError("unauthorized", {
          kind: QWP_UPGRADE_ERROR_KIND.AUTHENTICATION,
          retryable: false,
          tryNextEndpoint: false,
        });
      },
      {
        backgroundStoreAndForward: true,
        initialConnectMode: "async",
        reconnect: {
          maxAttempts: 0,
          maxDurationMs: 0,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
        replayStore,
      },
    );
    await session.closed;
    await vi.waitFor(() =>
      expect(session.metrics.lastError?.message).toBe("unauthorized"),
    );
    expect(factoryCalls).toBe(1);
    await session.close();
  });

  it("retries endpoint-policy failures forever after foreground SF connected once", async () => {
    const first = new FakeConnection("primary");
    const replacement = new FakeConnection("primary");
    const replayStore = new TrackingReplayStore();
    let factoryCalls = 0;
    const session = await QwpIngressSession.connect(
      async () => {
        factoryCalls++;
        if (factoryCalls === 1) return first;
        if (factoryCalls === 2) {
          throw new QwpUpgradeError("credentials are rotating", {
            kind: QWP_UPGRADE_ERROR_KIND.AUTHENTICATION,
            retryable: false,
            tryNextEndpoint: false,
          });
        }
        return replacement;
      },
      {
        backgroundStoreAndForward: true,
        initialConnectMode: "off",
        reconnect: {
          // This bounds initial SYNC/non-SF reconnects, but steady foreground
          // SF recovery must keep owning the durable replay record.
          maxAttempts: 1,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
        replayStore,
      },
    );

    await session.publishFrame(Uint8Array.of(7));
    await vi.waitFor(() => expect(first.sent).toEqual([Uint8Array.of(7)]));
    first.drop();
    await vi.waitFor(() => {
      expect(factoryCalls).toBe(3);
      expect(replacement.sent).toEqual([Uint8Array.of(7)]);
    });
    replacement.receive(ingressResponse(QWP_STATUS.OK, 0n));
    await vi.waitFor(() => expect(replayStore.records.size).toBe(0));
    await session.close();
  });

  it("quarantines only orphan symbol catch-up cap gaps after count and dwell", async () => {
    const foregroundStore = new FailOnceDictionaryReplayStore();
    foregroundStore.symbols.push("x".repeat(64));
    foregroundStore.records.set(0n, Uint8Array.of(1));
    let foregroundCalls = 0;
    let recovered!: FakeConnection;
    const foreground = await QwpIngressSession.connect(
      async () => {
        foregroundCalls++;
        const cap = foregroundCalls <= 16 ? 16 : 1024;
        const candidate = new FakeConnection("primary", {
          qwpVersion: 1,
          maxBatchSizeBytes: cap,
        });
        if (cap === 1024) recovered = candidate;
        return candidate;
      },
      {
        backgroundStoreAndForward: true,
        // A blocking startup returns after its first successful WebSocket
        // connection, even when recovered dictionary catch-up must move to
        // the unbounded foreground replay loop.
        initialConnectMode: "sync",
        catchUpCapGapMinEscalationWindowMs: 0,
        reconnect: {
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
        replayStore: foregroundStore,
      },
    );
    await vi.waitFor(() => {
      expect(foregroundCalls).toBe(17);
      expect(recovered.sent).toHaveLength(2);
    });
    expect(foreground.metrics.lastError).toBeUndefined();
    await foreground.close();

    const orphanStore = new FailOnceDictionaryReplayStore();
    orphanStore.symbols.push("x".repeat(64));
    orphanStore.records.set(0n, Uint8Array.of(1));
    let orphanCalls = 0;
    const orphan = await QwpIngressSession.connect(
      async () => {
        orphanCalls++;
        return new FakeConnection("primary", {
          qwpVersion: 1,
          maxBatchSizeBytes: 16,
        });
      },
      {
        backgroundStoreAndForward: true,
        initialConnectMode: "async",
        orphanStoreAndForward: true,
        catchUpCapGapMinEscalationWindowMs: 0,
        reconnect: {
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
        replayStore: orphanStore,
      },
    );
    await orphan.closed;
    await vi.waitFor(() =>
      expect(orphan.metrics.lastError?.message).toMatch(
        /attempt=16\/16.*data must be resent/,
      ),
    );
    expect(orphanCalls).toBe(16);
    await orphan.close();
  });

  it("preserves durable dictionary IDs after frame journal backpressure", async () => {
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
      session.publishTablesDelta([symbolTable("BTC-USD")]),
    ).resolves.toBeUndefined();
    expect(replayStore.appendAttempts).toBe(2);
    expect(replayStore.symbols).toEqual(["ETH-USD", "BTC-USD"]);
    expect(
      decodeQwpIngressSymbolDictionaryDelta(replayStore.records.get(1n)!),
    ).toEqual({ startId: 0, entries: ["ETH-USD", "BTC-USD"] });
    await session.close();
  });

  it("falls back to full symbols after dictionary persistence fails", async () => {
    const connection = new FakeConnection("primary");
    const replayStore = new FailingDictionaryPersistenceReplayStore();
    const session = await QwpIngressSession.connect(async () => connection, {
      ackTimeoutMs: 1_000,
      reconnect: { maxAttempts: 1 },
      replayStore,
    });

    await expect(
      session.publishTablesDelta([symbolTable("ETH-USD")]),
    ).rejects.toBeInstanceOf(QwpReplayDictionaryPersistenceError);
    expect(replayStore.appendSymbolDictionaryCalls).toBe(1);
    expect(replayStore.records.size).toBe(0);
    expect(connection.sent).toEqual([]);

    await expect(
      session.publishTablesDelta([symbolTable("BTC-USD")]),
    ).resolves.toBeUndefined();
    expect(connection.sent).toHaveLength(1);
    expect(decodeQwpIngressSymbolDictionaryDelta(connection.sent[0])).toBe(
      undefined,
    );
    expect(replayStore.appendSymbolDictionaryCalls).toBe(1);
    expect(replayStore.records.size).toBe(1);
    await session.close();
  });

  it("keeps an ACK-waiting session usable after dictionary persistence fails", async () => {
    const connection = new FakeConnection("primary");
    const replayStore = new FailingDictionaryPersistenceReplayStore();
    const session = await QwpIngressSession.connect(async () => connection, {
      ackTimeoutMs: 1_000,
      reconnect: { maxAttempts: 1 },
      replayStore,
    });

    await expect(
      session.sendTablesDelta([symbolTable("ETH-USD")]),
    ).rejects.toBeInstanceOf(QwpReplayDictionaryPersistenceError);
    const retried = session.sendTablesDelta([symbolTable("BTC-USD")]);
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
    expect(decodeQwpIngressSymbolDictionaryDelta(connection.sent[0])).toBe(
      undefined,
    );
    connection.receive(ingressResponse(QWP_STATUS.OK, 0n));
    await expect(retried).resolves.toMatchObject({ sequence: 1n });
    await session.close();
  });

  it("uses full symbols when a replay store has no dictionary sidecar", async () => {
    const connection = new FakeConnection("primary");
    const replayStore = new TrackingReplayStore();
    const session = await QwpIngressSession.connect(async () => connection, {
      reconnect: { maxAttempts: 1 },
      replayStore,
    });

    await expect(
      session.publishTablesDelta([symbolTable("ETH-USD")]),
    ).resolves.toBeUndefined();
    expect(connection.sent).toHaveLength(1);
    expect(decodeQwpIngressSymbolDictionaryDelta(connection.sent[0])).toBe(
      undefined,
    );
    expect(replayStore.records.size).toBe(1);
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
    const senderErrors: QwpSenderError[] = [];
    const session = await QwpIngressSession.connect(
      async () => {
        const connection = connections.shift();
        if (!connection) throw new Error("no connection available");
        return connection;
      },
      {
        onSenderError: (error) => senderErrors.push(error),
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
    await vi.waitFor(() => expect(senderErrors).toHaveLength(1));
    expect(senderErrors[0]).toMatchObject({
      category: QWP_SENDER_ERROR_CATEGORY.WRITE_ERROR,
      appliedPolicy: QWP_SENDER_ERROR_POLICY.RETRIABLE,
      serverStatusByte: QWP_STATUS.WRITE_ERROR,
      messageSequence: 0n,
      fromFsn: 0n,
      toFsn: 0n,
    });
    expect(session.metrics).toMatchObject({
      totalNacks: 1,
      totalFramesSent: 2,
      totalFramesReplayed: 1,
      totalReconnectAttempts: 1,
      totalReconnectsSucceeded: 1,
      deliveredErrorNotifications: 1,
      droppedErrorNotifications: 0,
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
          poisonMinEscalationWindowMs: 0,
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

  it("allows a suspect frame to recover inside the poison dwell window", async () => {
    const first = new FakeConnection("primary");
    const second = new FakeConnection("secondary");
    const third = new FakeConnection("primary");
    const connections = [first, second, third];
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
          poisonMinEscalationWindowMs: 10_000,
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
    await vi.waitFor(() => expect(third.sent).toHaveLength(1));
    third.receive(ingressResponse(QWP_STATUS.OK, 0n));

    await expect(pending).resolves.toMatchObject({
      status: QWP_STATUS.OK,
      sequence: 0n,
    });
    await session.close();
  });

  it("does not count NOT_WRITABLE as a poison-frame strike", async () => {
    const first = new FakeConnection("replica");
    const second = new FakeConnection("primary");
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
          maxFrameRejections: 1,
          poisonMinEscalationWindowMs: 0,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    );
    const pending = session.sendFrame(Uint8Array.of(9));
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    first.receive(ingressResponse(QWP_STATUS.NOT_WRITABLE, 0n));
    await vi.waitFor(() => expect(second.sent).toHaveLength(1));
    second.receive(ingressResponse(QWP_STATUS.OK, 0n));

    await expect(pending).resolves.toMatchObject({
      status: QWP_STATUS.OK,
      sequence: 0n,
    });
    await session.close();
  });

  it("stops replaying a head frame that repeatedly causes non-orderly closes", async () => {
    const first = new FakeConnection("primary");
    const second = new FakeConnection("secondary");
    const connections = [first, second];
    const replayStore = new TrackingReplayStore();
    const session = await QwpIngressSession.connect(
      async () => {
        const connection = connections.shift();
        if (!connection) throw new Error("no connection available");
        return connection;
      },
      {
        replayStore,
        reconnect: {
          maxAttempts: 1,
          maxFrameRejections: 2,
          poisonMinEscalationWindowMs: 0,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    );
    const pending = session.sendFrame(Uint8Array.of(9));
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    first.drop();
    await vi.waitFor(() => expect(second.sent).toHaveLength(1));
    second.drop();

    await expect(pending).rejects.toThrow(/frameSequence=0, strikes=2/);
    await expect(pending).rejects.toBeInstanceOf(QwpProtocolError);
    expect(connections).toHaveLength(0);
    expect(Array.from(replayStore.records.keys())).toEqual([0n]);
    await session.close();
  });

  it("does not count orderly ingress closes as poison-frame strikes", async () => {
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
          maxFrameRejections: 1,
          poisonMinEscalationWindowMs: 0,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    );
    const pending = session.sendFrame(Uint8Array.of(9));
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    await first.close(1001, "rolling restart");
    await vi.waitFor(() => expect(second.sent).toHaveLength(1));
    second.receive(ingressResponse(QWP_STATUS.OK, 0n));

    await expect(pending).resolves.toMatchObject({
      status: QWP_STATUS.OK,
      sequence: 0n,
    });
    await session.close();
  });

  it("does not reconnect after a malformed ingress response", async () => {
    const connection = new FakeConnection("primary");
    let factoryCalls = 0;
    const session = await QwpIngressSession.connect(
      async () => {
        factoryCalls++;
        return connection;
      },
      {
        reconnect: {
          maxAttempts: 3,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    );
    const pending = session.sendFrame(Uint8Array.of(9));
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
    connection.receive(Uint8Array.of(QWP_STATUS.OK));

    await expect(pending).rejects.toBeInstanceOf(QwpProtocolError);
    expect(factoryCalls).toBe(1);
    await session.close();
  });

  it("clamps an ingress ACK to the highest wire sequence sent", async () => {
    const connection = new FakeConnection("primary");
    const session = await QwpIngressSession.connect(async () => connection, {
      reconnect: { maxAttempts: 1 },
    });
    const pending = session.sendFrame(Uint8Array.of(9));
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
    connection.receive(ingressResponse(QWP_STATUS.OK, 999n));

    await expect(pending).resolves.toMatchObject({
      status: QWP_STATUS.OK,
      sequence: 0n,
    });
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
    expect(session.acknowledgedFrameSequence).toBe(-1n);
    let watermarkSettled = false;
    const watermark = session.waitForAcknowledged(2n, 1_000).then(() => {
      watermarkSettled = true;
    });

    connection.receive(durableResponse([["trades", 41n]]));
    await vi.waitFor(() => expect(session.metrics.totalDurableAcks).toBe(1));
    expect(Array.from(replayStore.records.keys())).toEqual([0n, 1n, 2n]);
    expect(watermarkSettled).toBe(false);

    connection.receive(durableResponse([["trades", 42n]]));
    await vi.waitFor(() =>
      expect(Array.from(replayStore.records.keys())).toEqual([2n]),
    );
    expect(session.metrics.replayAcknowledgedFrameSequence).toBe(1n);
    expect(watermarkSettled).toBe(false);

    connection.receive(durableResponse([["trades", 50n]]));
    await watermark;
    await vi.waitFor(() => expect(replayStore.records.size).toBe(0));
    expect(session.metrics.replayAcknowledgedFrameSequence).toBe(2n);
    expect(session.acknowledgedFrameSequence).toBe(2n);
    await session.close();
  });

  it("continues recovered dictionary IDs until a drained close retires them", async () => {
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
        (await readdir(directory)).filter((name) => name.endsWith(".qwps")),
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
    await expect(verify.loadSymbolDictionary()).resolves.toEqual([]);
    await expect(
      verify.appendSymbolDictionary(0, ["BTC-USD"]),
    ).resolves.toBeUndefined();
    await verify.close();
    expect(await readdir(directory)).toEqual([]);
    await rm(directory, { recursive: true, force: true });
  });

  it("reconstructs and heals a truncated symbol dictionary from surviving deltas", async () => {
    const directory = await createTemporaryDirectory();
    const dictionary = new QwpSymbolDictionary();
    encodeQwpIngressFrame([symbolTable("ETH-USD")], {
      dictionary,
      confirmedMaxSymbolId: -1,
    });

    const seed = new QwpNodeFileReplayStore({ directory });
    await seed.load();
    await seed.appendSymbolDictionary(0, dictionary.entriesFrom(0));
    const persistedPrefixSize = (await stat(join(directory, "symbols.qwpdict")))
      .size;

    const replayFrame = encodeQwpIngressFrame([symbolTable("BTC-USD")], {
      dictionary,
      confirmedMaxSymbolId: 0,
    });
    await seed.appendSymbolDictionary(1, dictionary.entriesFrom(1));
    await seed.append({ frameSequence: 5n, payload: replayFrame });
    await seed.close();
    await truncate(join(directory, "symbols.qwpdict"), persistedPrefixSize);

    const connection = new FakeConnection("primary");
    const session = await QwpIngressSession.connect(async () => connection, {
      reconnect: { maxAttempts: 1 },
      replayStore: new QwpNodeFileReplayStore({ directory }),
    });
    expect(connection.sent).toHaveLength(2);
    expect(decodeQwpIngressSymbolDictionaryDelta(connection.sent[0])).toEqual({
      startId: 0,
      entries: ["ETH-USD", "BTC-USD"],
    });
    expect(connection.sent[1]).toEqual(replayFrame);
    await session.close();

    const verify = new QwpNodeFileReplayStore({ directory });
    await expect(verify.load()).resolves.toHaveLength(1);
    await expect(verify.loadSymbolDictionary()).resolves.toEqual([
      "ETH-USD",
      "BTC-USD",
    ]);
    await verify.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects a surviving delta with an unreconstructable dictionary gap", async () => {
    const directory = await createTemporaryDirectory();
    const dictionary = new QwpSymbolDictionary();
    dictionary.getOrAdd("ETH-USD");
    dictionary.getOrAdd("BTC-USD");
    const replayFrame = encodeQwpIngressFrame([symbolTable("SOL-USD")], {
      dictionary,
      confirmedMaxSymbolId: 1,
    });
    const seed = new QwpNodeFileReplayStore({ directory });
    await seed.load();
    await seed.appendSymbolDictionary(0, ["ETH-USD"]);
    await seed.append({ frameSequence: 5n, payload: replayFrame });
    await seed.close();

    await expect(
      QwpIngressSession.connect(async () => new FakeConnection("primary"), {
        reconnect: { maxAttempts: 1 },
        replayStore: new QwpNodeFileReplayStore({ directory }),
      }),
    ).rejects.toBeInstanceOf(QwpUnrecoverableReplayDictionaryError);
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
      (await readdir(directory)).filter((name) => name.endsWith(".qwps")),
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
        (await readdir(directory)).filter((name) => name.endsWith(".qwps")),
      ).toEqual([]),
    );
    expect(session.metrics).toMatchObject({
      replayAcknowledgedFrameSequence: 7n,
      pendingReplayFrames: 0,
      totalFramesReplayed: 1,
    });
    expect(session.publishedFrameSequence).toBe(7n);
    await vi.waitFor(() => expect(session.acknowledgedFrameSequence).toBe(7n));

    const currentFrame = encodeQwpIngressFrame([symbolTable("SOL-USD")]);
    const current = session.sendFrame(currentFrame);
    await vi.waitFor(() =>
      expect(connection.sent).toEqual([committed, currentFrame]),
    );
    expect(session.publishedFrameSequence).toBe(8n);
    connection.receive(ingressResponse(QWP_STATUS.OK, 1n, [["trades", 43n]]));
    await expect(current).resolves.toMatchObject({ sequence: 0n });
    connection.receive(durableResponse([["trades", 43n]]));
    await vi.waitFor(async () =>
      expect(
        (await readdir(directory)).filter((name) => name.endsWith(".qwps")),
      ).toEqual([]),
    );
    await vi.waitFor(() => expect(session.acknowledgedFrameSequence).toBe(8n));
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
        (await readdir(directory)).filter((name) => name.endsWith(".qwps")),
      ).toHaveLength(1),
    );
    connection.receive(durableResponse([["trades", 42n]]));
    await vi.waitFor(async () =>
      expect(
        (await readdir(directory)).filter((name) => name.endsWith(".qwps")),
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
      (await readdir(directory)).filter((name) => name.endsWith(".qwps")),
    ).toHaveLength(1);

    connection.receive(durableResponse([["trades", 42n]]));
    await vi.waitFor(async () =>
      expect(
        (await readdir(directory)).filter((name) => name.endsWith(".qwps")),
      ).toEqual([]),
    );
    await session.close();
    await rm(directory, { recursive: true, force: true });
  });
});

describe("QWP egress reconnect and replay", () => {
  it("keeps default initial connection establishment fail-fast", async () => {
    const failure = new Error("offline");
    let factoryCalls = 0;

    await expect(
      QwpEgressSession.connect(async () => {
        factoryCalls++;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(factoryCalls).toBe(1);
  });

  it("applies full jitter to egress reconnect backoff", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.25);
    try {
      const connection = new FakeConnection("primary");
      let factoryCalls = 0;
      const connecting = QwpEgressSession.connect(
        async () => {
          factoryCalls++;
          if (factoryCalls === 1) {
            throw new QwpUpgradeError("offline", {
              kind: QWP_UPGRADE_ERROR_KIND.TRANSPORT,
              retryable: true,
              tryNextEndpoint: true,
            });
          }
          queueMicrotask(() => connection.receive(serverInfo("primary")));
          return connection;
        },
        {
          serverInfoTimeoutMs: 1_000,
          reconnect: {
            maxAttempts: 2,
            initialBackoffMs: 100,
            maxBackoffMs: 100,
          },
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(factoryCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(24);
      expect(factoryCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      const session = await connecting;
      expect(factoryCalls).toBe(2);
      expect(random).toHaveBeenCalledTimes(1);
      await session.close();
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

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

  it("re-encodes a query queued during a capability downgrade", async () => {
    const first = new FakeConnection("primary");
    const second = new FakeConnection("secondary");
    const connections = [first, second];
    let releaseSecondInfo!: () => void;
    const secondInfoReady = new Promise<void>((resolve) => {
      releaseSecondInfo = resolve;
    });
    const session = await QwpEgressSession.connect(
      async () => {
        const connection = connections.shift();
        if (!connection) throw new Error("no connection available");
        if (connection === second) await secondInfoReady;
        queueMicrotask(() =>
          connection.receive(
            serverInfo(
              connection.endpoint,
              QWP_SERVER_ROLE.STANDALONE,
              undefined,
              connection === first ? QWP_EGRESS_CAPABILITY.QUERY_FLAGS : 0,
            ),
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
      },
    );

    first.drop();
    await vi.waitFor(() => expect(connections).toHaveLength(0));
    const querying = session.query("select 1", {
      initialCredit: 0,
      resetDictionary: true,
    });
    releaseSecondInfo();
    const query = await querying;
    expect(second.sent).toEqual([
      encodeQwpQueryRequest({
        requestId: 0n,
        sql: "select 1",
        initialCredit: 0,
      }),
    ]);
    second.receive(resultEnd());
    await expect(query.completion).resolves.toMatchObject({
      kind: "result-end",
    });
    await session.close();
  });

  it("re-encodes an active query after a capability downgrade", async () => {
    const first = new FakeConnection("primary");
    const second = new FakeConnection("secondary");
    const connections = [first, second];
    const resets: bigint[] = [];
    let bindCalls = 0;
    const session = await QwpEgressSession.connect(
      async () => {
        const connection = connections.shift();
        if (!connection) throw new Error("no connection available");
        queueMicrotask(() =>
          connection.receive(
            serverInfo(
              connection.endpoint,
              QWP_SERVER_ROLE.STANDALONE,
              undefined,
              connection === first ? QWP_EGRESS_CAPABILITY.QUERY_FLAGS : 0,
            ),
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
        onReplayReset: (event) => {
          resets.push(event.requestId);
          expect(event.serverInfo).toMatchObject({
            nodeId: "secondary",
            capabilities: 0,
          });
        },
      },
    );
    const query = await session.query("select $1", {
      initialCredit: 0,
      resetDictionary: true,
      binds: (binds) => {
        bindCalls++;
        binds.setInt(0, 42);
      },
    });
    expect(first.sent).toHaveLength(1);
    expect(first.sent[0].at(-1)).toBe(QWP_QUERY_FLAG_RESET_DICTIONARY);

    first.drop();
    await vi.waitFor(() => expect(resets).toEqual([0n]));
    await vi.waitFor(() => expect(second.sent).toHaveLength(1));
    expect(second.sent[0]).toEqual(first.sent[0].subarray(0, -1));
    expect(bindCalls).toBe(1);

    second.receive(resultEnd());
    await expect(query.completion).resolves.toMatchObject({
      kind: "result-end",
    });
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
        bufferPoolSize: 1,
        onReplayReset: (event) => resets.push(event.requestId),
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
    // Fill the decoded pool, then block the receive loop on one more stale
    // batch. Reset must wake the waiter without publishing either batch.
    first.receive(emptyResultBatch(0n, 2));
    await Promise.resolve();
    await Promise.resolve();
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

  it("waits for an active reusable view before resetting it for replay", async () => {
    const first = new FakeConnection("primary");
    const second = new FakeConnection("secondary");
    const connections = [first, second];
    const resets: bigint[] = [];
    let releaseFirstView!: () => void;
    const firstViewReleased = new Promise<void>((resolve) => {
      releaseFirstView = resolve;
    });
    let viewCalls = 0;
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
        onReplayReset: (event) => resets.push(event.requestId),
      },
    );
    const query = await session.queryViews("select * from x", async () => {
      viewCalls++;
      if (viewCalls === 1) await firstViewReleased;
    });
    first.receive(emptyResultBatch());
    await vi.waitFor(() => expect(viewCalls).toBe(1));

    first.drop();
    await Promise.resolve();
    expect(resets).toEqual([]);
    expect(second.sent).toEqual([]);
    releaseFirstView();

    await vi.waitFor(() => expect(resets).toEqual([0n]));
    await vi.waitFor(() => expect(second.sent.length).toBeGreaterThan(0));
    expect(second.sent[0]).toEqual(first.sent[0]);
    second.receive(emptyResultBatch());
    second.receive(resultEnd());
    await expect(query.completion).resolves.toMatchObject({
      kind: "result-end",
    });
    expect(viewCalls).toBe(2);
    await session.close();
  });

  it("defaults failover on and replays an active operation without a reset callback", async () => {
    const first = new FakeConnection("primary");
    const second = new FakeConnection("secondary");
    const connections = [first, second];
    const session = await QwpEgressSession.connect(async () => {
      const connection = connections.shift();
      if (!connection) throw new Error("no connection available");
      queueMicrotask(() => connection.receive(serverInfo(connection.endpoint)));
      return connection;
    });
    const query = await session.query("update x set n = n + 1");
    first.drop();

    await vi.waitFor(() => expect(second.sent).toEqual(first.sent));
    second.receive(resultEnd());
    await expect(query.completion).resolves.toMatchObject({
      kind: "result-end",
    });
    await session.close();
  });

  it("allows automatic egress failover to be disabled", async () => {
    const first = new FakeConnection("primary");
    let factoryCalls = 0;
    const session = await QwpEgressSession.connect(
      async () => {
        factoryCalls++;
        queueMicrotask(() => first.receive(serverInfo("primary")));
        return first;
      },
      { reconnect: false },
    );
    const query = await session.query("select 1");
    first.drop();

    await expect(query.completion).rejects.toBeInstanceOf(
      QwpEgressSessionClosedError,
    );
    expect(factoryCalls).toBe(1);
    await session.close();
  });

  it("fails over and replays after a result decoder protocol error", async () => {
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
    const query = await session.query("select * from x");
    first.receive(emptyResultBatch(0n, 1));

    await vi.waitFor(() => expect(second.sent).toEqual(first.sent));
    second.receive(emptyResultBatch());
    second.receive(resultEnd());
    const iterator = query[Symbol.asyncIterator]();
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

  it("rotates endpoints after a malformed egress frame", async () => {
    const attempts: string[] = [];
    const connections = new Map<string, FakeConnection>();
    const factory = createQwpEgressFailoverConnectionFactory(
      "primary",
      ["secondary"],
      async (endpoint) => {
        const name = String(endpoint);
        attempts.push(name);
        const connection = new FakeConnection(name);
        connections.set(name, connection);
        connection.receive(serverInfo(name));
        return connection;
      },
      {},
      100,
    );
    const session = await QwpEgressSession.connect(factory, {
      reconnect: {
        maxAttempts: 1,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
      },
    });
    const primary = connections.get("primary")!;
    const query = await session.query("select 1");
    primary.receive(Uint8Array.of(0xff));

    await vi.waitFor(() =>
      expect(connections.get("secondary")?.sent).toEqual(primary.sent),
    );
    const secondary = connections.get("secondary")!;
    secondary.receive(resultEnd());
    await expect(query.completion).resolves.toMatchObject({
      kind: "result-end",
    });
    expect(attempts).toEqual(["primary", "secondary"]);
    await session.close();
  });

  it("recovers an idle session after an invalid terminal response", async () => {
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

    first.receive(resultEnd());
    await vi.waitFor(() => expect(connections).toHaveLength(0));
    const query = await session.query("select 1");
    expect(second.sent).toHaveLength(1);
    second.receive(resultEnd());
    await expect(query.completion).resolves.toMatchObject({
      kind: "result-end",
    });
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

  it("validates durability, checkpoint, and disk-backpressure controls", async () => {
    const directory = await trackedDirectory();

    expect(
      () =>
        new QwpNodeFileReplayStore({
          directory,
          durability: "unsupported" as "append",
        }),
    ).toThrow(/unsupported store-and-forward durability/);
    expect(
      () =>
        new QwpNodeFileReplayStore({
          directory,
          backpressurePolicy: "unsupported" as "error",
        }),
    ).toThrow(/unsupported store-and-forward backpressurePolicy/);
    expect(
      () => new QwpNodeFileReplayStore({ directory, checkpointIntervalMs: 1 }),
    ).toThrow(/requires durability='periodic'/);
    expect(
      () =>
        new QwpNodeFileReplayStore({
          directory,
          durability: QWP_SF_DURABILITY.PERIODIC,
          checkpointIntervalMs: 0,
        }),
    ).toThrow(/checkpointIntervalMs must be a positive safe integer/);
    expect(
      () => new QwpNodeFileReplayStore({ directory, appendDeadlineMs: 0 }),
    ).toThrow(/appendDeadlineMs must be a positive safe integer/);
    expect(
      () => new QwpNodeFileReplayStore({ directory, maxSegmentBytes: 0 }),
    ).toThrow(/maxSegmentBytes must be a positive safe integer/);

    const segmented = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 2,
    });
    await segmented.load();
    await expect(
      segmented.append({
        frameSequence: 0n,
        payload: Uint8Array.of(1, 2, 3),
      }),
    ).rejects.toBeInstanceOf(QwpReplayStoreSegmentTooLargeError);
    await segmented.close();

    const defaults = new QwpNodeFileReplayStore({ directory });
    expect(defaults.metrics).toMatchObject({
      durability: QWP_SF_DURABILITY.APPEND,
      backpressurePolicy: QWP_SF_BACKPRESSURE_POLICY.ERROR,
      totalCheckpoints: 0,
      totalBackpressureStalls: 0,
    });
    await defaults.close();
  });

  it("survives restart and deletes only the acknowledged prefix", async () => {
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({ directory });
    await expect(first.load()).resolves.toEqual([]);
    await first.append({ frameSequence: 0n, payload: Uint8Array.of(1, 2) });
    await first.append({ frameSequence: 1n, payload: Uint8Array.of(3, 4) });
    await first.close();
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".qwps")),
    ).toHaveLength(1);

    const second = new QwpNodeFileReplayStore({ directory });
    await expect(second.load()).resolves.toEqual([
      { frameSequence: 0n, payload: Uint8Array.of(1, 2) },
      { frameSequence: 1n, payload: Uint8Array.of(3, 4) },
    ]);
    await second.acknowledgeThrough(0n);
    await second.close();
    expect(await readdir(directory)).toEqual(
      expect.arrayContaining(["ack.qwpstate"]),
    );

    const third = new QwpNodeFileReplayStore({ directory });
    await expect(third.load()).resolves.toEqual([
      { frameSequence: 1n, payload: Uint8Array.of(3, 4) },
    ]);
    await third.close();
  });

  it("detects a replay gap immediately after a persisted ACK watermark", async () => {
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({ directory });
    await first.load();
    for (let sequence = 0n; sequence < 3n; sequence++) {
      await first.append({
        frameSequence: sequence,
        payload: Uint8Array.of(Number(sequence)),
      });
    }
    await first.acknowledgeThrough(0n);
    await first.close();

    const segment = (await readdir(directory)).find((name) =>
      name.endsWith(".qwps"),
    )!;
    const path = join(directory, segment);
    await truncate(path, 53);
    await writeFile(path, encodeLegacyReplayRecord(2n, Uint8Array.of(2)), {
      flag: "a",
    });

    const recovered = new QwpNodeFileReplayStore({ directory });
    await expect(recovered.load()).rejects.toThrow(
      /sequence has a gap \[previous=0, received=2\]/,
    );
    await recovered.close();
  });

  it("coalesces many replay frames into bounded segment files", async () => {
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 256,
    });
    await store.load();
    for (let sequence = 0n; sequence < 25n; sequence++) {
      await store.append({
        frameSequence: sequence,
        payload: Uint8Array.of(1),
      });
    }
    const segments = (await readdir(directory)).filter((name) =>
      name.endsWith(".qwps"),
    );
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.length).toBeLessThan(25);
    expect(store.metrics).toMatchObject({
      pendingRecords: 25,
      pendingSegments: segments.length,
    });
    for (const segment of segments) {
      expect((await stat(join(directory, segment))).size).toBeLessThanOrEqual(
        256 + 52,
      );
    }
    await store.close();
  });

  it("repairs a torn append at the tail of the active segment", async () => {
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({ directory });
    await first.load();
    await first.append({ frameSequence: 0n, payload: Uint8Array.of(1, 2, 3) });
    await first.close();
    const segment = (await readdir(directory)).find((name) =>
      name.endsWith(".qwps"),
    )!;
    const validSize = (await stat(join(directory, segment))).size;
    await writeFile(join(directory, segment), Uint8Array.of(0x51, 0x57), {
      flag: "a",
    });

    const recovered = new QwpNodeFileReplayStore({ directory });
    await expect(recovered.load()).resolves.toEqual([
      { frameSequence: 0n, payload: Uint8Array.of(1, 2, 3) },
    ]);
    expect((await stat(join(directory, segment))).size).toBe(validSize);
    await recovered.close();
  });

  it("loads legacy file-per-frame records and writes new segmented appends", async () => {
    const directory = await trackedDirectory();
    await writeFile(
      join(directory, "00000000000000000005.qwp"),
      encodeLegacyReplayRecord(5n, Uint8Array.of(1, 2)),
    );

    const first = new QwpNodeFileReplayStore({ directory });
    await expect(first.load()).resolves.toEqual([
      { frameSequence: 5n, payload: Uint8Array.of(1, 2) },
    ]);
    await first.append({ frameSequence: 6n, payload: Uint8Array.of(3, 4) });
    await first.close();
    expect(await readdir(directory)).toEqual(
      expect.arrayContaining([
        "00000000000000000005.qwp",
        "00000000000000000006.qwps",
      ]),
    );

    const recovered = new QwpNodeFileReplayStore({ directory });
    await expect(recovered.load()).resolves.toEqual([
      { frameSequence: 5n, payload: Uint8Array.of(1, 2) },
      { frameSequence: 6n, payload: Uint8Array.of(3, 4) },
    ]);
    await recovered.close();
  });

  it.each([
    QWP_SF_DURABILITY.APPEND,
    QWP_SF_DURABILITY.PERIODIC,
    QWP_SF_DURABILITY.MEMORY,
  ])(
    "retires a fully drained %s dictionary generation on close",
    async (durability) => {
      const directory = await trackedDirectory();
      const first = new QwpNodeFileReplayStore({ directory, durability });
      await first.load();
      await first.appendSymbolDictionary(0, ["ETH-USD"]);
      await first.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
      await first.acknowledgeThrough(0n);

      // Keep the generation intact while the store is open. An ACK may race
      // between this suffix and the frame that will reference it.
      await first.appendSymbolDictionary(1, ["BTC-USD"]);
      await expect(first.loadSymbolDictionary()).resolves.toEqual([
        "ETH-USD",
        "BTC-USD",
      ]);
      expect(await readdir(directory)).toContain("symbols.qwpdict");
      await first.close();
      expect(await readdir(directory)).toEqual([]);

      const second = new QwpNodeFileReplayStore({ directory, durability });
      await expect(second.load()).resolves.toEqual([]);
      await expect(second.loadSymbolDictionary()).resolves.toEqual([]);
      await expect(
        second.appendSymbolDictionary(0, ["BTC-USD"]),
      ).resolves.toBeUndefined();
      await second.close();
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it("retains the dictionary when a close leaves replay frames behind", async () => {
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({ directory });
    await first.load();
    await first.appendSymbolDictionary(0, ["ETH-USD"]);
    await first.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
    await first.append({ frameSequence: 1n, payload: Uint8Array.of(2) });
    await first.acknowledgeThrough(0n);
    await first.close();

    const second = new QwpNodeFileReplayStore({ directory });
    await expect(second.load()).resolves.toEqual([
      { frameSequence: 1n, payload: Uint8Array.of(2) },
    ]);
    await expect(second.loadSymbolDictionary()).resolves.toEqual(["ETH-USD"]);
    await second.acknowledgeThrough(1n);
    await second.close();
    expect(await readdir(directory)).toEqual([]);
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
    await first.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
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
    await verify.acknowledgeThrough(0n);
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

  it("checkpoints periodic frame and dictionary writes", async () => {
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      durability: QWP_SF_DURABILITY.PERIODIC,
      checkpointIntervalMs: 25,
    });
    await store.load();
    await store.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
    await store.appendSymbolDictionary(0, ["BTC-USD"]);
    expect(store.metrics.checkpointPending).toBe(true);

    await vi.waitFor(() => {
      expect(store.metrics.dirtyRecords).toBe(0);
      expect(store.metrics.checkpointPending).toBe(false);
      expect(store.metrics.totalCheckpoints).toBeGreaterThan(0);
      expect(store.metrics.totalCheckpointFailures).toBe(0);
    });
    await store.close();

    const recovered = new QwpNodeFileReplayStore({ directory });
    await expect(recovered.load()).resolves.toEqual([
      { frameSequence: 0n, payload: Uint8Array.of(1) },
    ]);
    await expect(recovered.loadSymbolDictionary()).resolves.toEqual([
      "BTC-USD",
    ]);
    await recovered.close();
  });

  it("supports memory durability without running checkpoints", async () => {
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      durability: QWP_SF_DURABILITY.MEMORY,
    });
    await store.load();
    await store.append({ frameSequence: 0n, payload: Uint8Array.of(7) });
    await store.appendSymbolDictionary(0, ["ETH-USD"]);
    expect(store.metrics).toMatchObject({
      durability: QWP_SF_DURABILITY.MEMORY,
      dirtyRecords: 0,
      checkpointPending: false,
      totalCheckpoints: 0,
    });
    await store.close();
  });

  it("fails waiting appends closed when a periodic checkpoint fails", async () => {
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxBytes: 106,
      durability: QWP_SF_DURABILITY.PERIODIC,
      checkpointIntervalMs: 250,
      backpressurePolicy: QWP_SF_BACKPRESSURE_POLICY.WAIT,
      appendDeadlineMs: 2_000,
    });
    await store.load();
    await store.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
    await store.append({ frameSequence: 1n, payload: Uint8Array.of(2) });
    const record = (await readdir(directory)).find((name) =>
      name.endsWith(".qwps"),
    );
    expect(record).toBeDefined();
    await unlink(join(directory, record!));

    const blocked = store.append({
      frameSequence: 2n,
      payload: Uint8Array.of(3),
    });
    await vi.waitFor(() => expect(store.metrics.waitingAppends).toBe(1));
    await expect(blocked).rejects.toBeInstanceOf(QwpReplayStoreCheckpointError);
    expect(store.metrics).toMatchObject({
      waitingAppends: 0,
      totalCheckpointFailures: 1,
      totalAppendTimeouts: 0,
    });
    await expect(store.close()).rejects.toBeInstanceOf(
      QwpReplayStoreCheckpointError,
    );
    expect(await readdir(directory)).not.toContain(".qwp.lock");
  });

  it("waits for ACK trimming without blocking the acknowledgement queue", async () => {
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxBytes: 106,
      maxSegmentBytes: 1,
      backpressurePolicy: QWP_SF_BACKPRESSURE_POLICY.WAIT,
      appendDeadlineMs: 1_000,
    });
    await store.load();
    await store.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
    await store.append({ frameSequence: 1n, payload: Uint8Array.of(2) });

    const blocked = store.append({
      frameSequence: 2n,
      payload: Uint8Array.of(3),
    });
    await vi.waitFor(() => expect(store.metrics.waitingAppends).toBe(1));
    await store.acknowledgeThrough(0n);
    await expect(blocked).resolves.toBeUndefined();
    expect(store.metrics).toMatchObject({
      pendingRecords: 2,
      waitingAppends: 0,
      totalBackpressureStalls: 1,
      totalAppendTimeouts: 0,
    });
    await store.close();
  });

  it("bounds disk-backpressure waits with a typed append timeout", async () => {
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxBytes: 106,
      backpressurePolicy: QWP_SF_BACKPRESSURE_POLICY.WAIT,
      appendDeadlineMs: 100,
    });
    await store.load();
    await store.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
    await store.append({ frameSequence: 1n, payload: Uint8Array.of(2) });

    const blocked = store.append({
      frameSequence: 2n,
      payload: Uint8Array.of(3),
    });
    const rejection = expect(blocked).rejects.toMatchObject({
      name: "QwpReplayStoreAppendTimeoutError",
      maxBytes: 106,
      requiredBytes: 159,
      timeoutMs: 100,
    } satisfies Partial<QwpReplayStoreAppendTimeoutError>);
    await vi.waitFor(() => expect(store.metrics.waitingAppends).toBe(1));
    await rejection;
    expect(store.metrics).toMatchObject({
      waitingAppends: 0,
      totalBackpressureStalls: 1,
      totalAppendTimeouts: 1,
    });
    await store.close();
  });

  it("preserves a live frame budget after dictionary growth exhausts the target", async () => {
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({
      directory,
      maxBytes: 60,
    });
    await first.load();
    // Header + block metadata + this entry occupy 66 bytes, already above
    // the configured target. Unlike frame bytes, this prefix never shrinks.
    await first.appendSymbolDictionary(0, ["abcdefghij"]);
    await expect(
      first.append({ frameSequence: 0n, payload: Uint8Array.of(1) }),
    ).resolves.toBeUndefined();
    await expect(
      first.append({ frameSequence: 1n, payload: Uint8Array.of(2) }),
    ).rejects.toBeInstanceOf(QwpReplayStoreFullError);

    await first.acknowledgeThrough(0n);
    await expect(
      first.append({ frameSequence: 1n, payload: Uint8Array.of(2) }),
    ).resolves.toBeUndefined();
    await first.close();

    const recovered = new QwpNodeFileReplayStore({
      directory,
      maxBytes: 60,
    });
    await expect(recovered.load()).resolves.toEqual([
      { frameSequence: 1n, payload: Uint8Array.of(2) },
    ]);
    await expect(recovered.loadSymbolDictionary()).resolves.toEqual([
      "abcdefghij",
    ]);
    await recovered.acknowledgeThrough(1n);
    await expect(
      recovered.append({ frameSequence: 2n, payload: Uint8Array.of(3) }),
    ).resolves.toBeUndefined();
    await recovered.close();
  });

  it("fails closed when a persisted record is corrupt", async () => {
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({ directory });
    await first.load();
    await first.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
    await first.close();
    const [record] = (await readdir(directory)).filter((name) =>
      name.endsWith(".qwps"),
    );
    await writeFile(join(directory, record), Uint8Array.of(0));

    const recovered = new QwpNodeFileReplayStore({ directory });
    await expect(recovered.load()).rejects.toBeInstanceOf(
      QwpReplayStoreCorruptionError,
    );
    await recovered.close();
  });

  it("accepts tuned in-memory reconnect for Node ingress", async () => {
    await expect(
      connectQwpNodeIngress(
        { url: "ws://127.0.0.1:1/write/v4" },
        { reconnect: { maxAttempts: 1 } },
      ),
    ).rejects.toBeInstanceOf(QwpReconnectExhaustedError);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "qwp-replay-"));
}

function encodeLegacyReplayRecord(
  frameSequence: bigint,
  payload: Uint8Array,
): Buffer {
  const bytes = Buffer.alloc(52 + payload.byteLength);
  bytes.write("QWPR", 0, "ascii");
  bytes.writeUInt8(1, 4);
  bytes.writeBigUInt64LE(frameSequence, 8);
  bytes.writeUInt32LE(payload.byteLength, 16);
  createHash("sha256").update(payload).digest().copy(bytes, 20);
  Buffer.from(payload).copy(bytes, 52);
  return bytes;
}
