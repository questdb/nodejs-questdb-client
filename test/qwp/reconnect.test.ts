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
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flock } from "fs-ext-extra-prebuilt";
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
  QwpReplayStoreUnavailableError,
  type QwpNodeReplayDataLossReport,
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
} from "../../src/qwp";
import { QwpAsyncQueue } from "../../src/_qwp/_internal/async-queue";
import { qwpSegmentMaintenanceWorker } from "../../src/qwp-node/segment-maintenance-worker";
import { createQwpEgressFailoverConnectionFactory } from "../../src/_qwp/_internal/egress-routing";
import {
  createQwpFailoverConnectionFactory,
  createQwpFailoverHealthTracker,
} from "../../src/_qwp/_internal/failover";

function nativeFlock(fd: number, operation: "exnb" | "un"): Promise<void> {
  return new Promise((resolve, reject) => {
    flock(fd, operation, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

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

  it("preserves durable-ACK mismatch priority across a mixed endpoint sweep", async () => {
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
    ).rejects.toBeInstanceOf(QwpDurableAckUnavailableError);
    expect(factoryCalls).toBe(1);
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
      const publishing = session.publishFrame(payload);
      connection.receive(ingressResponse(QWP_STATUS.OK, BigInt(index)));
      await publishing;
    }

    // Retaining the acknowledged prefix pinned every payload for the life of
    // the connection and made each ACK scan it three times over.
    expect(wireLog().length).toBeLessThanOrEqual(2);
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
    const session = await QwpIngressSession.connect(async () => connection, {
      reconnect: { maxAttempts: 1 },
      replayStore: new QwpNodeFileReplayStore({ directory }),
    });
    expect(connection.sent).toEqual([]);
    await vi.waitFor(async () =>
      expect(await assignedReplaySegments(directory)).toEqual([]),
    );
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
      await recovered.close();
    },
  );

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

  it("fails closed when the native locking module cannot be loaded", async () => {
    const directory = await trackedDirectory();
    vi.resetModules();
    // Reproduces the module-scope throw the optional dependency raises when no
    // prebuilt binding matches the platform, and MODULE_NOT_FOUND when an
    // install omitted it.
    vi.doMock("fs-ext-extra-prebuilt", () => {
      throw new Error("Failed to load fs-ext native module.");
    });
    try {
      const { QwpNodeFileReplayStore: UnavailableStore } = await import(
        "../../src/qwp-node/file-replay-store"
      );
      const store = new UnavailableStore({ directory });
      await expect(store.load()).rejects.toMatchObject({
        name: "QwpReplayStoreUnavailableError",
        directory,
      } satisfies Partial<QwpReplayStoreUnavailableError>);
      // The binding resolves before the lock file is opened, so a slot that
      // cannot be owned is never given Java-visible lock metadata.
      await expect(readdir(directory)).resolves.toEqual([]);
    } finally {
      vi.doUnmock("fs-ext-extra-prebuilt");
      vi.resetModules();
    }
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

  it("contends with a Java-compatible native advisory lock", async () => {
    const directory = await trackedDirectory();
    const lockPath = join(directory, ".lock");
    const lockHandle = await open(lockPath, "a+");
    await nativeFlock(lockHandle.fd, "exnb");
    await writeFile(join(directory, ".lock.pid"), "4242\n");

    const store = new QwpNodeFileReplayStore({ directory });
    await expect(store.load()).rejects.toMatchObject({
      name: "QwpReplayStoreLockedError",
      directory,
      holderPid: 4242,
    } satisfies Partial<QwpReplayStoreLockedError>);

    await nativeFlock(lockHandle.fd, "un");
    await lockHandle.close();
    await expect(store.load()).resolves.toEqual([]);
    expect(await readFile(join(directory, ".lock.pid"), "utf8")).toBe(
      `${process.pid}\n`,
    );
    await store.close();
  });

  it("contends with Java's parent-anchored logical slot lock", async () => {
    const rootDirectory = await trackedDirectory();
    const directory = join(rootDirectory, "sender-0");
    const logicalLockDirectory = join(rootDirectory, ".slot-locks");
    await mkdir(directory);
    await mkdir(logicalLockDirectory);
    const lockPath = join(logicalLockDirectory, "sender-0.lock");
    const lockHandle = await open(lockPath, "a+");
    await nativeFlock(lockHandle.fd, "exnb");
    await writeFile(join(logicalLockDirectory, "sender-0.lock.pid"), "9090\n");

    const store = new QwpNodeFileReplayStore({ directory });
    await expect(store.load()).rejects.toMatchObject({
      name: "QwpReplayStoreLockedError",
      directory,
      holderPid: 9090,
    } satisfies Partial<QwpReplayStoreLockedError>);

    await nativeFlock(lockHandle.fd, "un");
    await lockHandle.close();
    await expect(store.load()).resolves.toEqual([]);
    await store.close();
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
    await expectOnlyJavaSlotLockMetadata(directory);
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
      maxBytes: 66,
      maxSegmentBytes: 1,
      durability: QWP_SF_DURABILITY.PERIODIC,
      checkpointIntervalMs: 250,
      backpressurePolicy: QWP_SF_BACKPRESSURE_POLICY.WAIT,
      appendDeadlineMs: 2_000,
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
    const lockHandle = await open(join(directory, ".lock"), "r+");
    await nativeFlock(lockHandle.fd, "exnb");
    await nativeFlock(lockHandle.fd, "un");
    await lockHandle.close();
  });

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
