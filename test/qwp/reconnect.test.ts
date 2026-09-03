import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  truncate,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectQwpNodeIngress,
  QWP_ORPHAN_FAILED_SENTINEL,
  QWP_SF_BACKPRESSURE_POLICY,
  QWP_SF_DURABILITY,
  QwpNodeFileReplayStore,
  QwpNodeOrphanDrainer,
  QwpReplayStoreAppendTimeoutError,
  QwpReplayStoreCheckpointError,
  QwpReplayStoreCorruptionError,
  QwpReplayStoreError,
  QwpReplayStoreFullError,
  QwpReplayStoreLockedError,
  QwpReplayStoreLockLostError,
  QwpReplayStoreSegmentTooLargeError,
  type QwpNodeReplayDataLossReport,
} from "../../packages/nodejs-client/src";
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
  QwpDurableAckUnavailableError,
  QwpFailoverError,
  type QwpSenderError,
  QwpEgressSession,
  QwpEgressSessionClosedError,
  QwpIngressSession,
  QwpIngressSessionClosedError,
  QwpIngressReplayRecord,
  QwpIngressReplayReference,
  QwpIngressReplayStore,
  QwpHandshakeMetadata,
  QwpMemoryReplayAppendTimeoutError,
  QwpMemoryReplayFrameTooLargeError,
  QwpProtocolError,
  QwpSymbolDictionary,
  QwpTableBuffer,
  QwpReconnectEvent,
  QwpReconnectExhaustedError,
  QwpReplayRejectedError,
  QwpReplayDictionaryPersistenceError,
  QwpSender,
  QwpUnrecoverableReplayDictionaryError,
  QwpUpgradeError,
  encodeQwpFrame,
  encodeQwpDurableAckPollFrame,
  encodeQwpIngressFrame,
  encodeQwpQueryRequest,
  decodeQwpIngressSymbolDictionaryDelta,
  writeQwpVarint,
} from "../../packages/client-core/src/qwp";
import { QwpNodeAdvisoryLock } from "../../packages/nodejs-client/src/qwp-node/advisory-lock";
import { QwpAsyncQueue } from "../../packages/client-core/src/_qwp/_internal/async-queue";
import { qwpSegmentMaintenanceWorker } from "../../packages/nodejs-client/src/qwp-node/segment-maintenance-worker";
import { createQwpEgressFailoverConnectionFactory } from "../../packages/client-core/src/_qwp/_internal/egress-routing";
import {
  createQwpFailoverConnectionFactory,
  createQwpFailoverHealthTracker,
} from "../../packages/client-core/src/_qwp/_internal/failover";

async function expectOnlyJavaSlotLockMetadata(
  directory: string,
): Promise<void> {
  expect((await readdir(directory)).sort()).toEqual([".lock", ".lock.pid"]);
}

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
  role: number = QWP_SERVER_ROLE.STANDALONE,
  zone?: string,
  capabilities: number = QWP_EGRESS_CAPABILITY.QUERY_FLAGS,
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

/** A batch declaring a column type no QWP client build knows how to decode. */
function undecodableResultBatch(requestId = 0n): Uint8Array {
  const payload = new QwpByteWriter()
    .writeUint8(QWP_EGRESS_MESSAGE.RESULT_BATCH)
    .writeBigUint64(requestId);
  writeQwpVarint(payload, 0); // batch sequence
  writeQwpVarint(payload, 0); // table name
  writeQwpVarint(payload, 1); // row count
  writeQwpVarint(payload, 1); // column count
  writeQwpVarint(payload, 1);
  payload.writeUint8(0x63); // column name "c"
  payload.writeUint8(0xfe); // column type
  payload.writeUint8(0x00); // encoding
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

function symbolRows(symbols: readonly string[]): QwpTableBuffer {
  const table = new QwpTableBuffer("trades");
  for (const symbol of symbols) {
    table
      .getOrCreateColumn("symbol", QWP_COLUMN_TYPE.SYMBOL)!
      .values.push(symbol);
    table.nextRow();
  }
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

  drop(code = 1006, reason = "connection lost"): void {
    this.finish({ code, reason, wasClean: false });
  }

  transportError(): void {
    this.incoming.fail(new Error("WebSocket transport error"));
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

/** Mirrors QwpNodeFileReplayStore.close() rethrowing a teardown failure. */
class CloseFaultStore extends TrackingReplayStore {
  closeAttempts = 0;

  override async close(): Promise<void> {
    this.closeAttempts++;
    throw new Error("could not release QWP advisory lock");
  }
}

class LazyTrackingReplayStore extends TrackingReplayStore {
  readonly reads: bigint[] = [];
  loadCalls = 0;

  override async load(): Promise<readonly QwpIngressReplayRecord[]> {
    this.loadCalls++;
    throw new Error("eager replay load must not be used");
  }

  async loadReferences(): Promise<readonly QwpIngressReplayReference[]> {
    return Array.from(this.records, ([frameSequence, payload]) => ({
      frameSequence,
      payloadLength: payload.byteLength,
    }));
  }

  async readPayload(frameSequence: bigint): Promise<Uint8Array> {
    this.reads.push(frameSequence);
    const payload = this.records.get(frameSequence);
    if (!payload) throw new Error(`missing replay frame ${frameSequence}`);
    return payload.slice();
  }
}

class FailOnceDictionaryReplayStore extends TrackingReplayStore {
  readonly symbols: string[] = [];
  appendAttempts = 0;

  constructor(private readonly failOnAppendAttempt = 1) {
    super();
  }

  override async append(record: QwpIngressReplayRecord): Promise<void> {
    this.appendAttempts++;
    if (this.appendAttempts === this.failOnAppendAttempt) {
      throw new Error("journal is full");
    }
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

/** Rejects sequence holes the way QwpNodeFileReplayStore does. */
class ContiguousReplayStore extends TrackingReplayStore {
  appendAttempts = 0;
  private lastSequence?: bigint;

  constructor(private readonly failOnAppendAttempt = 1) {
    super();
  }

  override async append(record: QwpIngressReplayRecord): Promise<void> {
    this.appendAttempts++;
    if (this.appendAttempts === this.failOnAppendAttempt) {
      throw new Error("journal is full");
    }
    const expected =
      this.lastSequence === undefined ? 0n : this.lastSequence + 1n;
    if (record.frameSequence !== expected) {
      throw new Error(
        "QWP store-and-forward sequence must be contiguous " +
          `[previous=${this.lastSequence ?? -1n}, received=${record.frameSequence}]`,
      );
    }
    this.lastSequence = record.frameSequence;
    await super.append(record);
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
  it("shares live health without sharing concurrent sweep cursors", async () => {
    const tracker = createQwpFailoverHealthTracker("primary", ["secondary"]);
    const attempts: string[] = [];
    const createFactory = (walker: string) =>
      createQwpFailoverConnectionFactory(
        "primary",
        ["secondary"],
        async (endpoint) => {
          attempts.push(`${walker}:${endpoint}`);
          return new FakeConnection(String(endpoint));
        },
        { healthTracker: tracker },
      );
    const first = createFactory("first");
    const second = createFactory("second");

    await Promise.all([first(), second()]);
    expect(attempts).toEqual(["first:primary", "second:primary"]);

    const primary = await first();
    primary.deprioritizeEndpoint!();
    const sharedObservation = await second();
    expect(sharedObservation.endpoint).toBe("secondary");
  });

  it("keeps only the newest same-zone success sticky across resets", () => {
    const tracker = createQwpFailoverHealthTracker(
      "older-local",
      ["newer-local", "remote"],
      { target: "replica", zone: "zone-a" },
    );
    tracker.recordZone(0, "zone-a");
    tracker.recordSuccess(0);
    tracker.recordZone(1, "zone-a");
    tracker.recordSuccess(1);
    tracker.recordZone(2, "zone-b");
    tracker.recordSuccess(2);

    tracker.forgetClassifications();
    const cursor = tracker.newRoundCursor();
    expect([
      cursor.next(),
      cursor.next(),
      cursor.next(),
      cursor.next(),
    ]).toEqual([1, 0, 2, undefined]);
  });

  it("lets background walkers retain shared classifications across sweeps", async () => {
    const run = async (resetClassificationsAfterExhaustion: boolean) => {
      const attempts: string[] = [];
      const factory = createQwpFailoverConnectionFactory(
        "topology-reject",
        ["transport-error"],
        async (endpoint) => {
          attempts.push(String(endpoint));
          if (endpoint === "topology-reject") {
            throw new QwpUpgradeError("wrong role", {
              kind: QWP_UPGRADE_ERROR_KIND.ROLE_REJECTED,
              retryable: true,
              tryNextEndpoint: true,
              serverRole: "REPLICA",
            });
          }
          throw new Error("unreachable");
        },
        { resetClassificationsAfterExhaustion },
      );
      await expect(factory()).rejects.toBeDefined();
      attempts.length = 0;
      await expect(factory()).rejects.toBeDefined();
      return attempts;
    };

    await expect(run(true)).resolves.toEqual([
      "topology-reject",
      "transport-error",
    ]);
    await expect(run(false)).resolves.toEqual([
      "transport-error",
      "topology-reject",
    ]);
  });

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
  it("bounds memory replay and resumes publication after ACK trimming", async () => {
    const connection = new FakeConnection("primary");
    const session = await QwpIngressSession.connect(async () => connection, {
      memoryReplayMaxBytes: 130,
      memoryReplayAppendDeadlineMs: 1_000,
    });

    await session.publishFrame(Uint8Array.of(1));
    await session.publishFrame(Uint8Array.of(2));
    const blocked = session.publishFrame(Uint8Array.of(3));

    await vi.waitFor(() =>
      expect(session.metrics).toMatchObject({
        memoryReplayMaxBytes: 130,
        memoryReplayUsedBytes: 130,
        waitingMemoryReplayAppends: 1,
        totalMemoryReplayBackpressureStalls: 1,
        totalMemoryReplayAppendTimeouts: 0,
      }),
    );
    expect(connection.sent).toEqual([Uint8Array.of(1), Uint8Array.of(2)]);

    connection.receive(ingressResponse(QWP_STATUS.OK, 0n));
    await expect(blocked).resolves.toBeUndefined();
    expect(connection.sent).toEqual([
      Uint8Array.of(1),
      Uint8Array.of(2),
      Uint8Array.of(3),
    ]);
    expect(session.metrics).toMatchObject({
      memoryReplayUsedBytes: 130,
      waitingMemoryReplayAppends: 0,
      totalMemoryReplayBackpressureStalls: 1,
      totalMemoryReplayAppendTimeouts: 0,
    });
    await session.close();
  });

  it("bounds memory replay waits with typed capacity errors", async () => {
    const connection = new FakeConnection("primary");
    const session = await QwpIngressSession.connect(async () => connection, {
      memoryReplayMaxBytes: 65,
      memoryReplayAppendDeadlineMs: 50,
    });

    await session.publishFrame(Uint8Array.of(1));
    await expect(session.publishFrame(Uint8Array.of(2))).rejects.toMatchObject({
      name: "QwpMemoryReplayAppendTimeoutError",
      maxBytes: 65,
      usedBytes: 65,
      requiredBytes: 65,
      timeoutMs: 50,
    } satisfies Partial<QwpMemoryReplayAppendTimeoutError>);
    expect(session.metrics).toMatchObject({
      pendingReplayFrames: 1,
      pendingReplayBytes: 1,
      waitingMemoryReplayAppends: 0,
      totalMemoryReplayBackpressureStalls: 1,
      totalMemoryReplayAppendTimeouts: 1,
    });

    await expect(
      QwpIngressSession.connect(async () => new FakeConnection("other"), {
        memoryReplayMaxBytes: 64,
      }).then((tooSmall) =>
        tooSmall.publishFrame(Uint8Array.of(1)).finally(() => tooSmall.close()),
      ),
    ).rejects.toBeInstanceOf(QwpMemoryReplayFrameTooLargeError);
    await session.close();
  });

  it("interrupts a memory replay capacity wait on close", async () => {
    const connection = new FakeConnection("primary");
    const session = await QwpIngressSession.connect(async () => connection, {
      memoryReplayMaxBytes: 65,
      memoryReplayAppendDeadlineMs: 60_000,
    });

    await session.publishFrame(Uint8Array.of(1));
    const blocked = session.publishFrame(Uint8Array.of(2));
    const rejected = expect(blocked).rejects.toMatchObject({
      name: "QwpSendClosedError",
    });
    await vi.waitFor(() =>
      expect(session.metrics.waitingMemoryReplayAppends).toBe(1),
    );

    await session.close();
    await rejected;
    expect(session.metrics).toMatchObject({
      pendingReplayFrames: 0,
      pendingReplayBytes: 0,
      memoryReplayUsedBytes: 0,
      waitingMemoryReplayAppends: 0,
    });
  });

  it("validates memory replay capacity controls", async () => {
    await expect(
      QwpIngressSession.connect(async () => new FakeConnection("primary"), {
        memoryReplayMaxBytes: 0,
      }),
    ).rejects.toThrow(/memoryReplayMaxBytes must be a positive safe integer/);
    await expect(
      QwpIngressSession.connect(async () => new FakeConnection("primary"), {
        memoryReplayAppendDeadlineMs: 0,
      }),
    ).rejects.toThrow(
      /memoryReplayAppendDeadlineMs must be a positive safe integer/,
    );
    await expect(
      QwpIngressSession.connect(async () => new FakeConnection("primary"), {
        memoryReplayMaxBytes: 1024,
        replayStore: new TrackingReplayStore(),
      }),
    ).rejects.toThrow(/cannot be combined with a custom replayStore/);
  });

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

  it("reconnects instead of latching when an ACK meets a transient journal fault", async () => {
    // A parked maintenance or checkpoint failure surfaces out of the store on
    // the next call and clears itself on the next successful batch. Reaching
    // it while applying a server ACK used to run failTerminal(), which is
    // permanent -- so a filesystem hiccup of about a second ended a healthy
    // producer for the rest of the process lifetime. transmitOnce() already
    // routed the identical class to a reconnect for that reason.
    class AckFaultStore extends TrackingReplayStore {
      failNextAck = false;
      ackFailures = 0;

      override async acknowledgeThrough(frameSequence: bigint): Promise<void> {
        if (this.failNextAck) {
          this.failNextAck = false;
          this.ackFailures++;
          throw new QwpReplayStoreError(
            "could not trim QWP store-and-forward segment [firstSequence=0]",
          );
        }
        return super.acknowledgeThrough(frameSequence);
      }
    }

    const connections = [
      new FakeConnection("primary"),
      new FakeConnection("replacement"),
    ];
    let factoryCalls = 0;
    const replayStore = new AckFaultStore();
    const session = await QwpIngressSession.connect(
      async () => connections[Math.min(factoryCalls++, connections.length - 1)],
      {
        replayStore,
        reconnect: {
          maxAttempts: 0,
          maxDurationMs: 0,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    );

    await session.publishFrame(Uint8Array.of(1));
    expect(connections[0].sent).toEqual([Uint8Array.of(1)]);

    replayStore.failNextAck = true;
    connections[0].receive(ingressResponse(QWP_STATUS.OK, 0n));

    await vi.waitFor(() => expect(factoryCalls).toBe(2));
    expect(replayStore.ackFailures).toBe(1);
    // acknowledgeThrough() threw before it could retire the frame, so the
    // journal still holds it and the replacement connection replays it. The
    // real store persists its cursor before mutating anything, so this is the
    // same state a crash at this instant would leave.
    expect(Array.from(replayStore.records.keys())).toEqual([0n]);
    await vi.waitFor(() =>
      expect(connections[1].sent).toEqual([Uint8Array.of(1)]),
    );

    // The producer survives. Before the fix every later publish rejected with
    // the journal error for the lifetime of the process.
    connections[1].receive(ingressResponse(QWP_STATUS.OK, 0n));
    await expect(
      session.publishFrame(Uint8Array.of(2)),
    ).resolves.toBeUndefined();
    await session.close();
  });

  it("stays terminal when an ACK meets a journal verdict rather than a fault", async () => {
    // Corrupt bytes read the same way on every attempt, so reconnecting would
    // spin. The store marks such failures non-retryable and this path honours
    // that rather than retrying everything that is not a server rejection.
    class CorruptOnAckStore extends TrackingReplayStore {
      override async acknowledgeThrough(): Promise<void> {
        throw new QwpReplayStoreCorruptionError(
          "QWP store-and-forward segment is corrupt",
        );
      }
    }

    const connection = new FakeConnection("primary");
    let factoryCalls = 0;
    const session = await QwpIngressSession.connect(
      async () => {
        factoryCalls++;
        return connection;
      },
      { replayStore: new CorruptOnAckStore() },
    );

    await session.publishFrame(Uint8Array.of(1));
    connection.receive(ingressResponse(QWP_STATUS.OK, 0n));
    await expect(session.closed).resolves.toMatchObject({ code: 1011 });

    // A failed session rejects synchronously, so go through a thunk.
    await expect(async () =>
      session.publishFrame(Uint8Array.of(2)),
    ).rejects.toThrow(/corrupt/);
    // No replacement was sought: retrying corrupt bytes only spins.
    expect(factoryCalls).toBe(1);
    await session.close().catch(() => undefined);
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

  it("drops background payloads after persistence and reads them lazily for drain", async () => {
    const connection = new FakeConnection("primary");
    const replayStore = new LazyTrackingReplayStore();
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

    await session.publishFrame(Uint8Array.of(1));
    await session.publishFrame(Uint8Array.of(2));
    expect(replayStore.loadCalls).toBe(0);
    expect(replayStore.reads).toEqual([]);

    releaseOnline();
    await vi.waitFor(() =>
      expect(connection.sent).toEqual([Uint8Array.of(1), Uint8Array.of(2)]),
    );
    expect(replayStore.reads).toEqual([0n, 1n]);
    await session.close();
  });

  it("does not log a frame against a connection installed during its journal read", async () => {
    // With a lazy store the drain always reads from disk, and that read can
    // park behind an fsyncing append for longer than a jittered reconnect
    // takes. install() swaps the wire log wholesale, so a frame pushed after
    // the swap occupies the replacement's wire slot while being written to the
    // dead socket: the replacement's next cumulative ACK then retires a frame
    // no server ever received, and its journal record is deleted.
    let releaseRead!: () => void;
    const parked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    class ParkingReadStore extends LazyTrackingReplayStore {
      parkNextRead = false;

      override async readPayload(frameSequence: bigint): Promise<Uint8Array> {
        if (this.parkNextRead) {
          this.parkNextRead = false;
          await parked;
        }
        return super.readPayload(frameSequence);
      }
    }

    const connections: FakeConnection[] = [];
    const replayStore = new ParkingReadStore();
    const session = await QwpIngressSession.connect(
      async () => {
        const connection = new FakeConnection(`node-${connections.length}`);
        connections.push(connection);
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

    await session.publishFrame(Uint8Array.of(1));
    await vi.waitFor(() => expect(connections[0].sent).toHaveLength(1));

    // Park the next drain read, then drop the connection underneath it.
    replayStore.parkNextRead = true;
    await session.publishFrame(Uint8Array.of(2));
    connections[0].drop();
    await vi.waitFor(() => expect(connections.length).toBe(2));
    releaseRead();

    // Frame 2 must reach the live connection, not the dropped one.
    await vi.waitFor(() =>
      expect(
        connections[1].sent.some(
          (payload) => payload[payload.length - 1] === 2,
        ),
      ).toBe(true),
    );
    await session.close();
  });

  it("retries a transient journal read instead of latching the sender", async () => {
    // A store read can fail transiently -- a briefly full or read-only
    // filesystem parks the trim failure for about a second and the store
    // clears it on the next successful batch. enqueueDrain's only handler is
    // failTerminal, so before the fix that transient condition ended the
    // producer for the rest of the process lifetime with its frames stranded
    // on disk, which is exactly what the store-level retry exists to prevent.
    class FlakyReadStore extends LazyTrackingReplayStore {
      failNextRead = true;

      override async readPayload(frameSequence: bigint): Promise<Uint8Array> {
        if (this.failNextRead) {
          this.failNextRead = false;
          throw new QwpReplayStoreError(
            "could not trim QWP store-and-forward segment [firstSequence=0]",
          );
        }
        return super.readPayload(frameSequence);
      }
    }

    const connections: FakeConnection[] = [];
    const replayStore = new FlakyReadStore();
    const session = await QwpIngressSession.connect(
      async () => {
        const connection = new FakeConnection(`node-${connections.length}`);
        connections.push(connection);
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

    await session.publishFrame(Uint8Array.of(1));

    // The frame is still journalled, so a reconnect replays it once the store
    // recovers rather than the sender going terminal.
    await vi.waitFor(() =>
      expect(
        connections.some((connection) =>
          connection.sent.some((payload) => payload[payload.length - 1] === 1),
        ),
      ).toBe(true),
    );
    // The producer never sees the transient failure.
    await expect(
      session.publishFrame(Uint8Array.of(2)),
    ).resolves.toBeUndefined();
    await session.close();
  });

  it("stays terminal when a replay read reports that the journal lock was lost", async () => {
    const lockLost = new QwpReplayStoreLockLostError("/qwp/sender-0");
    class LockLostReadStore extends LazyTrackingReplayStore {
      override async readPayload(): Promise<Uint8Array> {
        throw lockLost;
      }
    }

    const replayStore = new LockLostReadStore();
    let factoryCalls = 0;
    const session = await QwpIngressSession.connect(
      async () => {
        factoryCalls++;
        return new FakeConnection(`node-${factoryCalls}`);
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

    await session.publishFrame(Uint8Array.of(1));
    await expect(session.closed).resolves.toMatchObject({ code: 1011 });
    expect(session.metrics.lastError).toBe(lockLost);
    expect(factoryCalls).toBe(1);
    await vi.waitFor(() => expect(replayStore.closeCount).toBe(1));
    await session.close().catch(() => undefined);
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

  it("keeps durable-ACK mismatch fail-fast for blocking SF startup", async () => {
    for (const initialConnectMode of ["off", "sync"] as const) {
      let factoryCalls = 0;
      await expect(
        QwpIngressSession.connect(
          async () => {
            factoryCalls++;
            throw new QwpDurableAckUnavailableError("ws://primary/write/v4");
          },
          {
            backgroundStoreAndForward: true,
            initialConnectMode,
            reconnect: {
              maxAttempts: 5,
              initialBackoffMs: 0,
              maxBackoffMs: 0,
            },
            replayStore: new TrackingReplayStore(),
          },
        ),
      ).rejects.toBeInstanceOf(QwpDurableAckUnavailableError);
      expect(factoryCalls).toBe(1);
    }
  });

  it("keeps a mixed durable-ACK and transport failure sweep retryable", async () => {
    let factoryCalls = 0;
    await expect(
      QwpIngressSession.connect(
        async () => {
          factoryCalls++;
          throw new QwpFailoverError([
            {
              endpoint: "ws://old-primary/write/v4",
              error: new QwpDurableAckUnavailableError(
                "ws://old-primary/write/v4",
              ),
            },
            {
              endpoint: "ws://offline/write/v4",
              error: new Error("connection refused"),
            },
          ]);
        },
        {
          backgroundStoreAndForward: true,
          initialConnectMode: "sync",
          reconnect: {
            maxAttempts: 5,
            initialBackoffMs: 0,
            maxBackoffMs: 0,
          },
          replayStore: new TrackingReplayStore(),
        },
      ),
    ).rejects.toBeInstanceOf(QwpReconnectExhaustedError);
    expect(factoryCalls).toBe(5);
  });

  it("retries durable-ACK mismatch during asynchronous foreground startup", async () => {
    const connection = new FakeConnection("primary", {
      qwpVersion: 1,
      durableAckEnabled: true,
    });
    const events: QwpReconnectEvent[] = [];
    let factoryCalls = 0;
    const session = await QwpIngressSession.connect(
      async () => {
        factoryCalls++;
        if (factoryCalls <= 2) {
          throw new QwpDurableAckUnavailableError("ws://primary/write/v4");
        }
        return connection;
      },
      {
        backgroundStoreAndForward: true,
        initialConnectMode: "async",
        reconnect: {
          maxAttempts: 1,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
          onEvent: (event) => events.push(event),
        },
        replayStore: new TrackingReplayStore(),
      },
    );

    await session.publishFrame(Uint8Array.of(7));
    await vi.waitFor(() => expect(connection.sent).toEqual([Uint8Array.of(7)]));
    await vi.waitFor(() =>
      expect(
        events
          .filter(
            (event) =>
              event.kind === QWP_RECONNECT_EVENT_KIND.DURABLE_ACK_UNAVAILABLE,
          )
          .map((event) => event.attempt),
      ).toEqual([1, 2]),
    );
    expect(
      events.some(
        (event) =>
          event.kind ===
          QWP_RECONNECT_EVENT_KIND.DURABLE_ACK_PERSISTENT_FAILURE,
      ),
    ).toBe(false);
    await session.close();
  });

  it("bounds consecutive orphan durable-ACK mismatch episodes", async () => {
    const events: QwpReconnectEvent[] = [];
    let factoryCalls = 0;
    const session = await QwpIngressSession.connect(
      async () => {
        factoryCalls++;
        throw new QwpDurableAckUnavailableError("ws://primary/write/v4");
      },
      {
        backgroundStoreAndForward: true,
        initialConnectMode: "async",
        orphanStoreAndForward: true,
        orphanDurableAckMismatchMaxDurationMs: 0,
        reconnect: {
          initialBackoffMs: 0,
          maxBackoffMs: 0,
          onEvent: (event) => events.push(event),
        },
        replayStore: new TrackingReplayStore(),
      },
    );

    await session.closed;
    await vi.waitFor(() =>
      expect(
        events.filter(
          (event) =>
            event.kind ===
            QWP_RECONNECT_EVENT_KIND.DURABLE_ACK_PERSISTENT_FAILURE,
        ),
      ).toHaveLength(1),
    );
    const unavailable = events.filter(
      (event) =>
        event.kind === QWP_RECONNECT_EVENT_KIND.DURABLE_ACK_UNAVAILABLE,
    );
    expect(factoryCalls).toBe(16);
    expect(unavailable).toHaveLength(15);
    expect(unavailable.map((event) => event.attempt)).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 1),
    );
    expect(session.metrics.lastError).toMatchObject({
      name: "QwpDurableAckPersistentFailureError",
      attempts: 16,
    });
    await session.close();
  });

  it("does not count mixed endpoint sweeps as orphan durable-ACK mismatches", async () => {
    const connection = new FakeConnection("primary", {
      qwpVersion: 1,
      durableAckEnabled: true,
    });
    const events: QwpReconnectEvent[] = [];
    let factoryCalls = 0;
    const session = await QwpIngressSession.connect(
      async () => {
        factoryCalls++;
        if (factoryCalls <= 16) {
          throw new QwpFailoverError([
            {
              endpoint: "ws://old-primary/write/v4",
              error: new QwpDurableAckUnavailableError(
                "ws://old-primary/write/v4",
              ),
            },
            {
              endpoint: "ws://offline/write/v4",
              error: new Error("connection refused"),
            },
          ]);
        }
        return connection;
      },
      {
        backgroundStoreAndForward: true,
        initialConnectMode: "async",
        orphanStoreAndForward: true,
        orphanDurableAckMismatchMaxDurationMs: 0,
        reconnect: {
          initialBackoffMs: 0,
          maxBackoffMs: 0,
          onEvent: (event) => events.push(event),
        },
        replayStore: new TrackingReplayStore(),
      },
    );

    await vi.waitFor(() => expect(factoryCalls).toBe(17));
    expect(
      events.some(
        (event) =>
          event.kind === QWP_RECONNECT_EVENT_KIND.DURABLE_ACK_UNAVAILABLE ||
          event.kind ===
            QWP_RECONNECT_EVENT_KIND.DURABLE_ACK_PERSISTENT_FAILURE,
      ),
    ).toBe(false);
    expect(session.metrics.lastError).toBeUndefined();
    await session.close();
  });

  it("bounds an orphan durable-ACK mismatch episode by duration", async () => {
    const events: QwpReconnectEvent[] = [];
    let factoryCalls = 0;
    const session = await QwpIngressSession.connect(
      async () => {
        factoryCalls++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new QwpDurableAckUnavailableError("ws://primary/write/v4");
      },
      {
        backgroundStoreAndForward: true,
        initialConnectMode: "async",
        orphanStoreAndForward: true,
        orphanDurableAckMismatchMaxDurationMs: 1,
        reconnect: {
          initialBackoffMs: 0,
          maxBackoffMs: 0,
          onEvent: (event) => events.push(event),
        },
        replayStore: new TrackingReplayStore(),
      },
    );

    await session.closed;
    await vi.waitFor(() =>
      expect(
        events.filter(
          (event) =>
            event.kind ===
            QWP_RECONNECT_EVENT_KIND.DURABLE_ACK_PERSISTENT_FAILURE,
        ),
      ).toHaveLength(1),
    );
    expect(factoryCalls).toBeGreaterThanOrEqual(2);
    expect(factoryCalls).toBeLessThan(16);
    expect(session.metrics.lastError).toMatchObject({
      name: "QwpDurableAckPersistentFailureError",
      attempts: factoryCalls,
    });
    await session.close();
  });

  it("resets an orphan durable-ACK episode after primary unavailability", async () => {
    const connection = new FakeConnection("primary", {
      qwpVersion: 1,
      durableAckEnabled: true,
    });
    const events: QwpReconnectEvent[] = [];
    let factoryCalls = 0;
    const session = await QwpIngressSession.connect(
      async () => {
        factoryCalls++;
        if (factoryCalls <= 15 || (factoryCalls >= 17 && factoryCalls <= 31)) {
          throw new QwpDurableAckUnavailableError("ws://primary/write/v4");
        }
        if (factoryCalls === 16) {
          throw new QwpUpgradeError("all endpoints are replicas", {
            kind: QWP_UPGRADE_ERROR_KIND.ROLE_REJECTED,
            retryable: true,
            tryNextEndpoint: true,
            serverRole: "REPLICA",
          });
        }
        return connection;
      },
      {
        backgroundStoreAndForward: true,
        initialConnectMode: "async",
        orphanStoreAndForward: true,
        orphanDurableAckMismatchMaxDurationMs: 0,
        reconnect: {
          initialBackoffMs: 0,
          maxBackoffMs: 0,
          onEvent: (event) => events.push(event),
        },
        replayStore: new TrackingReplayStore(),
      },
    );

    await vi.waitFor(() => expect(factoryCalls).toBe(32));
    await vi.waitFor(() =>
      expect(
        events.filter(
          (event) =>
            event.kind === QWP_RECONNECT_EVENT_KIND.PRIMARY_UNAVAILABLE,
        ),
      ).toHaveLength(1),
    );
    await vi.waitFor(() =>
      expect(
        events.filter(
          (event) =>
            event.kind === QWP_RECONNECT_EVENT_KIND.DURABLE_ACK_UNAVAILABLE,
        ),
      ).toHaveLength(30),
    );
    const unavailableAttempts = events
      .filter(
        (event) =>
          event.kind === QWP_RECONNECT_EVENT_KIND.DURABLE_ACK_UNAVAILABLE,
      )
      .map((event) => event.attempt);
    expect(unavailableAttempts).toEqual([
      ...Array.from({ length: 15 }, (_, index) => index + 1),
      ...Array.from({ length: 15 }, (_, index) => index + 1),
    ]);
    expect(
      events.some(
        (event) =>
          event.kind ===
          QWP_RECONNECT_EVENT_KIND.DURABLE_ACK_PERSISTENT_FAILURE,
      ),
    ).toBe(false);
    await session.close();
  });

  it("resets an orphan durable-ACK episode after a transport outage", async () => {
    const connection = new FakeConnection("primary", {
      qwpVersion: 1,
      durableAckEnabled: true,
    });
    const events: QwpReconnectEvent[] = [];
    let factoryCalls = 0;
    const session = await QwpIngressSession.connect(
      async () => {
        factoryCalls++;
        if (factoryCalls <= 15 || (factoryCalls >= 17 && factoryCalls <= 31)) {
          throw new QwpDurableAckUnavailableError("ws://primary/write/v4");
        }
        if (factoryCalls === 16) {
          throw new Error("cluster temporarily unreachable");
        }
        return connection;
      },
      {
        backgroundStoreAndForward: true,
        initialConnectMode: "async",
        orphanStoreAndForward: true,
        orphanDurableAckMismatchMaxDurationMs: 0,
        reconnect: {
          initialBackoffMs: 0,
          maxBackoffMs: 0,
          onEvent: (event) => events.push(event),
        },
        replayStore: new TrackingReplayStore(),
      },
    );

    await vi.waitFor(() => expect(factoryCalls).toBe(32));
    await vi.waitFor(() =>
      expect(
        events.filter(
          (event) =>
            event.kind === QWP_RECONNECT_EVENT_KIND.DURABLE_ACK_UNAVAILABLE,
        ),
      ).toHaveLength(30),
    );
    expect(
      events
        .filter(
          (event) =>
            event.kind === QWP_RECONNECT_EVENT_KIND.DURABLE_ACK_UNAVAILABLE,
        )
        .map((event) => event.attempt),
    ).toEqual([
      ...Array.from({ length: 15 }, (_, index) => index + 1),
      ...Array.from({ length: 15 }, (_, index) => index + 1),
    ]);
    expect(
      events.some(
        (event) =>
          event.kind ===
          QWP_RECONNECT_EVENT_KIND.DURABLE_ACK_PERSISTENT_FAILURE,
      ),
    ).toBe(false);
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

    const rootDirectory = await createTemporaryDirectory();
    const orphanDirectory = join(rootDirectory, "orphan");
    await mkdir(orphanDirectory);
    const segment = Buffer.alloc(32);
    segment.write("SF01", 0, "ascii");
    segment.writeUInt8(1, 4);
    segment.writeUInt8(1, 24);
    await writeFile(join(orphanDirectory, "sf-0000000000000000.sfa"), segment);

    const orphanStore = new FailOnceDictionaryReplayStore();
    orphanStore.symbols.push("x".repeat(64));
    orphanStore.records.set(0n, Uint8Array.of(1));
    const senderErrors: QwpSenderError[] = [];
    let orphanCalls = 0;
    const drainer = new QwpNodeOrphanDrainer({
      rootDirectory,
      scanIntervalMs: 0,
      durableAckPollIntervalMs: 0,
      createSession: async () =>
        QwpIngressSession.connect(
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
        ),
      onSenderError: (error) => senderErrors.push(error),
    });
    try {
      drainer.start();
      await vi.waitFor(() => expect(drainer.metrics.failed).toBe(1));
      expect(drainer.metrics.retrying).toBe(0);
      expect(orphanCalls).toBe(16);
      expect(await readdir(orphanDirectory)).toContain(
        QWP_ORPHAN_FAILED_SENTINEL,
      );
      await vi.waitFor(() => expect(senderErrors).toHaveLength(1));
      expect(senderErrors[0]).toMatchObject({
        category: QWP_SENDER_ERROR_CATEGORY.DATA_LOSS,
        appliedPolicy: QWP_SENDER_ERROR_POLICY.ABANDONED,
        quarantinedPath: orphanDirectory,
        serverMessage: expect.stringMatching(
          /attempt=16\/16.*data must be resent/,
        ),
      });
    } finally {
      await drainer.close();
      await rm(rootDirectory, { recursive: true, force: true });
    }
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
    // The rejected append consumed no frame sequence, so the surviving record
    // is the journal's first. A hole here would make the store reject every
    // later append as non-contiguous.
    expect([...replayStore.records.keys()]).toEqual([0n]);
    expect(
      decodeQwpIngressSymbolDictionaryDelta(replayStore.records.get(0n)!),
    ).toEqual({ startId: 0, entries: ["ETH-USD", "BTC-USD"] });
    await session.close();
  });

  it("trims the wire log as cumulative ACKs arrive", async () => {
    const connection = new FakeConnection("primary");
    const session = await QwpIngressSession.connect(async () => connection);
    // The wire log is indexed by wire sequence and is not part of the public
    // surface, but the invariant it has to hold is: it stays proportional to
    // what is unacknowledged, never to everything ever sent on the connection.
    const wireLog = () =>
      (
        session as unknown as {
          connection: { wireFrames: readonly { payload?: Uint8Array }[] };
        }
      ).connection.wireFrames;

    const payload = new Uint8Array(1024).fill(7);
    for (let index = 0; index < 200; index++) {
      // Await the send before delivering its ACK: a frame is logged before it
      // is sent, so a real server never acknowledges a sequence beyond the last
      // frame sent, and an over-range ACK is now rejected rather than clamped.
      await session.publishFrame(payload);
      connection.receive(ingressResponse(QWP_STATUS.OK, BigInt(index)));
    }

    // Retaining the acknowledged prefix pinned every payload for the life of
    // the connection and made each ACK scan it three times over.
    await vi.waitFor(() => expect(wireLog().length).toBeLessThanOrEqual(2));
    expect(
      wireLog().reduce(
        (total, frame) => total + (frame.payload?.byteLength ?? 0),
        0,
      ),
    ).toBeLessThanOrEqual(payload.byteLength * 2);

    await session.close();
  });

  it("keeps journal appends contiguous after a rejected append", async () => {
    const replayStore = new ContiguousReplayStore();
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

    await expect(session.publishFrame(Uint8Array.of(1))).rejects.toThrow(
      "journal is full",
    );

    // Journal exhaustion is the one error a producer may see, and it must be
    // survivable: once there is room again every later frame has to be
    // accepted. Consuming a sequence for the rejected append would leave a
    // hole and make the store reject everything that followed until the
    // journal drained completely.
    await expect(
      session.publishFrame(Uint8Array.of(2)),
    ).resolves.toBeUndefined();
    await expect(
      session.publishFrame(Uint8Array.of(3)),
    ).resolves.toBeUndefined();
    expect([...replayStore.records.keys()]).toEqual([0n, 1n]);

    await session.close();
  });

  it("retains ACK-waiting high-level rows until journal publication succeeds", async () => {
    const connection = new FakeConnection("primary");
    const replayStore = new FailOnceDictionaryReplayStore();
    const session = await QwpIngressSession.connect(async () => connection, {
      ackTimeoutMs: 1_000,
      reconnect: { maxAttempts: 1 },
      replayStore,
    });
    const sender = new QwpSender(async () => session, {
      autoFlush: false,
      awaitServerAck: true,
    });
    await sender.table("trades").symbol("symbol", "ETH-USD").atNow();

    await expect(sender.flush()).rejects.toThrow("journal is full");
    expect(sender.metrics).toMatchObject({
      pendingRows: 1,
      totalRowsPublished: 0,
      totalFlushFailures: 1,
    });
    expect(sender.publishedSequence).toBe(-1n);
    expect(replayStore.symbols).toEqual(["ETH-USD"]);
    expect(replayStore.records.size).toBe(0);

    const retried = sender.flush();
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
    expect(decodeQwpIngressSymbolDictionaryDelta(connection.sent[0])).toEqual({
      startId: 0,
      entries: ["ETH-USD"],
    });
    connection.receive(ingressResponse(QWP_STATUS.OK, 0n));
    await expect(retried).resolves.toBe(true);
    expect(sender.metrics).toMatchObject({
      pendingRows: 0,
      totalRowsPublished: 1,
      totalFlushes: 2,
    });
    await sender.close();
  });

  it("stops a split ACK-waiting batch after a failed journal prefix", async () => {
    const connection = new FakeConnection("primary");
    const replayStore = new FailOnceDictionaryReplayStore(2);
    const symbols = ["symbol-0000", "symbol-1111", "symbol-2222"];
    const sizingDictionary = new QwpSymbolDictionary();
    const cap = encodeQwpIngressFrame([symbolTable(symbols[0])], {
      dictionary: sizingDictionary,
      confirmedMaxSymbolId: -1,
    }).byteLength;
    const session = await QwpIngressSession.connect(async () => connection, {
      ackTimeoutMs: 1_000,
      reconnect: { maxAttempts: 1 },
      replayStore,
      maxBatchSizeBytes: cap,
    });

    const failed = session.sendTablesDeltaWithPublication([
      symbolRows(symbols),
    ]);
    await expect(failed.publication).rejects.toThrow("journal is full");
    await expect(failed.acknowledgement).rejects.toThrow("journal is full");
    expect([...replayStore.records.keys()]).toEqual([0n]);
    expect(connection.sent).toHaveLength(1);
    expect(decodeQwpIngressSymbolDictionaryDelta(connection.sent[0])).toEqual({
      startId: 0,
      entries: [symbols[0]],
    });
    // The failed second frame persisted its sidecar entry before its frame
    // append failed; the suppressed third frame persisted neither.
    expect(replayStore.symbols).toEqual(symbols.slice(0, 2));

    const retried = session.sendTablesDeltaWithPublication([
      symbolRows(symbols),
    ]);
    await expect(retried.publication).resolves.toBeUndefined();
    expect(connection.sent).toHaveLength(4);
    expect(connection.sent.slice(1).every((frame) => frame.length <= cap)).toBe(
      true,
    );
    expect(decodeQwpIngressSymbolDictionaryDelta(connection.sent[1])).toEqual({
      startId: 1,
      entries: [symbols[1]],
    });
    connection.receive(
      ingressResponse(QWP_STATUS.OK, BigInt(connection.sent.length - 1)),
    );
    await expect(retried.acknowledgement).resolves.toMatchObject({
      sequence: retried.sequence,
    });
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
      memoryReplayMaxBytes: 128 * 1024 * 1024,
      memoryReplayUsedBytes: 0,
      waitingMemoryReplayAppends: 0,
      totalMemoryReplayBackpressureStalls: 0,
      totalMemoryReplayAppendTimeouts: 0,
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

  it("waits for a larger-cap node instead of failing a journalled frame", async () => {
    // A frame journalled while offline was never transmitted, so replayInto()
    // skips it and the drain loop calls transmit() -- the path that used to
    // treat a smaller-cap node as terminal. The Java client retries a
    // foreground sender forever rather than reclassifying data the producer
    // already handed over as unsendable.
    const tooSmall = new FakeConnection("small-cap", {
      qwpVersion: 1,
      maxBatchSizeBytes: 4,
    });
    const large = new FakeConnection("large-cap");
    const attempts: unknown[] = [];
    const session = await QwpIngressSession.connect(
      async () => {
        attempts.push(1);
        if (attempts.length === 1) {
          throw new QwpUpgradeError("offline", {
            kind: QWP_UPGRADE_ERROR_KIND.TRANSPORT,
            retryable: true,
            tryNextEndpoint: true,
          });
        }
        return attempts.length === 2 ? tooSmall : large;
      },
      {
        backgroundStoreAndForward: true,
        ackTimeoutMs: 1_000,
        reconnect: { maxAttempts: 0, initialBackoffMs: 0, maxBackoffMs: 0 },
      },
    );

    const payload = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
    await expect(session.publishFrame(payload)).resolves.toBeUndefined();

    // The small-cap node cannot take the journalled frame; the session must
    // roll on to one that can rather than going terminal.
    await vi.waitFor(() => expect(large.sent).toHaveLength(1), {
      timeout: 5_000,
    });
    expect(large.sent[0]).toEqual(payload);
    large.receive(ingressResponse(QWP_STATUS.OK, 0n));

    await session.close();
  }, 20_000);

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

  // The terminal set is a cross-client contract: the Java client's policy maps
  // SCHEMA_MISMATCH, PARSE_ERROR and SECURITY_ERROR to TERMINAL ("deterministic:
  // same bytes, same mismatch") and everything else -- including status bytes it
  // does not recognise -- to a retriable category, failing open on a newer
  // server. Only the retriable direction had coverage, so the whole terminal
  // branch could be deleted with a green suite.
  it.each([
    ["SCHEMA_MISMATCH", QWP_STATUS.SCHEMA_MISMATCH],
    ["PARSE_ERROR", QWP_STATUS.PARSE_ERROR],
    ["SECURITY_ERROR", QWP_STATUS.SECURITY_ERROR],
  ])(
    "fails the connection on a %s NACK without replaying",
    async (_name, status) => {
      const first = new FakeConnection("primary");
      const second = new FakeConnection("secondary");
      const connections = [first, second];
      const session = await QwpIngressSession.connect(
        async () => connections.shift() ?? new FakeConnection("extra"),
        { reconnect: { maxAttempts: 1, initialBackoffMs: 0, maxBackoffMs: 0 } },
      );

      const pending = session.sendFrame(Uint8Array.of(9));
      await vi.waitFor(() => expect(first.sent).toHaveLength(1));
      first.receive(ingressResponse(status, 0n));

      await expect(pending).rejects.toMatchObject({
        name: "QwpIngressNackError",
        response: { status },
      });
      // A deterministic rejection must not be replayed: the same bytes would be
      // rejected again on every node in turn.
      expect(second.sent).toEqual([]);
      await session.close().catch(() => undefined);
    },
  );

  it.each([
    ["INTERNAL_ERROR", QWP_STATUS.INTERNAL_ERROR],
    ["DICTIONARY_GAP", QWP_STATUS.DICTIONARY_GAP],
    ["an unrecognised status", 0x7f],
  ])("replays after a %s NACK", async (_name, status) => {
    const first = new FakeConnection("primary");
    const second = new FakeConnection("secondary");
    const connections = [first, second];
    const session = await QwpIngressSession.connect(
      async () => connections.shift() ?? new FakeConnection("extra"),
      { reconnect: { maxAttempts: 1, initialBackoffMs: 0, maxBackoffMs: 0 } },
    );

    const pending = session.sendFrame(Uint8Array.of(9));
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    first.receive(ingressResponse(status, 0n));

    await vi.waitFor(() => expect(second.sent).toEqual([Uint8Array.of(9)]));
    second.receive(ingressResponse(QWP_STATUS.OK, 0n));
    await expect(pending).resolves.toMatchObject({ status: QWP_STATUS.OK });
    await session.close();
  });

  // An unrecognised status must fail open, and a DICTIONARY_GAP is the server
  // asking for symbol catch-up rather than a verdict on the frame -- neither
  // may consume a poison strike, or a recoverable rejection would escalate to
  // a terminal one.
  it.each([
    ["an unrecognised status", 0x7f],
    ["DICTIONARY_GAP", QWP_STATUS.DICTIONARY_GAP],
  ])("keeps retrying repeated %s NACKs", async (_name, status) => {
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
          poisonMinEscalationWindowMs: 0,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    );

    const pending = session.sendFrame(Uint8Array.of(9));
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    first.receive(ingressResponse(status, 0n));
    await vi.waitFor(() => expect(second.sent).toHaveLength(1));
    second.receive(ingressResponse(status, 0n));
    await vi.waitFor(() => expect(third.sent).toHaveLength(1));
    third.receive(ingressResponse(QWP_STATUS.OK, 0n));

    await expect(pending).resolves.toMatchObject({
      status: QWP_STATUS.OK,
      sequence: 0n,
    });
    expect(session.metrics).toMatchObject({
      totalNacks: 2,
      totalFramesSent: 3,
      totalFramesReplayed: 2,
      totalReconnectsSucceeded: 2,
    });
    await session.close();
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
    await vi.waitFor(() =>
      expect(session.metrics.deliveredErrorNotifications).toBe(2),
    );
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

  it.each([
    ["close code 1006", (connection: FakeConnection) => connection.drop()],
    [
      "close code 1011",
      (connection: FakeConnection) =>
        connection.drop(1011, "internal server error"),
    ],
    [
      "no close information",
      (connection: FakeConnection) => connection.transportError(),
    ],
  ] as const)(
    "stops replaying a head frame that repeatedly causes %s",
    async (_failure, fail) => {
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
      fail(first);
      await vi.waitFor(() => expect(second.sent).toHaveLength(1));
      fail(second);

      await expect(pending).rejects.toThrow(/frameSequence=0, strikes=2/);
      await expect(pending).rejects.toBeInstanceOf(QwpProtocolError);
      expect(connections).toHaveLength(0);
      expect(Array.from(replayStore.records.keys())).toEqual([0n]);
      await session.close();
    },
  );

  it.each([
    [1000, "normal closure"],
    [1001, "going away"],
    [1012, "service restart"],
    [1013, "try again later"],
  ] as const)(
    "close code %i breaks a poison-frame strike episode",
    async (code, reason) => {
      const firstSuspect = new FakeConnection("suspect-1");
      const exempt = new FakeConnection("restarting");
      const secondSuspect = new FakeConnection("suspect-2");
      const healthy = new FakeConnection("healthy");
      const connections = [firstSuspect, exempt, secondSuspect, healthy];
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
      await vi.waitFor(() => expect(firstSuspect.sent).toHaveLength(1));
      firstSuspect.drop();
      await vi.waitFor(() => expect(exempt.sent).toHaveLength(1));
      exempt.drop(code, reason);
      await vi.waitFor(() => expect(secondSuspect.sent).toHaveLength(1));
      secondSuspect.drop();
      await vi.waitFor(() => expect(healthy.sent).toHaveLength(1));
      healthy.receive(ingressResponse(QWP_STATUS.OK, 0n));

      await expect(pending).resolves.toMatchObject({
        status: QWP_STATUS.OK,
        sequence: 0n,
      });
      await session.close();
    },
  );

  it("escalates a frame that keeps taking the connection down across reconnect failures", async () => {
    // The canonical poison case is a frame that crashes the server, which
    // guarantees the following connect attempt fails. Wiping the episode on
    // that failure made this case the one the detector could never reach:
    // the strike count reset before it ever met maxFrameRejections, and the
    // frame replayed without bound. Strikes now survive the outage.
    // Every delivery attempt is followed by a refused connect, so the old
    // wipe-on-connect-failure rule reset the count after every single strike
    // and the frame could never accumulate two.
    const handedOut: FakeConnection[] = [];
    let factoryCalls = 0;
    const session = await QwpIngressSession.connect(
      async () => {
        factoryCalls++;
        if (factoryCalls % 2 === 0) throw new Error("connection refused");
        const connection = new FakeConnection(`terminating-${factoryCalls}`);
        handedOut.push(connection);
        return connection;
      },
      {
        reconnect: {
          maxAttempts: 20,
          maxDurationMs: 0,
          maxFrameRejections: 2,
          poisonMinEscalationWindowMs: 0,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    );
    const pending = session.sendFrame(Uint8Array.of(9));
    const dropNext = async (index: number) => {
      await vi.waitFor(() => {
        expect(handedOut).toHaveLength(index + 1);
        expect(handedOut[index].sent).toHaveLength(1);
      });
      handedOut[index].drop();
    };
    await dropNext(0);
    await dropNext(1);

    await expect(pending).rejects.toBeInstanceOf(QwpProtocolError);
    // Exactly two strikes were needed; no third connection was handed out.
    expect(handedOut).toHaveLength(2);
    await session.close().catch(() => undefined);
  });

  it("withholds connection-outage time from the poison escalation window", async () => {
    // The window exists to prove a rejection persists while the client can
    // actually reach a server. Time spent unable to connect must not count
    // toward it, or an outage alone would satisfy the dwell.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const first = new FakeConnection("terminating-1");
      const second = new FakeConnection("terminating-2");
      const healthy = new FakeConnection("healthy");
      let factoryCalls = 0;
      const session = await QwpIngressSession.connect(
        async () => {
          factoryCalls++;
          if (factoryCalls === 1) return first;
          if (factoryCalls === 2) throw new Error("connection refused");
          if (factoryCalls === 3) {
            // Age the clock while the outage is open, so the elapsed time is
            // banked as outage rather than counted as connected dwell.
            vi.setSystemTime(Date.now() + 30_000);
            return second;
          }
          return healthy;
        },
        {
          reconnect: {
            maxAttempts: 5,
            // The simulated outage advances the clock past the default
            // 30s reconnect budget, which is not what this test is about.
            maxDurationMs: 0,
            maxFrameRejections: 2,
            poisonMinEscalationWindowMs: 10_000,
            initialBackoffMs: 0,
            maxBackoffMs: 0,
          },
        },
      );
      const pending = session.sendFrame(Uint8Array.of(9));
      await vi.waitFor(() => expect(first.sent).toHaveLength(1));
      first.drop();
      await vi.waitFor(() => expect(second.sent).toHaveLength(1));
      // Second strike: 30s of wall clock has passed, but all of it was the
      // outage, so the connected dwell is still under the 10s window.
      second.drop();
      await vi.waitFor(() => expect(healthy.sent).toHaveLength(1));
      healthy.receive(ingressResponse(QWP_STATUS.OK, 0n));

      await expect(pending).resolves.toMatchObject({
        status: QWP_STATUS.OK,
        sequence: 0n,
      });
      await session.close();
    } finally {
      vi.useRealTimers();
    }
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

  it("rejects an over-range ingress ACK instead of clamping it onto in-flight frames", async () => {
    const connection = new FakeConnection("primary");
    const session = await QwpIngressSession.connect(async () => connection, {
      reconnect: { maxAttempts: 1 },
    });
    const first = session.sendFrame(Uint8Array.of(9));
    const second = session.sendFrame(Uint8Array.of(8));
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2));
    // Only wire sequences 0 and 1 were sent. Clamping 999 onto the newest
    // in-flight frame would retire both frames and delete journal records the
    // server never acknowledged, so an over-range ACK must be rejected.
    connection.receive(ingressResponse(QWP_STATUS.OK, 999n));

    await expect(first).rejects.toBeInstanceOf(QwpProtocolError);
    await expect(second).rejects.toBeInstanceOf(QwpProtocolError);
    expect(session.acknowledgedFrameSequence).toBe(-1n);
    await session.close();
  });

  it("does not leak an unhandled rejection when a store close fails on the protocol-error path", async () => {
    // The protocol-error branch closes the connection for its side effect. A
    // reconnecting transport's close() awaits the replay store, and
    // QwpNodeFileReplayStore rethrows a checkpoint, segment-handle or lock
    // release failure -- so discarding that promise made a read-only or full
    // journal volume terminate the host process with an unhandled rejection.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const connection = new FakeConnection("primary");
      const replayStore = new CloseFaultStore();
      const session = await QwpIngressSession.connect(async () => connection, {
        replayStore,
        reconnect: { maxAttempts: 1 },
      });
      const pending = session.sendFrame(Uint8Array.of(9));
      await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
      // A one-byte payload cannot carry an ingress response, so decoding it
      // raises QwpProtocolError inside consumeMessages().
      connection.receive(Uint8Array.of(QWP_STATUS.OK));

      await expect(pending).rejects.toBeInstanceOf(QwpProtocolError);
      await vi.waitFor(() => expect(replayStore.closeAttempts).toBe(1));
      // Give any escaping rejection a turn of the microtask and macrotask
      // queues to reach the process handler.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);

      // The protocol error itself still reaches the caller through the
      // rejected send above; only the secondary teardown failure is absorbed.
      await session.close().catch(() => undefined);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("rejects an over-range ingress NACK instead of charging the wrong frame", async () => {
    const connection = new FakeConnection("primary");
    const session = await QwpIngressSession.connect(async () => connection, {
      reconnect: { maxAttempts: 1 },
    });
    const first = session.sendFrame(Uint8Array.of(9));
    const second = session.sendFrame(Uint8Array.of(8));
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2));
    // Clamping this WRITE_ERROR onto the newest in-flight frame would charge the
    // poison strike to the tail frame instead of the head. An over-range NACK is
    // a protocol violation, so it must terminate rather than drive a retry.
    connection.receive(ingressResponse(QWP_STATUS.WRITE_ERROR, 999n));

    await expect(first).rejects.toBeInstanceOf(QwpProtocolError);
    await expect(second).rejects.toBeInstanceOf(QwpProtocolError);
    expect(session.metrics.totalNacks).toBe(0);
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
      expect(await assignedReplaySegments(directory)).toEqual([]),
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
    await expectOnlyJavaSlotLockMetadata(directory);
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
    const persistedPrefixSize = (await stat(join(directory, ".symbol-dict")))
      .size;

    const replayFrame = encodeQwpIngressFrame([symbolTable("BTC-USD")], {
      dictionary,
      confirmedMaxSymbolId: 0,
    });
    await seed.appendSymbolDictionary(1, dictionary.entriesFrom(1));
    await seed.append({ frameSequence: 5n, payload: replayFrame });
    await seed.close();
    await truncate(join(directory, ".symbol-dict"), persistedPrefixSize);

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

  it.each(["structurally corrupt", "stale but valid"] as const)(
    "rebuilds a %s symbol sidecar from self-contained committed frames",
    async (failureKind) => {
      const directory = await createTemporaryDirectory();
      const dictionary = new QwpSymbolDictionary();
      const replayFrame = encodeQwpIngressFrame([symbolTable("ETH-USD")], {
        dictionary,
        confirmedMaxSymbolId: -1,
      });
      const seed = new QwpNodeFileReplayStore({ directory });
      await seed.load();
      await seed.appendSymbolDictionary(
        0,
        failureKind === "stale but valid"
          ? ["STALE-SYMBOL"]
          : dictionary.entriesFrom(0),
      );
      await seed.append({ frameSequence: 5n, payload: replayFrame });
      await seed.close();
      if (failureKind === "structurally corrupt") {
        await writeFile(join(directory, ".symbol-dict"), Uint8Array.of(0));
      }

      const connection = new FakeConnection("primary");
      const session = await QwpIngressSession.connect(async () => connection, {
        reconnect: { maxAttempts: 1 },
        replayStore: new QwpNodeFileReplayStore({ directory }),
      });
      expect(connection.sent).toHaveLength(2);
      expect(decodeQwpIngressSymbolDictionaryDelta(connection.sent[0])).toEqual(
        {
          startId: 0,
          entries: ["ETH-USD"],
        },
      );
      expect(connection.sent[1]).toEqual(replayFrame);
      await session.close();

      const verify = new QwpNodeFileReplayStore({ directory });
      await expect(verify.load()).resolves.toHaveLength(1);
      await expect(verify.loadSymbolDictionary()).resolves.toEqual(["ETH-USD"]);
      await verify.close();
      await rm(directory, { recursive: true, force: true });
    },
  );

  it("rejects corrupt sidecar recovery when committed frames are not self-contained", async () => {
    const directory = await createTemporaryDirectory();
    const dictionary = new QwpSymbolDictionary();
    dictionary.getOrAdd("ETH-USD");
    const replayFrame = encodeQwpIngressFrame([symbolTable("BTC-USD")], {
      dictionary,
      confirmedMaxSymbolId: 0,
    });
    const seed = new QwpNodeFileReplayStore({ directory });
    await seed.load();
    await seed.appendSymbolDictionary(0, dictionary.entriesFrom(0));
    await seed.append({ frameSequence: 5n, payload: replayFrame });
    await seed.close();
    await writeFile(join(directory, ".symbol-dict"), Uint8Array.of(0));

    await expect(
      QwpIngressSession.connect(async () => new FakeConnection("primary"), {
        reconnect: { maxAttempts: 1 },
        replayStore: new QwpNodeFileReplayStore({ directory }),
      }),
    ).rejects.toBeInstanceOf(QwpUnrecoverableReplayDictionaryError);

    const verify = new QwpNodeFileReplayStore({ directory });
    await expect(verify.load()).resolves.toHaveLength(1);
    await expect(verify.loadSymbolDictionary()).rejects.toBeInstanceOf(
      QwpReplayStoreCorruptionError,
    );
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
    const senderErrors: QwpSenderError[] = [];
    const session = await QwpIngressSession.connect(async () => connection, {
      reconnect: { maxAttempts: 1 },
      replayStore: new QwpNodeFileReplayStore({ directory }),
      onSenderError: (error) => senderErrors.push(error),
    });
    expect(connection.sent).toEqual([]);
    await vi.waitFor(async () =>
      expect(await assignedReplaySegments(directory)).toEqual([]),
    );
    // Retiring the tail is right, but it empties the journal with no NACK and
    // no quarantine, so it has to be announced on the abandonment channel.
    await vi.waitFor(() => expect(senderErrors).toHaveLength(1));
    expect(senderErrors[0]).toMatchObject({
      category: QWP_SENDER_ERROR_CATEGORY.DATA_LOSS,
      appliedPolicy: QWP_SENDER_ERROR_POLICY.ABANDONED,
    });
    expect(senderErrors[0].serverMessage).toContain(
      "3 deferred frame(s) whose transaction was never committed",
    );
    expect(senderErrors[0].serverMessage).toContain("[fsn=5..7]");
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
      expect(await assignedReplaySegments(directory)).toEqual([]),
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
      expect(await assignedReplaySegments(directory)).toEqual([]),
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
      expect(await assignedReplaySegments(directory)).toHaveLength(1),
    );
    connection.receive(durableResponse([["trades", 42n]]));
    await vi.waitFor(async () =>
      expect(await assignedReplaySegments(directory)).toEqual([]),
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
    expect(await assignedReplaySegments(directory)).toHaveLength(1);

    connection.receive(durableResponse([["trades", 42n]]));
    await vi.waitFor(async () =>
      expect(await assignedReplaySegments(directory)).toEqual([]),
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

  it("stops replaying a query whose response cannot be decoded", async () => {
    // Reconnecting replays the same QUERY_REQUEST, so an undecodable response
    // reproduces on every replacement connection. Each connect SUCCEEDS, so
    // connectLoop's own budget is never consumed: without charging these
    // recoveries to the failover budget the loop runs forever and the query
    // never settles.
    const connections: FakeConnection[] = [];
    const session = await QwpEgressSession.connect(
      async () => {
        const connection = new FakeConnection(`node-${connections.length}`);
        connections.push(connection);
        queueMicrotask(() =>
          connection.receive(serverInfo(connection.endpoint)),
        );
        return connection;
      },
      {
        reconnect: {
          maxAttempts: 3,
          maxDurationMs: 0,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    );

    const query = await session.query("select 1");
    for (const connection of connections) {
      connection.receive(undecodableResultBatch());
    }
    const drain = (async () => {
      for await (const _batch of query) void _batch;
    })();
    await vi.waitFor(() => expect(connections.length).toBeGreaterThan(1));
    // Every replacement gets the same undecodable batch.
    const feed = setInterval(() => {
      for (const connection of connections) {
        connection.receive(undecodableResultBatch());
      }
    }, 1);
    try {
      await expect(drain).rejects.toBeInstanceOf(QwpReconnectExhaustedError);
    } finally {
      clearInterval(feed);
    }
    // Bounded by the failover budget rather than looping without limit.
    expect(connections.length).toBeLessThanOrEqual(6);
    await session.close().catch(() => undefined);
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
        onReplayReset: (event) => void resets.push(event.requestId),
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
        onReplayReset: (event) => void resets.push(event.requestId),
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
    expect(await assignedReplaySegments(directory)).toHaveLength(1);

    const second = new QwpNodeFileReplayStore({ directory });
    await expect(second.load()).resolves.toEqual([
      { frameSequence: 0n, payload: Uint8Array.of(1, 2) },
      { frameSequence: 1n, payload: Uint8Array.of(3, 4) },
    ]);
    await second.acknowledgeThrough(0n);
    await second.close();
    expect(await readdir(directory)).toEqual(
      expect.arrayContaining([".ack-watermark"]),
    );

    const third = new QwpNodeFileReplayStore({ directory });
    await expect(third.load()).resolves.toEqual([
      { frameSequence: 1n, payload: Uint8Array.of(3, 4) },
    ]);
    await third.close();
  });

  it("indexes recovered frames without materializing their payloads", async () => {
    const directory = await trackedDirectory();
    const seed = new QwpNodeFileReplayStore({ directory });
    await seed.load();
    await seed.append({
      frameSequence: 0n,
      payload: Uint8Array.of(1, 2, 3),
    });
    await seed.append({ frameSequence: 1n, payload: Uint8Array.of(4) });
    await seed.close();

    const recovered = new QwpNodeFileReplayStore({ directory });
    await expect(recovered.loadReferences()).resolves.toEqual([
      { frameSequence: 0n, payloadLength: 3 },
      { frameSequence: 1n, payloadLength: 1 },
    ]);
    await expect(recovered.readPayload(1n)).resolves.toEqual(Uint8Array.of(4));
    await expect(recovered.readPayload(2n)).rejects.toThrow(
      /frame is not available/,
    );
    await recovered.close();
  });

  it("ignores an ack-watermark slot whose checksum does not match", async () => {
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({ directory, maxSegmentBytes: 1 });
    await store.load();
    for (let sequence = 0n; sequence < 4n; sequence++) {
      await store.append({
        frameSequence: sequence,
        payload: Uint8Array.of(Number(sequence)),
      });
    }
    // Two acknowledgements fill both alternating slots, the second carrying the
    // higher generation and the live watermark.
    await store.acknowledgeThrough(0n);
    await store.acknowledgeThrough(1n);
    await store.close();

    // Tear the winning slot the way a crash between write and fsync would:
    // move the watermark past every retained frame and leave its CRC32C stale.
    // Without the checksum this record still wins on generation, and its
    // watermark retires frames the server never acknowledged -- silent data
    // loss on exactly the crash-recovery path store-and-forward exists for.
    const ackPath = join(directory, ".ack-watermark");
    const bytes = await readFile(ackPath);
    const slotSize = 4 * 1024;
    const winner =
      bytes.readBigInt64LE(8) >= bytes.readBigInt64LE(slotSize + 8)
        ? 0
        : slotSize;
    bytes.writeBigInt64LE(9n, winner + 16);
    await writeFile(ackPath, bytes);

    // The checksum rejects it, so recovery falls back to the intact slot, whose
    // watermark is older than the segments on disk. That mismatch is caught and
    // the journal is quarantined -- fail closed. Accepting the torn record
    // instead would have resolved, silently dropping frames 2 and 3.
    const recovered = new QwpNodeFileReplayStore({ directory });
    await expect(recovered.load()).rejects.toBeInstanceOf(
      QwpReplayStoreCorruptionError,
    );
    await recovered.close();
  });

  it("recovers from a transient background maintenance failure", async () => {
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({ directory, maxSegmentBytes: 1 });
    await store.load();
    for (let sequence = 0n; sequence < 3n; sequence++) {
      await store.append({
        frameSequence: sequence,
        payload: Uint8Array.of(Number(sequence)),
      });
    }

    // Trimming an emptied segment is background work. Fail it once, the way a
    // briefly read-only or full filesystem, or a restarted maintenance worker,
    // would. The spy falls back to the real implementation afterwards, so the
    // condition is genuinely transient.
    const unlink = vi
      .spyOn(qwpSegmentMaintenanceWorker, "unlink")
      .mockRejectedValueOnce(
        Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        }),
      );

    await store.acknowledgeThrough(0n);
    await vi.waitFor(() => expect(unlink).toHaveBeenCalled());

    // The failure must not latch. Before the fix it was cleared only by
    // close(), so every later append, acknowledgeThrough and readPayload threw
    // the trim error for the rest of the process lifetime.
    // waitFor surfaces the store's own error if it never recovers, so a
    // regression reports the latched trim failure rather than a bare timeout.
    await vi.waitFor(() => store.loadSymbolDictionary(), {
      timeout: 4_000,
      interval: 100,
    });
    await expect(
      store.append({ frameSequence: 3n, payload: Uint8Array.of(3) }),
    ).resolves.toBeUndefined();
    await expect(store.acknowledgeThrough(1n)).resolves.toBeUndefined();

    unlink.mockRestore();
    await store.close();
  }, 15_000);

  it("keeps the producer alive when that failure surfaces while applying an ACK", async () => {
    // The test above proves the store self-heals. Nothing connected that to
    // the connection, which reached the parked failure through
    // assertReady() on the next ACK and ran failTerminal() -- permanent, so a
    // filesystem hiccup of about a second ended a healthy producer for the
    // rest of the process lifetime.
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({ directory, maxSegmentBytes: 1 });
    const connections: FakeConnection[] = [];
    const session = await QwpIngressSession.connect(
      async () => {
        // A fresh connection per attempt; handing back a closed one makes the
        // transport look like it keeps dying and trips poison escalation.
        const next = new FakeConnection(`endpoint-${connections.length}`);
        connections.push(next);
        return next;
      },
      { replayStore: store, reconnect: { maxAttempts: 0, maxDurationMs: 0 } },
    );

    for (let sequence = 0; sequence < 3; sequence++) {
      await session.publishFrame(Uint8Array.of(sequence));
    }

    const unlink = vi
      .spyOn(qwpSegmentMaintenanceWorker, "unlink")
      .mockRejectedValueOnce(
        Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        }),
      );

    // The first ACK schedules the trim that fails; the parked failure then
    // surfaces out of the store on the next one.
    connections[0].receive(ingressResponse(QWP_STATUS.OK, 0n));
    await vi.waitFor(() => expect(unlink).toHaveBeenCalled());
    connections[0].receive(ingressResponse(QWP_STATUS.OK, 1n));

    // A reconnect, not a terminal latch. Default backoff bounds the attempts
    // to the second or so the store needs to clear the failure.
    await vi.waitFor(() => expect(connections.length).toBeGreaterThan(1), {
      timeout: 5_000,
    });
    unlink.mockRestore();
    await vi.waitFor(() => store.loadSymbolDictionary(), {
      timeout: 5_000,
      interval: 100,
    });

    await expect(
      session.publishFrame(Uint8Array.of(9)),
    ).resolves.toBeUndefined();
    await session.close().catch(() => undefined);
    await store.close().catch(() => undefined);
  }, 20_000);

  it("closes segment handles even when the hot spare cannot be discarded", async () => {
    // discardHotSpare() rethrows anything but ENOENT from the spare's unlink
    // or the directory fsync. It shared a try with closeSegmentHandles(), so a
    // read-only or full volume skipped the second and stranded one descriptor
    // per live segment -- unreachable afterwards, because close() memoizes
    // closePromise and marks the store closed regardless.
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({ directory });
    await store.load();
    await store.append({ frameSequence: 0n, payload: Uint8Array.of(1) });

    const internals = store as unknown as {
      segments: Map<unknown, { handle?: unknown }>;
      hotSpare?: { path: string };
    };
    const openHandles = () =>
      [...internals.segments.values()].filter(
        (segment) => segment.handle !== undefined,
      ).length;
    // The spare is provisioned in the background after the first append.
    await vi.waitFor(() => expect(internals.hotSpare).toBeDefined());
    const sparePath = internals.hotSpare!.path;
    expect(openHandles()).toBeGreaterThan(0);

    // Only the spare's own unlink fails; every other maintenance path is
    // left alone so the failure is unambiguously discardHotSpare()'s.
    const realUnlink = qwpSegmentMaintenanceWorker.unlink.bind(
      qwpSegmentMaintenanceWorker,
    );
    const unlink = vi
      .spyOn(qwpSegmentMaintenanceWorker, "unlink")
      .mockImplementation(async (path: string) => {
        if (path !== sparePath) return realUnlink(path);
        throw Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        });
      });

    // The failure is still reported rather than swallowed...
    await expect(store.close()).rejects.toThrow(/could not discard/);
    // ...and the segment handles are released anyway.
    expect(openHandles()).toBe(0);

    unlink.mockRestore();
  });

  it("detects a replay gap immediately after a persisted ACK watermark", async () => {
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 1,
    });
    await first.load();
    for (let sequence = 0n; sequence < 3n; sequence++) {
      await first.append({
        frameSequence: sequence,
        payload: Uint8Array.of(Number(sequence)),
      });
    }
    await first.acknowledgeThrough(0n);
    await first.close();

    const segments = await assignedReplaySegments(directory);
    const path = join(directory, segments[segments.length - 1]);
    const file = await open(path, "r+");
    try {
      const sequence = Buffer.alloc(8);
      sequence.writeBigUInt64LE(3n);
      // SFA derives frame sequences from each segment's durable base.
      await file.write(sequence, 0, sequence.byteLength, 8);
      await file.sync();
    } finally {
      await file.close();
    }

    const recovered = new QwpNodeFileReplayStore({ directory });
    await expect(recovered.load()).rejects.toBeInstanceOf(
      QwpReplayStoreCorruptionError,
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
    for (let sequence = 0n; sequence < 100n; sequence++) {
      await store.append({
        frameSequence: sequence,
        payload: Uint8Array.of(1),
      });
    }
    const segments = await assignedReplaySegments(directory);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.length).toBeLessThan(100);
    expect(store.metrics).toMatchObject({
      pendingRecords: 100,
      pendingSegments: segments.length,
    });
    for (const segment of segments) {
      expect((await stat(join(directory, segment))).size).toBe(24 + 8 + 256);
    }
    await store.close();
  });

  it("recovers SFA segments after maxSegmentBytes changes", async () => {
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 1,
    });
    await first.load();
    await first.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
    await first.close();

    const second = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 256,
    });
    await expect(second.load()).resolves.toEqual([
      { frameSequence: 0n, payload: Uint8Array.of(1) },
    ]);
    await second.append({ frameSequence: 1n, payload: Uint8Array.of(2) });
    await second.close();

    const third = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 512,
    });
    await expect(third.load()).resolves.toEqual([
      { frameSequence: 0n, payload: Uint8Array.of(1) },
      { frameSequence: 1n, payload: Uint8Array.of(2) },
    ]);
    await third.close();
  });

  it("repairs a torn append at the tail of the active segment", async () => {
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({ directory });
    await first.load();
    await first.append({ frameSequence: 0n, payload: Uint8Array.of(1, 2, 3) });
    await first.close();
    const [segment] = await assignedReplaySegments(directory);
    const validSize = (await stat(join(directory, segment))).size;
    const file = await open(join(directory, segment), "r+");
    try {
      await file.write(Uint8Array.of(0x51, 0x57), 0, 2, 24 + 8 + 3);
      await file.sync();
    } finally {
      await file.close();
    }

    const recovered = new QwpNodeFileReplayStore({ directory });
    await expect(recovered.load()).resolves.toEqual([
      { frameSequence: 0n, payload: Uint8Array.of(1, 2, 3) },
    ]);
    expect((await stat(join(directory, segment))).size).toBe(validSize);
    await recovered.close();
  });

  it("reports a CRC-failing record at the active segment tail", async () => {
    // A zero-filled active tail may be an append that never completed, but a
    // complete record whose payload no longer matches its CRC proves that
    // journal bytes were abandoned. This is especially important for memory
    // durability, where page-cache writeback can persist those pieces out of
    // order after append already returned to the producer.
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({
      directory,
      durability: QWP_SF_DURABILITY.MEMORY,
    });
    await first.load();
    await first.append({ frameSequence: 0n, payload: Uint8Array.of(1, 1, 1) });
    await first.append({ frameSequence: 1n, payload: Uint8Array.of(2, 2, 2) });
    await first.close();

    const [segment] = await assignedReplaySegments(directory);
    const recordSize = 8 + 3;
    const secondPayload = 24 + recordSize + 8;
    const file = await open(join(directory, segment), "r+");
    try {
      await file.write(Uint8Array.of(0xff), 0, 1, secondPayload);
      await file.sync();
    } finally {
      await file.close();
    }

    const reports: QwpNodeReplayDataLossReport[] = [];
    const recovered = new QwpNodeFileReplayStore({
      directory,
      durability: QWP_SF_DURABILITY.MEMORY,
      onRecoveryDataLoss: (report) => reports.push(report),
    });
    await expect(recovered.loadReferences()).resolves.toEqual([
      { frameSequence: 0n, payloadLength: 3 },
    ]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      directory,
      segmentFile: segment,
      reason: expect.stringContaining("CRC32C"),
    });
    // Exactly the abandoned record, not the segment's preallocated tail.
    // Measuring to EOF reported the whole 4 MiB segment for this one lost
    // record, which tells an operator nothing about the real loss.
    expect(reports[0].discardedBytes).toBe(recordSize);
    await recovered.close();
  });

  it.each([
    ["a zeroed record", "hole"],
    ["a flipped payload byte", "bitrot"],
  ] as const)(
    "reports the records %s strands behind it instead of dropping them silently",
    async (_label, shape) => {
      // Truncating here is only correct for an unwritten tail. A lost block --
      // what an unordered page-cache writeback leaves after a host crash under
      // the connect-string default durability -- or bit rot strands the records
      // behind it. Replay needs a contiguous sequence, so the tear makes them
      // unreachable whatever recovery does; the Java client abandons the
      // active segment's residue by policy for exactly that reason. What it
      // must never do is abandon them without saying so.
      const directory = await trackedDirectory();
      const first = new QwpNodeFileReplayStore({ directory });
      await first.load();
      for (let sequence = 0; sequence < 5; sequence++) {
        await first.append({
          frameSequence: BigInt(sequence),
          payload: Uint8Array.of(sequence, sequence, sequence),
        });
      }
      await first.close();

      const [segment] = await assignedReplaySegments(directory);
      const recordSize = 8 + 3;
      const secondRecord = 24 + recordSize * 2;
      const file = await open(join(directory, segment), "r+");
      try {
        await file.write(
          shape === "hole" ? new Uint8Array(recordSize) : Uint8Array.of(0xff),
          0,
          shape === "hole" ? recordSize : 1,
          shape === "hole" ? secondRecord : secondRecord + 8,
        );
        await file.sync();
      } finally {
        await file.close();
      }

      const reports: QwpNodeReplayDataLossReport[] = [];
      const recovered = new QwpNodeFileReplayStore({
        directory,
        onRecoveryDataLoss: (report) => reports.push(report),
      });
      // Recovery still succeeds on the valid prefix, so the producer keeps
      // running rather than being blocked behind an operator.
      await expect(recovered.load()).resolves.toEqual([
        { frameSequence: 0n, payload: Uint8Array.of(0, 0, 0) },
        { frameSequence: 1n, payload: Uint8Array.of(1, 1, 1) },
      ]);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        directory,
        segmentFile: segment,
        reason: expect.stringContaining("replay can no longer reach"),
      });
      expect(reports[0].discardedBytes).toBeGreaterThan(0);
      // Written bytes only. These records carry 3-byte payloads, so the loss
      // is tens of bytes; the segment is preallocated to 4 MiB and measuring
      // to EOF used to report all of it.
      expect(reports[0].discardedBytes).toBeLessThan(1024);
      await recovered.close();
    },
  );

  it("reports a tail segment whose records never reached disk", async () => {
    // The one damage shape that stayed silent. A record region reading back as
    // zeros all the way to EOF scans as an ordinary unwritten tail -- no torn
    // record, no CRC mismatch, no bytes to count -- so recovery returned the
    // surviving prefix and called it success. It is also exactly what an
    // unordered page-cache writeback leaves after a host crash: the header
    // survives because activateHotSpare fsyncs it, while the records do not,
    // because the connect-string default durability never fsyncs them. A whole
    // segment of accepted frames could vanish with no callback and no log.
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 4096,
      durability: "memory",
    });
    await first.load();
    for (let sequence = 0; sequence < 12; sequence++) {
      await first.append({
        frameSequence: BigInt(sequence),
        payload: new Uint8Array(600).fill(sequence + 1),
      });
    }
    await first.close();

    const segments = await assignedReplaySegments(directory);
    expect(segments.length).toBeGreaterThan(1);
    const tail = segments[segments.length - 1];
    const path = join(directory, tail);
    const size = (await stat(path)).size;
    const file = await open(path, "r+");
    try {
      // Header intact, every record byte lost.
      await file.write(Buffer.alloc(size - 24, 0), 0, size - 24, 24);
      await file.sync();
    } finally {
      await file.close();
    }

    const reports: QwpNodeReplayDataLossReport[] = [];
    const recovered = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 4096,
      durability: "memory",
      onRecoveryDataLoss: (report) => reports.push(report),
    });
    const frames = await recovered.load();
    expect(frames.length).toBeLessThan(12);
    expect(reports).toHaveLength(1);
    expect(reports[0].segmentFile).toBe(tail);
    // No readable record survives, so there is nothing to measure: zero here
    // means "extent unknown", which the reason has to spell out.
    expect(reports[0].discardedBytes).toBe(0);
    expect(reports[0].reason).toMatch(/no readable records/);
    await recovered.close();
  });

  it("stays silent when an undamaged journal is reopened", async () => {
    // The counterpart to the test above: an ordinary reopen must not report a
    // loss, or the notification means nothing.
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 4096,
      durability: "memory",
    });
    await first.load();
    for (let sequence = 0; sequence < 12; sequence++) {
      await first.append({
        frameSequence: BigInt(sequence),
        payload: new Uint8Array(600).fill(sequence + 1),
      });
    }
    await first.close();

    const reports: QwpNodeReplayDataLossReport[] = [];
    const recovered = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 4096,
      durability: "memory",
      onRecoveryDataLoss: (report) => reports.push(report),
    });
    await expect(recovered.load()).resolves.toHaveLength(12);
    expect(reports).toEqual([]);
    await recovered.close();
  });

  it("reports the records a damaged length field strands behind it", async () => {
    // The length field is read before the CRC32C that would have covered it,
    // so corrupting it is the one damage shape that reaches repair without any
    // integrity check firing. Recovery still abandons the suffix by the same
    // policy as a CRC tear, but it used to do it in silence: no report, no
    // sentinel, nothing an operator could act on, while the intact records
    // behind the damaged one were zeroed off the disk.
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({ directory });
    await first.load();
    for (let sequence = 0; sequence < 5; sequence++) {
      await first.append({
        frameSequence: BigInt(sequence),
        payload: Uint8Array.of(sequence, sequence, sequence),
      });
    }
    await first.close();

    const [segment] = await assignedReplaySegments(directory);
    const recordSize = 8 + 3;
    const secondRecord = 24 + recordSize * 2;
    const path = join(directory, segment);
    const thirdRecordPayload = Uint8Array.of(3, 3, 3);
    expect(await payloadOffsetIn(path, thirdRecordPayload)).toBeGreaterThan(0);

    // Overshoot EOF by the declared payload length alone, leaving every other
    // header byte -- including the record's own CRC32C -- untouched.
    const damagedLength = Buffer.alloc(4);
    damagedLength.writeUInt32LE(0xf0000000, 0);
    const file = await open(path, "r+");
    try {
      await file.write(damagedLength, 0, 4, secondRecord + 4);
      await file.sync();
    } finally {
      await file.close();
    }

    const reports: QwpNodeReplayDataLossReport[] = [];
    const recovered = new QwpNodeFileReplayStore({
      directory,
      onRecoveryDataLoss: (report) => reports.push(report),
    });
    await expect(recovered.load()).resolves.toEqual([
      { frameSequence: 0n, payload: Uint8Array.of(0, 0, 0) },
      { frameSequence: 1n, payload: Uint8Array.of(1, 1, 1) },
    ]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      directory,
      segmentFile: segment,
      reason: expect.stringContaining("runs past the end of the segment"),
    });
    // The records behind the tear are gone, so the report has to account for
    // them rather than for the preallocated padding.
    expect(reports[0].discardedBytes).toBeGreaterThan(0);
    expect(reports[0].discardedBytes).toBeLessThan(1024);
    expect(await payloadOffsetIn(path, thirdRecordPayload)).toBe(-1);
    await recovered.close();
  });

  it("still fails closed when a sealed segment has a torn record", async () => {
    // Java zeroes a sealed suffix only on proof that its frame accounting is
    // complete; a tear that cost frames fails recovery before any mutation so
    // every byte stays on disk for extraction.
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 32,
    });
    await first.load();
    for (let sequence = 0; sequence < 6; sequence++) {
      await first.append({
        frameSequence: BigInt(sequence),
        payload: Uint8Array.of(sequence, sequence, sequence),
      });
    }
    await first.close();

    const segments = await assignedReplaySegments(directory);
    expect(segments.length).toBeGreaterThan(1);
    const sealed = await open(join(directory, segments[0]), "r+");
    try {
      await sealed.write(Uint8Array.of(0xff), 0, 1, 24 + 8);
      await sealed.sync();
    } finally {
      await sealed.close();
    }

    const reports: QwpNodeReplayDataLossReport[] = [];
    const recovered = new QwpNodeFileReplayStore({
      directory,
      onRecoveryDataLoss: (report) => reports.push(report),
    });
    await expect(recovered.load()).rejects.toBeInstanceOf(
      QwpReplayStoreCorruptionError,
    );
    expect(reports).toEqual([]);
    await recovered.close().catch(() => undefined);
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
      expect(await readdir(directory)).toContain(".symbol-dict");
      await first.close();
      await expectOnlyJavaSlotLockMetadata(directory);

      const second = new QwpNodeFileReplayStore({ directory, durability });
      await expect(second.load()).resolves.toEqual([]);
      await expect(second.loadSymbolDictionary()).resolves.toEqual([]);
      await expect(
        second.appendSymbolDictionary(0, ["BTC-USD"]),
      ).resolves.toBeUndefined();
      await second.close();
      await expectOnlyJavaSlotLockMetadata(directory);
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
    await expectOnlyJavaSlotLockMetadata(directory);
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
    } satisfies Partial<QwpReplayStoreLockedError>);

    await first.append({ frameSequence: 0n, payload: Uint8Array.of(7) });
    await first.close();
    await expect(second.load()).resolves.toEqual([
      { frameSequence: 0n, payload: Uint8Array.of(7) },
    ]);
    await second.close();
  });

  it("arbitrates acquisition over stale Java lock metadata", async () => {
    const directory = await trackedDirectory();
    await writeFile(join(directory, ".lock"), "");
    await writeFile(join(directory, ".lock.pid"), "2147483647\n");

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
    await stores[winner].close();
    await expect(stores[loser].load()).resolves.toEqual([]);
    await stores[loser].close();
    await expectOnlyJavaSlotLockMetadata(directory);
  });

  it("refuses to append once its slot lock can no longer be vouched for", async () => {
    // A holder paused past the staleness window -- a long synchronous section,
    // a suspended VM, a stalled filesystem -- can have its slot reclaimed while
    // it still believes it holds it. It used to keep appending: the writes
    // resolved, and because a frame's sequence comes from its position in the
    // segment, an overwrite of the same width reopened as a complete journal
    // with the new owner's frames silently gone.
    //
    // Only Date is faked here: the heartbeat is what must *not* get a chance to
    // run, which is exactly the window the first write after resuming lands in.
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      backpressurePolicy: QWP_SF_BACKPRESSURE_POLICY.WAIT,
      appendDeadlineMs: 100,
    });
    await store.load();
    await store.append({ frameSequence: 0n, payload: Uint8Array.of(1) });

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 20_000);
      await expect(
        store.append({ frameSequence: 1n, payload: Uint8Array.of(2) }),
      ).rejects.toMatchObject({ name: "QwpReplayStoreLockLostError" });
    } finally {
      vi.useRealTimers();
    }
    await store.close().catch(() => undefined);
  });

  it("treats an owner directory with no record yet as held", async () => {
    // The state every acquisition passes through between its mkdir and its
    // owner-record write. Staleness used to fall back to the `.lock.pid`
    // sidecar, which outlives its holder for Java parity and so always names a
    // process that has exited -- and it stamped that dead PID with the local
    // hostname, so the same-host guard could not reject it. A contender
    // arriving in that window declared a just-created directory stale and
    // renamed it away from its live owner.
    const directory = await trackedDirectory();
    await mkdir(join(directory, ".lock.owner"));
    await writeFile(join(directory, ".lock"), "");
    await writeFile(join(directory, ".lock.pid"), "2147483647\n");
    const ownerInode = (await stat(join(directory, ".lock.owner"))).ino;

    const store = new QwpNodeFileReplayStore({ directory });
    await expect(store.load()).rejects.toMatchObject({
      name: "QwpReplayStoreLockedError",
    });
    expect((await stat(join(directory, ".lock.owner"))).ino).toBe(ownerInode);
  });

  it("does not remove an owner directory a later acquisition owns", async () => {
    // A release can be retried long after the fact, and the pathname it holds
    // is reused the moment the lock changes hands. Removing by path alone
    // stripped whichever acquisition occupied the path at that point.
    const directory = await trackedDirectory();
    const lock = await QwpNodeAdvisoryLock.acquire(directory);
    const ownerFile = join(directory, ".lock.owner", "owner");

    // Stand in for the pathname having been handed to another acquisition.
    await writeFile(
      ownerFile,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        token: "someone-else",
      }),
    );

    await lock.release();
    await expect(stat(join(directory, ".lock.owner"))).resolves.toBeDefined();
    expect(JSON.parse(await readFile(ownerFile, "utf8")).token).toBe(
      "someone-else",
    );
    await rm(join(directory, ".lock.owner"), { recursive: true, force: true });
  });

  it("makes the ACK watermark durable before the manifest that trimming advanced", async () => {
    // writeManifest() fsyncs the manifest and the directory whatever the
    // durability mode, while the watermark write skips its fsync outside
    // "append". A trim runs straight after the ACK that emptied the segment,
    // so a power loss could leave a durable head above a watermark still in
    // the page cache -- and recovery rejects that pair for the whole journal
    // rather than losing the checkpoint window "periodic" promises.
    //
    // The ordering is not observable from outside without a real power cut, so
    // assert the flag that drives it: after a trim nothing may be left
    // unsynced. Dropping the syncAcknowledgement() call from writeManifest()
    // leaves it true.
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 8192,
      durability: "periodic",
      checkpointIntervalMs: 3_600_000,
    });
    const internals = store as unknown as { acknowledgementUnsynced: boolean };
    await store.load();
    for (let sequence = 0n; sequence < 10n; sequence++) {
      await store.append({
        frameSequence: sequence,
        payload: new Uint8Array(2048),
      });
    }

    // An ACK that empties no segment leaves the watermark for the checkpoint,
    // which is an hour away here -- so the flag is meaningful.
    await store.acknowledgeThrough(0n);
    expect(internals.acknowledgementUnsynced).toBe(true);

    // This one trims, so the manifest advances and the watermark must overtake
    // it on disk first.
    await store.acknowledgeThrough(5n);
    await vi.waitFor(async () =>
      expect(await assignedReplaySegments(directory)).not.toHaveLength(4),
    );
    expect(internals.acknowledgementUnsynced).toBe(false);
    await store.close();
  });

  it("leaves the directory alone once its slot lock was reclaimed", async () => {
    // assertReady() fences the public mutators, but background maintenance and
    // every teardown step ran outside it -- and close() is reached by exactly
    // the terminal path a lost lock triggers, so losing the slot was what set
    // the deletions going. They unlinked the successor's segments, its
    // sf-manifest.bin and its .symbol-dict, and dropped its .ack-watermark,
    // which resurrects acknowledged frames for re-send.
    const directory = await trackedDirectory();
    const evicted = new QwpNodeFileReplayStore({ directory });
    await evicted.load();
    await evicted.appendSymbolDictionary(0, ["evicted"]);
    await evicted.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
    // Fully drained, so close() takes the teardown paths that delete: the
    // watermark, the dictionary, and the parent-anchored orphan pair.
    await evicted.acknowledgeThrough(0n);
    // acknowledgeThrough() schedules segment trimming in the background. Let
    // that work settle before manufacturing a stale lease: otherwise the test
    // can make the successor scan a segment that this still-live store is
    // concurrently removing, which is not the paused-holder scenario below.
    await vi.waitFor(
      async () => {
        expect(evicted.metrics.pendingSegments).toBe(0);
        expect(await readdir(directory)).not.toContain(".ack-watermark");
      },
      { timeout: 5_000 },
    );

    // Stand in for a holder paused past the staleness window: the slot is
    // reclaimed while this store still has it open.
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(join(directory, ".lock.owner"), longAgo, longAgo);
    const successor = new QwpNodeFileReplayStore({ directory });
    await expect(successor.load()).resolves.toBeDefined();
    const inherited = await successor.loadSymbolDictionary();
    await successor.appendSymbolDictionary(inherited.length, ["successor"]);
    await successor.append({ frameSequence: 1n, payload: Uint8Array.of(9) });
    await successor.acknowledgeThrough(1n);
    await successor.append({ frameSequence: 2n, payload: Uint8Array.of(10) });
    // A hot spare is provisioned in the background under a .tmp- name, so it
    // can appear between the two listings. It is scratch space, not journal
    // state, and it is not what this test is about.
    const durableEntries = async () =>
      (await readdir(directory))
        .filter((name) => !name.includes(".tmp-"))
        .sort();
    const before = await durableEntries();
    const successorDictionary = await readFile(join(directory, ".symbol-dict"));

    // The evicted store notices on its next mutating call, then shuts down --
    // which is the moment it used to start deleting. Only Date is faked, so
    // the heartbeat cannot run: this is the window a paused holder resumes in.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 20_000);
      await expect(
        evicted.append({ frameSequence: 1n, payload: Uint8Array.of(2) }),
      ).rejects.toMatchObject({ name: "QwpReplayStoreLockLostError" });
      await evicted.close().catch(() => undefined);
    } finally {
      vi.useRealTimers();
    }

    expect(await durableEntries()).toEqual(before);
    expect(await readFile(join(directory, ".symbol-dict"))).toEqual(
      successorDictionary,
    );
    // The successor is still healthy, and still owns the lock it took.
    await successor.append({ frameSequence: 3n, payload: Uint8Array.of(11) });
    await successor.close();
  });

  it("survives a transient failure to read its own owner record", async () => {
    // Reading the record needs a descriptor; stat() and utimes() do not. So
    // process-wide descriptor pressure -- from anywhere in the host app -- and
    // EIO or NFS ESTALE fail precisely this one call while the rest of the
    // heartbeat still succeeds. Treating that as a takeover latched the lock
    // permanently, because the same step also stops the heartbeat that would
    // clear it: every later append then failed with "taken over by another
    // process" for a slot nobody took, and release() threw. Staleness of
    // provenAtMs is what keeps an unprovable beat fail-closed, and unlike a
    // latch it recovers.
    const directory = await trackedDirectory();
    const lock = await QwpNodeAdvisoryLock.acquire(directory);
    const beat = () =>
      (lock as unknown as { beat(): Promise<void> }).beat.call(lock);
    const ownerPath = join(directory, ".lock.owner");
    const recordPath = join(ownerPath, "owner");
    const record = await readFile(recordPath, "utf8");
    const untouched = await stat(ownerPath);

    // A directory where the record belongs yields EISDIR for every user, root
    // included, so this stands in for a transient fault without a mock.
    await unlink(recordPath);
    await mkdir(recordPath);
    // Adding and removing an entry moves the parent's mtime. Put it back, so
    // the beat's staleness check sees exactly the value it last wrote and the
    // read is the only thing that fails.
    await utimes(ownerPath, untouched.atime, untouched.mtime);

    await beat();
    expect(lock.lost).toBe(false);

    // The fault clears, and the lock is still usable rather than latched.
    await rm(recordPath, { recursive: true });
    await writeFile(recordPath, record);
    await utimes(ownerPath, untouched.atime, untouched.mtime);

    await beat();
    expect(lock.lost).toBe(false);
    await expect(lock.release()).resolves.toBeUndefined();
    await expect(stat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never re-proves a slot lock in place once it has gone stale", async () => {
    // A holder paused past the staleness window is already `lost` by its own
    // rule, and a contender is entitled to reclaim its slot the moment the
    // mtime is that old. The owner-record read and the mtime touch inside a
    // beat are separate syscalls, so a reclaim landing between them let a
    // resuming beat stamp the new owner's directory and reset provenAtMs --
    // clearing the fence and un-fencing a lock this process had already lost.
    // One beat later the rightful owner saw a drifted mtime and fenced itself
    // off its own slot. A stale holder recovers by re-entering contention, so
    // what has to hold is that it never touches the directory in place.
    const directory = await trackedDirectory();
    const lock = await QwpNodeAdvisoryLock.acquire(directory);
    const beat = () =>
      (lock as unknown as { beat(): Promise<void> }).beat.call(lock);
    const ownerPath = join(directory, ".lock.owner");

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 20_000);
      expect(lock.lost).toBe(true);

      // A successor adopted the slot while this holder was stalled, and is
      // heartbeating: its directory carries its own token and a current mtime.
      await rm(ownerPath, { recursive: true, force: true });
      await mkdir(ownerPath);
      await writeFile(
        join(ownerPath, "owner"),
        JSON.stringify({
          pid: process.pid,
          host: hostname(),
          token: "successor-token",
        }),
      );
      const live = new Date(Date.now());
      await utimes(ownerPath, live, live);
      const successorMtimeMs = (await stat(ownerPath)).mtimeMs;

      await beat();

      // Fenced for good, and the successor's directory is byte-for-byte as it
      // left it -- neither stamped nor reclaimed.
      expect(lock.lost).toBe(true);
      expect((await stat(ownerPath)).mtimeMs).toBe(successorMtimeMs);
      expect(
        JSON.parse(await readFile(join(ownerPath, "owner"), "utf8")).token,
      ).toBe("successor-token");
    } finally {
      vi.useRealTimers();
    }
    await lock.release().catch(() => undefined);
  });

  it("recovers a slot lock after a stall nobody contended", async () => {
    // Fencing on staleness is right -- the holder genuinely cannot prove it
    // still owns the slot -- but latching there is not. `beat()` is the only
    // writer of provenAtMs and used to decline to run once `lost`, so a
    // suspended VM, a debugger pause or a long event-loop block ended a
    // producer for the life of the process even with no contender at all.
    const directory = await trackedDirectory();
    const lock = await QwpNodeAdvisoryLock.acquire(directory);
    const beat = () =>
      (lock as unknown as { beat(): Promise<void> }).beat.call(lock);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 20_000);
      expect(lock.lost).toBe(true);

      await beat();

      // The token still matched, so nobody adopted the slot and the journal
      // behind it was never replayed by anyone else.
      expect(lock.lost).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    await lock.release();
    await expectOnlyJavaSlotLockMetadata(directory);
  });

  it("keeps appending after the slot lock recovers from a stall", async () => {
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({ directory });
    await store.load();
    await store.append({ frameSequence: 0n, payload: Uint8Array.of(1, 2, 3) });

    const lock = (store as unknown as { slotLock: QwpNodeAdvisoryLock })
      .slotLock;
    const beat = () =>
      (lock as unknown as { beat(): Promise<void> }).beat.call(lock);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // The clock stays advanced for the rest of the test: the process resumed
      // at a later wall-clock time and keeps running there. Handing it back to
      // real time would clear `lost` on its own, because provenAtMs was
      // stamped before the jump, and the assertion below would pass with or
      // without a recovery path.
      vi.setSystemTime(Date.now() + 20_000);
      await expect(
        store.append({ frameSequence: 1n, payload: Uint8Array.of(4, 5, 6) }),
      ).rejects.toBeInstanceOf(QwpReplayStoreLockLostError);

      await beat();

      // The producer is live again rather than terminal for the rest of the
      // process, and the frame staged before the stall is still journalled.
      await store.append({
        frameSequence: 1n,
        payload: Uint8Array.of(4, 5, 6),
      });
      await store.close();
    } finally {
      vi.useRealTimers();
    }

    const reopened = new QwpNodeFileReplayStore({ directory });
    await expect(reopened.load()).resolves.toEqual([
      { frameSequence: 0n, payload: Uint8Array.of(1, 2, 3) },
      { frameSequence: 1n, payload: Uint8Array.of(4, 5, 6) },
    ]);
    await reopened.close();
  });

  it("reclaims a slot whose owner heartbeat stopped", async () => {
    const directory = await trackedDirectory();
    const ownerPath = join(directory, ".lock.owner");
    await mkdir(ownerPath);
    // A live PID with an mtime far beyond the staleness window: only the
    // stopped heartbeat marks this owner as gone.
    await writeFile(
      join(ownerPath, "owner"),
      JSON.stringify({ pid: process.pid, host: hostname() }),
    );
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(ownerPath, longAgo, longAgo);

    const store = new QwpNodeFileReplayStore({ directory });
    await expect(store.load()).resolves.toEqual([]);
    expect(await readFile(join(directory, ".lock.pid"), "utf8")).toBe(
      `${process.pid}\n`,
    );
    await store.close();
    await expectOnlyJavaSlotLockMetadata(directory);
  });

  it("reclaims a slot whose owner process is gone from this host", async () => {
    const directory = await trackedDirectory();
    const ownerPath = join(directory, ".lock.owner");
    await mkdir(ownerPath);
    // Fresh mtime, so only the dead PID can justify reclaiming the slot. The
    // kernel used to do this for us by releasing the flock on process exit.
    await writeFile(
      join(ownerPath, "owner"),
      JSON.stringify({ pid: 2147483647, host: hostname() }),
    );

    const store = new QwpNodeFileReplayStore({ directory });
    await expect(store.load()).resolves.toEqual([]);
    await store.close();
    await expectOnlyJavaSlotLockMetadata(directory);
  });

  it("leaves a slot owned by a live heartbeat alone", async () => {
    const directory = await trackedDirectory();
    const ownerPath = join(directory, ".lock.owner");
    await mkdir(ownerPath);
    // A PID on another host can never be probed for liveness, so a fresh
    // heartbeat is the only thing keeping this slot held.
    await writeFile(
      join(ownerPath, "owner"),
      JSON.stringify({ pid: 4242, host: `${hostname()}-elsewhere` }),
    );
    await writeFile(join(directory, ".lock.pid"), "4242\n");

    const store = new QwpNodeFileReplayStore({ directory });
    await expect(store.load()).rejects.toMatchObject({
      name: "QwpReplayStoreLockedError",
      directory,
      holderPid: 4242,
    } satisfies Partial<QwpReplayStoreLockedError>);
  });

  it("retires logical lock files after a slot is fully drained", async () => {
    const rootDirectory = await trackedDirectory();
    const directory = join(rootDirectory, "sender-0");
    const store = new QwpNodeFileReplayStore({ directory });
    await store.load();
    await store.close();

    expect(await readdir(join(rootDirectory, ".slot-locks"))).toEqual([]);
    await expectOnlyJavaSlotLockMetadata(directory);
  });

  it("recovers a persisted dictionary and truncates a torn append tail", async () => {
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({ directory });
    await first.load();
    await first.appendSymbolDictionary(0, ["ETH-USD", "BTC-USD"]);
    await first.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
    await first.close();
    await writeFile(join(directory, ".symbol-dict"), Uint8Array.of(1, 2, 3), {
      flag: "a",
    });

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
    // Asserted while the store still holds the slot, so the owner directory is
    // expected here; nothing journal-shaped may exist alongside it.
    expect((await readdir(directory)).sort()).toEqual([
      ".lock",
      ".lock.owner",
      ".lock.pid",
    ]);
    await store.close();
    await expectOnlyJavaSlotLockMetadata(directory);
  });

  it("does not wait on a non-retryable append invariant", async () => {
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      backpressurePolicy: QWP_SF_BACKPRESSURE_POLICY.WAIT,
      appendDeadlineMs: 1_000,
    });
    await store.load();
    await store.append({ frameSequence: 0n, payload: Uint8Array.of(1) });

    await expect(
      store.append({ frameSequence: 0n, payload: Uint8Array.of(1) }),
    ).rejects.toMatchObject({
      name: "QwpReplayStoreError",
      retryable: false,
      message:
        "QWP store-and-forward sequence already exists [frameSequence=0]",
    });
    expect(store.metrics).toMatchObject({
      waitingAppends: 0,
      totalBackpressureStalls: 0,
      totalAppendTimeouts: 0,
    });
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

  it("bounds waiting appends when a periodic checkpoint cannot recover", async () => {
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxBytes: 66,
      maxSegmentBytes: 1,
      durability: QWP_SF_DURABILITY.PERIODIC,
      checkpointIntervalMs: 100,
      backpressurePolicy: QWP_SF_BACKPRESSURE_POLICY.WAIT,
      appendDeadlineMs: 500,
    });
    await store.load();
    await store.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
    await store.append({ frameSequence: 1n, payload: Uint8Array.of(2) });
    await store.appendSymbolDictionary(0, ["BTC-USD"]);
    await unlink(join(directory, ".symbol-dict"));

    const blocked = store.append({
      frameSequence: 2n,
      payload: Uint8Array.of(3),
    });
    const rejection = expect(blocked).rejects.toBeInstanceOf(
      QwpReplayStoreAppendTimeoutError,
    );
    await vi.waitFor(() => expect(store.metrics.waitingAppends).toBe(1));
    await vi.waitFor(() =>
      expect(store.metrics.totalCheckpointFailures).toBeGreaterThan(0),
    );
    await rejection;
    expect(store.metrics).toMatchObject({
      waitingAppends: 0,
      totalAppendTimeouts: 1,
    });
    await expect(store.close()).rejects.toBeInstanceOf(
      QwpReplayStoreCheckpointError,
    );
    // The slot lock is released even though close() rejected: no owner
    // directory remains, so another store can take the slot.
    await expect(readdir(directory)).resolves.not.toContain(".lock.owner");
    const reopened = new QwpNodeFileReplayStore({ directory });
    await reopened.load();
    await reopened.close();
  });

  it("waits out a transient hot-spare write fault", async () => {
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 1,
      backpressurePolicy: QWP_SF_BACKPRESSURE_POLICY.WAIT,
      appendDeadlineMs: 3_000,
    });
    await store.load();
    await store.append({ frameSequence: 0n, payload: Uint8Array.of(1) });

    // Let the first append replenish its hot spare before injecting faults. The
    // first failure then hits background replenishment after frame 1; the second
    // hits frame 2's required provisioning path and reaches appendWithBackpressure
    // as a plain, retryable QwpReplayStoreError. The next retry uses the real
    // worker and succeeds.
    const internals = store as unknown as { hotSpare?: unknown };
    await vi.waitFor(() => expect(internals.hotSpare).toBeDefined());
    const transient = Object.assign(new Error("EACCES: permission denied"), {
      code: "EACCES",
    });
    const provision = vi
      .spyOn(qwpSegmentMaintenanceWorker, "provision")
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient);

    await store.append({ frameSequence: 1n, payload: Uint8Array.of(2) });
    await vi.waitFor(() => expect(provision).toHaveBeenCalledTimes(1));
    const recovering = store.append({
      frameSequence: 2n,
      payload: Uint8Array.of(3),
    });
    await vi.waitFor(() =>
      expect(store.metrics.totalBackpressureStalls).toBe(1),
    );
    await expect(recovering).resolves.toBeUndefined();
    expect(provision.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(store.metrics).toMatchObject({
      pendingRecords: 3,
      waitingAppends: 0,
      totalBackpressureStalls: 1,
      totalAppendTimeouts: 0,
    });

    provision.mockRestore();
    await store.close();
  }, 10_000);

  it("keeps a parked append waiting across a transient trim fault", async () => {
    // The permanent checkpoint failure above reaches the append deadline.
    // Maintenance retries and self-heals, so a parked append must instead be
    // released when that retry frees capacity -- never rejected with the
    // retryable trim error, which is not the deadline error a producer watches.
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxBytes: 66,
      maxSegmentBytes: 1,
      backpressurePolicy: QWP_SF_BACKPRESSURE_POLICY.WAIT,
      appendDeadlineMs: 5_000,
    });
    await store.load();
    await store.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
    await store.append({ frameSequence: 1n, payload: Uint8Array.of(2) });

    const blocked = store.append({
      frameSequence: 2n,
      payload: Uint8Array.of(3),
    });
    await vi.waitFor(() => expect(store.metrics.waitingAppends).toBe(1));

    // Fail the trim that frees capacity once; the retry a second later uses the
    // real implementation, so the fault is genuinely transient.
    const unlink = vi
      .spyOn(qwpSegmentMaintenanceWorker, "unlink")
      .mockRejectedValueOnce(
        Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        }),
      );

    await store.acknowledgeThrough(0n);

    // The parked append survives the fault: the retry releases it rather than
    // the failure rejecting it, and it never reaches its append deadline.
    await expect(blocked).resolves.toBeUndefined();
    expect(unlink).toHaveBeenCalled();
    expect(store.metrics).toMatchObject({
      waitingAppends: 0,
      totalAppendTimeouts: 0,
    });

    unlink.mockRestore();
    await store.close();
  }, 15_000);

  it("waits out a self-healing trim fault met by a fresh append, not only a parked one", async () => {
    // 687913b keeps an already-parked append waiting through a transient trim
    // fault. An append that arrives while the fault is parked meets it at
    // assertReady() instead of in the capacity wait, and used to reject the
    // flush with the retryable trim error there -- it must wait it out too.
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxBytes: 66,
      maxSegmentBytes: 1,
      backpressurePolicy: QWP_SF_BACKPRESSURE_POLICY.WAIT,
      appendDeadlineMs: 5_000,
    });
    await store.load();
    await store.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
    await store.append({ frameSequence: 1n, payload: Uint8Array.of(2) });

    // Fail the next trim once, then acknowledge to drive it: the maintenance
    // failure is parked and a retry is scheduled ~1 s later with the real
    // unlink. No append is waiting yet, so nothing is parked in the capacity
    // queue.
    const unlink = vi
      .spyOn(qwpSegmentMaintenanceWorker, "unlink")
      .mockRejectedValueOnce(
        Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        }),
      );
    await store.acknowledgeThrough(0n);
    await vi.waitFor(() => expect(unlink).toHaveBeenCalled());

    // Issued only now, the append meets the parked failure at assertReady().
    // It must still resolve when the retry frees space, never reaching its
    // deadline nor surfacing the retryable trim error.
    const fresh = store.append({
      frameSequence: 2n,
      payload: Uint8Array.of(3),
    });
    await expect(fresh).resolves.toBeUndefined();
    expect(store.metrics).toMatchObject({
      waitingAppends: 0,
      totalAppendTimeouts: 0,
    });

    unlink.mockRestore();
    await store.close();
  }, 15_000);

  it("waits for ACK trimming without blocking the acknowledgement queue", async () => {
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxBytes: 66,
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
      maxBytes: 66,
      maxSegmentBytes: 1,
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
      maxBytes: 66,
      requiredBytes: 99,
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
      maxBytes: 32,
      maxSegmentBytes: 1,
    });
    await first.load();
    // Header + block metadata + this entry exceed the configured target.
    // Unlike frame bytes, this prefix never shrinks.
    await first.appendSymbolDictionary(0, ["abcdefghijklmnopqrstuvwxyz1234"]);
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
      maxBytes: 32,
      maxSegmentBytes: 1,
    });
    await expect(recovered.load()).resolves.toEqual([
      { frameSequence: 1n, payload: Uint8Array.of(2) },
    ]);
    await expect(recovered.loadSymbolDictionary()).resolves.toEqual([
      "abcdefghijklmnopqrstuvwxyz1234",
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
    const [record] = await assignedReplaySegments(directory);
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

async function assignedReplaySegments(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith(".sfa"));
}

/**
 * Offset of `payload` inside a segment file, or -1 once repair has zeroed it
 * away. Distinguishes records still on disk from records the tail repair
 * removed, which the recovered frame list alone cannot show.
 */
async function payloadOffsetIn(
  segmentPath: string,
  payload: Uint8Array,
): Promise<number> {
  return (await readFile(segmentPath)).indexOf(Buffer.from(payload));
}
