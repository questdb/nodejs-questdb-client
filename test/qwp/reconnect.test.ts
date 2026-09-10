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
import { basename, join } from "node:path";
import { Worker } from "node:worker_threads";
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
  QWP_FLAG_DEFER_COMMIT,
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
  QwpIngressAckAbandonedError,
  QwpIngressSessionClosedError,
  QwpIngressReplayRecord,
  QwpIngressReplayReference,
  QwpIngressReplayStore,
  QwpHandshakeMetadata,
  QwpMemoryReplayAppendTimeoutError,
  QwpMemoryReplayBatchTooLargeError,
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
import { quarantineQwpNodeReplayStore } from "../../packages/nodejs-client/src/qwp-node/file-replay-store";
import { QwpAsyncQueue } from "../../packages/client-core/src/_qwp/_internal/async-queue";
import { QwpReconnectingIngressConnection } from "../../packages/client-core/src/_qwp/_internal/reconnecting-ingress-connection";
import { validateQwpWebSocketTimeouts } from "../../packages/client-core/src/_qwp/_internal/websocket-connection";
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

function resultEnd(
  requestId = 0n,
  finalSequence = 0n,
  totalRows = 0n,
): Uint8Array {
  const payload = new QwpByteWriter()
    .writeUint8(QWP_EGRESS_MESSAGE.RESULT_END)
    .writeBigUint64(requestId);
  writeQwpVarint(payload, finalSequence);
  writeQwpVarint(payload, totalRows);
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

  it("rotates after a preferred endpoint closes cleanly before its ACK", async () => {
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
    // Invoke the underlying connection directly to model a peer-initiated
    // clean WebSocket closing handshake rather than an owner-requested close.
    await primary.close(1000, "server restart");
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
  it("yields the event loop between zero-backoff reconnect attempts", async () => {
    // The backoff wait is the reconnect loop's only macrotask, and it used to
    // sit behind `backoffMs > 0`. With initialBackoffMs 0 -- a value this
    // suite passes everywhere and validateReconnectPolicy accepts -- a factory
    // that rejects without an I/O turn then spun the loop in microtasks and
    // starved timers, I/O and close() for as long as connecting kept failing.
    // A caller-supplied webSocketFactory produces that shape, and so does a
    // browser WebSocket constructor throwing SecurityError on mixed content.
    // Counts macrotask turns. A self-rescheduling zero-delay timer interleaves
    // with the loop's own backoff timer, so it advances once per retry when
    // the loop yields and not at all while it spins.
    let turns = 0;
    let pumping = true;
    const pump = (): void => {
      if (!pumping) return;
      turns++;
      setTimeout(pump, 0);
    };
    setTimeout(pump, 0);

    const connections: FakeConnection[] = [];
    const turnsPerRefusal: number[] = [];
    const session = await QwpIngressSession.connect(
      async () => {
        if (connections.length > 0 && turnsPerRefusal.length < 10) {
          turnsPerRefusal.push(turns);
          // Rejects in a microtask, exactly like a constructor that throws.
          throw new Error("connect refused");
        }
        const connection = new FakeConnection("primary");
        connections.push(connection);
        return connection;
      },
      {
        backgroundStoreAndForward: true,
        memoryReplayMaxBytes: 1024 * 1024,
        reconnect: { maxAttempts: 0, initialBackoffMs: 0, maxBackoffMs: 0 },
      },
    );

    try {
      connections[0].drop();
      await vi.waitFor(() => expect(connections).toHaveLength(2));
      expect(turnsPerRefusal).toHaveLength(10);
      // No two attempts share a macrotask turn. Every refusal used to land in
      // the same one, because the loop never returned to the event loop.
      expect(new Set(turnsPerRefusal).size).toBe(turnsPerRefusal.length);
    } finally {
      pumping = false;
      await session.close();
    }
  });

  it("keeps publish cost off the pending-replay backlog", async () => {
    // getIngressMetrics() summed every pending frame, and the flush path read
    // it several times per frame -- once per publish through emitProgress even
    // with no observer, and again per publishedFrameSequence read. That made a
    // publish O(backlog) and an outage O(n^2). Nothing here may scale with the
    // number of frames already waiting.
    const connection = new FakeConnection("primary");
    const snapshots = vi.spyOn(
      QwpReconnectingIngressConnection.prototype,
      "getIngressMetrics",
    );
    const session = await QwpIngressSession.connect(async () => connection, {
      memoryReplayMaxBytes: 1024 * 1024,
    });

    // FakeConnection answers nothing unless told to, so every frame stays
    // pending and the backlog grows across the publishes below.
    const payload = Uint8Array.of(1, 2, 3, 4);
    snapshots.mockClear();
    for (let i = 0; i < 64; i++) await session.publishFrame(payload);

    // No onProgress observer is configured, so publishing must not build a
    // snapshot at all. It used to build one per frame, each scanning the whole
    // backlog, because `metrics` was an argument evaluated before the
    // dispatcher could early-return.
    expect(snapshots).not.toHaveBeenCalled();

    // The incrementally maintained counter still reports what the scan did.
    expect(session.metrics).toMatchObject({
      pendingReplayFrames: 64,
      pendingReplayBytes: 64 * payload.byteLength,
    });

    snapshots.mockRestore();
    await session.close();
  });

  it("keeps sender flushes off the pending-replay backlog", async () => {
    // flushNow() reads publishedFrameSequence several times per flush. That
    // getter went through getIngressMetrics(), so each read froze a 25-field
    // snapshot after scanning every pending frame.
    const connection = new FakeConnection("primary");
    const snapshots = vi.spyOn(
      QwpReconnectingIngressConnection.prototype,
      "getIngressMetrics",
    );
    const session = await QwpIngressSession.connect(async () => connection, {
      memoryReplayMaxBytes: 1024 * 1024,
    });
    const sender = new QwpSender(async () => session, {
      autoFlush: false,
      // The fake endpoint never acknowledges, so close() must not sit out its
      // full drain budget waiting for ACKs this test deliberately withholds.
      closeFlushTimeoutMs: 10,
    });

    snapshots.mockClear();
    for (let i = 0; i < 32; i++) {
      await sender.table("events").longColumn("value", BigInt(i)).atNow();
      await sender.flush();
    }
    expect(connection.sent.length).toBeGreaterThan(0);
    expect(snapshots).not.toHaveBeenCalled();

    snapshots.mockRestore();
    await sender.close().catch(() => undefined);
    await session.close();
  });

  it("counts pending replay bytes down again as ACKs arrive", async () => {
    const connection = new FakeConnection("primary");
    const session = await QwpIngressSession.connect(async () => connection, {
      memoryReplayMaxBytes: 1024 * 1024,
    });

    const payload = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
    for (let i = 0; i < 5; i++) await session.publishFrame(payload);
    expect(session.metrics).toMatchObject({
      pendingReplayFrames: 5,
      pendingReplayBytes: 5 * payload.byteLength,
    });

    // ACKs are cumulative: acknowledging frame 2 retires the first three.
    connection.receive(ingressResponse(QWP_STATUS.OK, 2n));
    await vi.waitFor(() => expect(session.metrics.pendingReplayFrames).toBe(2));
    // A drained prefix must debit the counter, not leave a residue that the
    // old full scan would have recomputed away.
    expect(session.metrics.pendingReplayBytes).toBe(2 * payload.byteLength);

    connection.receive(ingressResponse(QWP_STATUS.OK, 4n));
    await vi.waitFor(() => expect(session.metrics.pendingReplayFrames).toBe(0));
    expect(session.metrics.pendingReplayBytes).toBe(0);

    await session.close();
  });

  it("waits for a late reconnect candidate before close resolves", async () => {
    const first = new FakeConnection("primary");
    const late = new FakeConnection("secondary");
    let factoryCalls = 0;
    let releaseLate!: () => void;
    const session = await QwpIngressSession.connect(
      async () => {
        factoryCalls++;
        if (factoryCalls === 1) return first;
        return new Promise<QwpBinaryConnection>((resolve) => {
          releaseLate = () => resolve(late);
        });
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
    await vi.waitFor(() => expect(factoryCalls).toBe(2));
    let closeResolved = false;
    const closing = session.close().then(() => {
      closeResolved = true;
    });
    await Promise.resolve();
    expect(closeResolved).toBe(false);

    releaseLate();
    await closing;
    await expect(late.closed).resolves.toMatchObject({ code: 1000 });
  });

  it("enforces the total reconnect deadline during an in-flight connect", async () => {
    let attemptSignal: AbortSignal | undefined;
    const startedAt = Date.now();
    const connecting = QwpIngressSession.connect(
      (signal) => {
        attemptSignal = signal;
        return new Promise<QwpBinaryConnection>(() => undefined);
      },
      {
        reconnect: {
          maxAttempts: 0,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
          maxDurationMs: 25,
        },
      },
    );

    await expect(connecting).rejects.toBeInstanceOf(QwpReconnectExhaustedError);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(attemptSignal?.aborted).toBe(true);
  });

  it("reports the last attempt failure when the reconnect deadline expires", async () => {
    // awaitReconnectDeadline() cannot see the attempt failures, so it builds a
    // synthetic "deadline elapsed" cause. That error escapes connectLoop from
    // the backoff waits, which sit outside its try, and from the verbatim
    // rethrow inside it -- both bypassing the exhaustion branch that already
    // carries lastError. An expired duration budget therefore named nothing,
    // while an exhausted attempt budget named the real failure. Ingress
    // defaults to unlimited attempts, so duration is the only exhaustion most
    // senders can reach.
    const attemptFailure = new Error("upgrade refused by the endpoint");
    const connecting = QwpIngressSession.connect(
      () => Promise.reject(attemptFailure),
      {
        reconnect: {
          maxAttempts: 0,
          initialBackoffMs: 1,
          maxBackoffMs: 1,
          maxDurationMs: 25,
        },
        initialConnectMode: "sync",
      },
    );

    const error = await connecting.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(QwpReconnectExhaustedError);
    expect((error as QwpReconnectExhaustedError).cause).toBe(attemptFailure);
  });

  it("disowns the eager first connect when the attempt is aborted", async () => {
    // connect() starts the first transport eagerly and nothing observes that
    // promise until connectLoop's first attempt awaits it. An abort leaves
    // before then, so the cleanup has to disown it on every such path -- not
    // only when the reconnecting connection was never constructed. Without
    // that the promise floated: a transport that opened anyway was never
    // closed, and a failing one surfaced as an unhandled rejection, which
    // Node turns into process exit by default, *after* the caller had already
    // handled the rejection connect() itself returned.
    const controller = new AbortController();
    controller.abort();

    // A factory that ignores the signal and opens anyway must still be closed.
    const opened = new FakeConnection("primary");
    await expect(
      QwpIngressSession.connect(async () => opened, {}, controller.signal),
    ).rejects.toThrow();
    await expect(
      Promise.race([
        opened.closed.then(() => "closed"),
        new Promise((resolve) => setTimeout(() => resolve("leaked"), 1_000)),
      ]),
    ).resolves.toBe("closed");

    // A factory that fails must leave no unhandled rejection behind it.
    const unhandled: unknown[] = [];
    const observe = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observe);
    try {
      await expect(
        QwpIngressSession.connect(
          async () => {
            throw new Error("first connect failed");
          },
          {},
          controller.signal,
        ),
      ).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("unhandledRejection", observe);
    }
    expect(unhandled).toEqual([]);
  });

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

  it("admits a transaction commit when its deferred prefix fills memory replay", async () => {
    // QuestDB intentionally sends no ACK for the auto-flushed deferred frame.
    // With a strict per-append cap, the tiny group-closing frame then waited
    // for an ACK that could only be produced after that same frame was sent.
    const connection = new FakeConnection("primary");
    const session = await QwpIngressSession.connect(async () => connection, {
      memoryReplayMaxBytes: 110,
      memoryReplayAppendDeadlineMs: 50,
    });
    const sender = new QwpSender(async () => session, {
      autoFlushRows: 1,
      autoFlushIntervalMs: 0,
      transactional: true,
      awaitServerAck: true,
    });

    await sender.table("events").longColumn("value", 42n).atNow();
    expect(connection.sent).toHaveLength(1);
    expect(connection.sent[0][5] & QWP_FLAG_DEFER_COMMIT).toBe(
      QWP_FLAG_DEFER_COMMIT,
    );
    expect(session.metrics.memoryReplayUsedBytes).toBeLessThanOrEqual(110);

    const committing = sender.commit();
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2));
    expect(connection.sent[1][5] & QWP_FLAG_DEFER_COMMIT).toBe(0);
    expect(session.metrics.memoryReplayUsedBytes).toBeGreaterThan(110);
    connection.receive(ingressResponse(QWP_STATUS.OK, 1n, [["events", 1n]]));

    await expect(committing).resolves.toBe(true);
    await vi.waitFor(() =>
      expect(session.metrics.memoryReplayUsedBytes).toBe(0),
    );
    expect(sender.metrics.totalTransactionsCommitted).toBe(1);
    await sender.close();
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

  it("retries an initial per-endpoint upgrade rejection instead of latching", async () => {
    // The sibling of the case above, and the line between them is whether the
    // whole cluster would repeat the rejection. A 404 is the one node mid-
    // deploy returns while its peers are healthy -- the connector says so by
    // setting tryNextEndpoint -- so it must not end a producer whose connect()
    // has already resolved and whose first flush() has already been accepted.
    // It used to: the retry-forever exemption was gated on having connected
    // once, so attempt 1 went terminal and, under the documented lazy_connect
    // default of memory replay, took the buffered frames with it.
    const replayStore = new TrackingReplayStore();
    let factoryCalls = 0;
    const session = await QwpIngressSession.connect(
      async () => {
        factoryCalls++;
        throw new QwpUpgradeError("not found", {
          kind: QWP_UPGRADE_ERROR_KIND.HTTP_REJECTED,
          statusCode: 404,
          retryable: false,
          tryNextEndpoint: true,
        });
      },
      {
        backgroundStoreAndForward: true,
        initialConnectMode: "async",
        reconnect: {
          maxAttempts: 0,
          maxDurationMs: 0,
          initialBackoffMs: 1,
          maxBackoffMs: 1,
        },
        replayStore,
      },
    );
    await vi.waitFor(() => expect(factoryCalls).toBeGreaterThan(3));
    await session.close();
  });

  it("fails fast on a configuration fault instead of retrying it", async () => {
    // Option validation runs inside the per-attempt callback, so the reconnect
    // loop met a permanently invalid option exactly as it meets a refused
    // connection: the classifier retries anything carrying no `retryable`
    // flag, so this burned the whole budget -- five minutes on the shipped
    // ingress defaults, silently -- and then reported a generic exhaustion
    // whose cause named the deadline rather than the option.
    let factoryCalls = 0;
    await expect(
      QwpIngressSession.connect(
        async () => {
          factoryCalls++;
          validateQwpWebSocketTimeouts({ connectTimeoutMs: 0 });
          throw new Error("validation should have rejected this call");
        },
        {
          initialConnectMode: "sync",
          reconnect: {
            maxAttempts: 0,
            maxDurationMs: 2_000,
            initialBackoffMs: 1,
            maxBackoffMs: 1,
          },
        },
      ),
    ).rejects.toThrow(/connectTimeoutMs must be a positive finite number/);
    expect(factoryCalls).toBe(1);
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

  it("strips endpoint credentials from events handed to onEvent", async () => {
    // QwpUpgradeError and QwpFailoverError scrub the identical endpoint, and
    // test/qwp/session.test.ts pins that. The reconnect events did not, and
    // the documented use of onEvent is to log the whole event -- so a
    // credential-bearing endpoint, which the browser entry point accepts and
    // which any custom connection factory can supply on either runtime,
    // reached the console and whatever telemetry follows it.
    const credentialed = "wss://alice:s3cr3t@questdb.example:9000/write/v4";
    const redacted = "wss://questdb.example:9000/write/v4";
    const events: QwpReconnectEvent[] = [];
    const connection = new FakeConnection(credentialed);
    const session = await QwpIngressSession.connect(async () => connection, {
      reconnect: {
        initialBackoffMs: 0,
        maxBackoffMs: 0,
        onEvent: (event) => events.push(event),
      },
    });
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    for (const event of events) {
      expect(JSON.stringify(event), event.kind).not.toContain("s3cr3t");
      if (event.endpoint !== undefined) {
        expect(event.endpoint, event.kind).toBe(redacted);
      }
    }
    await session.close();
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

  it("holds an orphan durable-ACK episode open for its whole window", async () => {
    // The attempt cap and the duration window are both required, exactly as
    // for a capability-gap episode. As alternatives the fixed 16-attempt cap
    // always won -- about 26s at the default backoff -- so the window could
    // never bind and a brief gap during a rolling restart quarantined an
    // orphan slot. The cap is not configurable, so it must not act alone.
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
        // 16 attempts at ~5ms each land well inside this window.
        orphanDurableAckMismatchMaxDurationMs: 400,
        reconnect: {
          initialBackoffMs: 0,
          maxBackoffMs: 0,
          onEvent: (event) => events.push(event),
        },
        replayStore: new TrackingReplayStore(),
      },
    );

    // Reaching the attempt cap alone must not escalate.
    await vi.waitFor(() => expect(factoryCalls).toBeGreaterThan(16));
    expect(
      events.some(
        (event) =>
          event.kind ===
          QWP_RECONNECT_EVENT_KIND.DURABLE_ACK_PERSISTENT_FAILURE,
      ),
    ).toBe(false);

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
    // Escalation waited for the window, so it took more than the cap's tries.
    expect(factoryCalls).toBeGreaterThan(16);
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

  it("preflights a split batch before publishing a deferred journal prefix", async () => {
    const directory = await createTemporaryDirectory();
    const connection = new FakeConnection("primary");
    const replayStore = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 128,
      // One fixed segment: 24-byte segment header, 8-byte record header,
      // and the configured 128-byte maximum frame payload.
      maxBytes: 160,
    });
    const session = await QwpIngressSession.connect(async () => connection, {
      backgroundStoreAndForward: true,
      reconnect: { maxAttempts: 1 },
      replayStore,
      maxBatchSizeBytes: 128,
    });
    const table = new QwpTableBuffer("t");
    for (const suffix of ["a", "b", "c"]) {
      table
        .getOrCreateColumn("value", QWP_COLUMN_TYPE.VARCHAR)!
        .values.push(suffix.repeat(60));
      table.nextRow();
    }

    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const sending = session.sendTablesWithPublication([table]);
        const acknowledgementError = sending.acknowledgement.catch(
          (error: unknown) => error,
        );
        await expect(sending.publication).rejects.toBeInstanceOf(
          QwpReplayStoreFullError,
        );
        expect(await acknowledgementError).toBeInstanceOf(
          QwpReplayStoreFullError,
        );
        expect(replayStore.metrics.pendingRecords).toBe(0);
        expect(connection.sent).toHaveLength(0);
      }
      const recovered = session.sendFrame(Uint8Array.of(7));
      await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
      connection.receive(ingressResponse(QWP_STATUS.OK, 0n));
      await expect(recovered).resolves.toMatchObject({ status: QWP_STATUS.OK });
      await vi.waitFor(() =>
        expect(replayStore.metrics.pendingRecords).toBe(0),
      );
    } finally {
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preflights split batches against the in-memory replay budget", async () => {
    const connection = new FakeConnection("primary");
    const session = await QwpIngressSession.connect(async () => connection, {
      backgroundStoreAndForward: true,
      reconnect: { maxAttempts: 1 },
      memoryReplayMaxBytes: 200,
      maxBatchSizeBytes: 128,
    });
    const table = new QwpTableBuffer("t");
    for (const suffix of ["a", "b", "c"]) {
      table
        .getOrCreateColumn("value", QWP_COLUMN_TYPE.VARCHAR)!
        .values.push(suffix.repeat(60));
      table.nextRow();
    }

    try {
      await expect(session.publishTables([table])).rejects.toBeInstanceOf(
        QwpMemoryReplayBatchTooLargeError,
      );
      expect(session.metrics.pendingReplayFrames).toBe(0);
      expect(connection.sent).toHaveLength(0);
      const recovered = session.sendFrame(Uint8Array.of(7));
      await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
      connection.receive(ingressResponse(QWP_STATUS.OK, 0n));
      await expect(recovered).resolves.toMatchObject({ status: QWP_STATUS.OK });
    } finally {
      await session.close();
    }
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

  it("deprioritizes a healthy endpoint below the recovered frame cap", async () => {
    const payload = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
    const store = new TrackingReplayStore();
    store.records.set(0n, payload);
    const attempted: string[] = [];
    const smallConnections: FakeConnection[] = [];
    const largeConnections: FakeConnection[] = [];
    const factory = createQwpFailoverConnectionFactory(
      "small-cap",
      ["large-cap"],
      async (endpoint) => {
        attempted.push(String(endpoint));
        const connection = new FakeConnection(String(endpoint), {
          qwpVersion: 1,
          maxBatchSizeBytes: endpoint === "small-cap" ? 4 : 64,
        });
        if (endpoint === "small-cap") smallConnections.push(connection);
        else largeConnections.push(connection);
        return connection;
      },
    );

    const session = await QwpIngressSession.connect(factory, {
      replayStore: store,
      ackTimeoutMs: 1_000,
      reconnect: { maxAttempts: 2, initialBackoffMs: 0, maxBackoffMs: 0 },
    });

    expect(attempted).toEqual(["small-cap", "large-cap"]);
    expect(smallConnections).toHaveLength(1);
    expect(smallConnections[0].sent).toHaveLength(0);
    expect(largeConnections).toHaveLength(1);
    expect(largeConnections[0].sent).toEqual([payload]);
    largeConnections[0].receive(ingressResponse(QWP_STATUS.OK, 0n));
    await session.close();
  });

  it("deprioritizes an endpoint whose cap cannot fit dictionary catch-up", async () => {
    // The sibling test above covers a *data* frame that a small-cap endpoint
    // refuses. The dictionary catch-up path threw without deprioritizing, so
    // the endpoint stayed HEALTHY -- its connect had succeeded -- and outranked
    // the untried larger-cap node on every later sweep. Measured before the
    // fix: 301 reconnect attempts, all to the small-cap node, zero rotations.
    const symbol = "S".repeat(200);
    const attempted: string[] = [];
    const large: FakeConnection[] = [];
    let seed!: FakeConnection;
    const factory = createQwpFailoverConnectionFactory(
      "seed",
      ["small-cap", "large-cap"],
      async (endpoint) => {
        attempted.push(String(endpoint));
        if (endpoint === "seed") {
          seed = new FakeConnection("seed");
          return seed;
        }
        const connection = new FakeConnection(String(endpoint), {
          qwpVersion: 1,
          // 64 bytes cannot hold the 200-byte entry's catch-up frame; 4096 can.
          maxBatchSizeBytes: endpoint === "small-cap" ? 64 : 4096,
        });
        if (endpoint === "large-cap") large.push(connection);
        return connection;
      },
    );

    const session = await QwpIngressSession.connect(factory, {
      ackTimeoutMs: 1_000,
      reconnect: { maxAttempts: 4, initialBackoffMs: 0, maxBackoffMs: 0 },
    });

    const pending = session.sendTablesDelta([symbolTable(symbol)]);
    await vi.waitFor(() => expect(seed.sent).toHaveLength(1));
    seed.receive(ingressResponse(QWP_STATUS.OK, 0n));
    await pending;

    seed.drop();

    // The large-cap endpoint is reached, and it receives the catch-up frame
    // the small-cap one could not take.
    await vi.waitFor(() => expect(large).toHaveLength(1));
    await vi.waitFor(() => expect(large[0].sent.length).toBeGreaterThan(0));
    expect(attempted).toContain("small-cap");
    expect(decodeQwpIngressSymbolDictionaryDelta(large[0].sent[0])).toEqual({
      startId: 0,
      entries: [symbol],
    });
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

  it("does not charge an open transaction's deferred frame for a non-orderly close", async () => {
    // The close path infers suspicion from a frame still sitting past the ACK
    // watermark when the connection died, so it may only consider frames the
    // server was expected to answer. A deferred frame is not one: QuestDB
    // withholds its cumulative OK for the life of the open transaction, so no
    // ACK can ever clear the episode while the transaction is open and every
    // drop stacked another strike. Four ordinary transport drops during one
    // transaction therefore latched a running sender terminal.
    //
    // The test directly above is the control: an ordinary frame under exactly
    // the same drops is still condemned at maxFrameRejections.
    const handedOut: FakeConnection[] = [];
    const session = await QwpIngressSession.connect(
      async () => {
        const connection = new FakeConnection(`deferred-${handedOut.length}`);
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

    const pending = session.sendFrame(
      encodeQwpFrame(Uint8Array.of(1), QWP_FLAG_DEFER_COMMIT, 0),
    );
    const dropNext = async (index: number) => {
      await vi.waitFor(() => {
        expect(handedOut).toHaveLength(index + 1);
        expect(handedOut[index].sent).toHaveLength(1);
      });
      handedOut[index].drop();
    };
    // Two more drops than maxFrameRejections allows for a chargeable frame.
    await dropNext(0);
    await dropNext(1);
    await dropNext(2);

    // Still replaying rather than condemned, and the frame completes as soon
    // as the transaction's commit-bearing ACK arrives.
    await vi.waitFor(() => {
      expect(handedOut).toHaveLength(4);
      expect(handedOut[3].sent).toHaveLength(1);
    });
    handedOut[3].receive(ingressResponse(QWP_STATUS.OK, 0n));
    await expect(pending).resolves.toMatchObject({
      status: QWP_STATUS.OK,
      sequence: 0n,
    });
    await session.close();
  });

  it("tunes the ingress reconnect defaults instead of replacing them", async () => {
    // A partial reconnect object used to replace the session's default policy
    // wholesale, leaving the connection's own per-field fallbacks to supply
    // maxAttempts 3 and maxDurationMs 30s in place of the unlimited/5-minute
    // policy. Setting one documented key -- `reconnect_max_duration_millis` is
    // presented as the ws/wss replacement for ILP's `retry_timeout` -- therefore
    // capped a running sender at three sweeps and latched it terminal during a
    // transient outage, with no connect-string key able to restore the default.
    const primary = new FakeConnection("primary");
    const replacement = new FakeConnection("replacement");
    let factoryCalls = 0;
    const session = await QwpIngressSession.connect(
      async () => {
        factoryCalls++;
        if (factoryCalls === 1) return primary;
        if (factoryCalls <= 6) {
          throw new QwpUpgradeError("offline", {
            kind: QWP_UPGRADE_ERROR_KIND.TRANSPORT,
            retryable: true,
            tryNextEndpoint: true,
          });
        }
        return replacement;
      },
      {
        // Deliberately partial: neither maxAttempts nor maxDurationMs is set,
        // so both must still come from the session defaults.
        reconnect: {
          initialBackoffMs: 0,
          maxBackoffMs: 0,
          poisonMinEscalationWindowMs: 600_000,
        },
      },
    );

    const pending = session.sendFrame(Uint8Array.of(9));
    await vi.waitFor(() => expect(primary.sent).toHaveLength(1));
    primary.drop();

    // Five failed sweeps is past the fallback ceiling of three; unlimited
    // attempts means the sixth still reconnects and the frame is delivered.
    await vi.waitFor(() => expect(replacement.sent).toEqual(primary.sent));
    expect(factoryCalls).toBe(7);
    replacement.receive(ingressResponse(QWP_STATUS.OK, 0n));
    await expect(pending).resolves.toMatchObject({
      status: QWP_STATUS.OK,
      sequence: 0n,
    });
    await session.close();
  });

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
    // toward it, or an outage alone would satisfy the dwell. Real elapsed
    // time, because the window is measured on the monotonic clock: a faked
    // system clock would move neither side of the comparison and prove
    // nothing about the banking.
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
          // Hold the outage open past the dwell window. Banked as outage, it
          // leaves the connected dwell far below it; counted as dwell, the
          // second strike below escalates and the frame fails.
          await new Promise((resolve) => setTimeout(resolve, 450));
          return second;
        }
        return healthy;
      },
      {
        reconnect: {
          maxAttempts: 5,
          maxDurationMs: 0,
          maxFrameRejections: 2,
          poisonMinEscalationWindowMs: 300,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    );
    const pending = session.sendFrame(Uint8Array.of(9));
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    first.drop();
    await vi.waitFor(() => expect(second.sent).toHaveLength(1), {
      timeout: 5_000,
    });
    second.drop();
    await vi.waitFor(() => expect(healthy.sent).toHaveLength(1));
    healthy.receive(ingressResponse(QWP_STATUS.OK, 0n));

    await expect(pending).resolves.toMatchObject({
      status: QWP_STATUS.OK,
      sequence: 0n,
    });
    await session.close();
  }, 15_000);

  it("does not let a system-clock step satisfy the poison escalation window", async () => {
    // The dwell is elapsed time, not a point in time, so an NTP correction or
    // a VM/container resume must not satisfy it. Measured on Date.now() it
    // did: one forward step collapsed the five-minute guard to zero and turned
    // a burst of retriable rejections -- exactly what the window exists to
    // ride out -- into a terminal verdict, which fails a running sender or
    // quarantines an adopted orphan slot with its rows reported lost.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
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
            maxDurationMs: 0,
            maxFrameRejections: 2,
            poisonMinEscalationWindowMs: 300_000,
            initialBackoffMs: 0,
            maxBackoffMs: 0,
          },
        },
      );
      const pending = session.sendFrame(Uint8Array.of(9));
      await vi.waitFor(() => expect(first.sent).toHaveLength(1));
      first.receive(ingressResponse(QWP_STATUS.WRITE_ERROR, 0n));

      await vi.waitFor(() => expect(second.sent).toHaveLength(1));
      // The step lands while connected, which is the half outage banking
      // cannot absorb: measured on the wall clock, the next strike escalates.
      vi.setSystemTime(Date.now() + 6 * 60_000);
      second.receive(ingressResponse(QWP_STATUS.WRITE_ERROR, 0n));
      await vi.waitFor(() => expect(third.sent).toHaveLength(1));
      third.receive(ingressResponse(QWP_STATUS.OK, 0n));

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

  it("does not reuse completed durability across table incarnations", async () => {
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

    const oldSend = session.sendFrame(Uint8Array.of(1));
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
    connection.receive(ingressResponse(QWP_STATUS.OK, 0n, [["trades", 100n]]));
    const oldAck = await oldSend;
    connection.receive(durableResponse([["trades", 100n]]));
    await session.waitForDurable(oldAck);
    await vi.waitFor(() => expect(replayStore.records.size).toBe(0));

    const recreatedSend = session.sendFrame(Uint8Array.of(2));
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2));
    connection.receive(ingressResponse(QWP_STATUS.OK, 1n, [["trades", 1n]]));
    const recreatedAck = await recreatedSend;
    expect(Array.from(replayStore.records.keys())).toEqual([1n]);

    let durable = false;
    const waiting = session.waitForDurable(recreatedAck).then(() => {
      durable = true;
    });
    await Promise.resolve();
    expect(durable).toBe(false);
    expect(Array.from(replayStore.records.keys())).toEqual([1n]);

    connection.receive(durableResponse([["trades", 1n]]));
    await waiting;
    await vi.waitFor(() => expect(replayStore.records.size).toBe(0));
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
      replayAcknowledgedFrameSequence: 4n,
      pendingReplayFrames: 0,
      totalFramesReplayed: 0,
    });
    await expect(session.waitForAcknowledged(7n, 1_000)).rejects.toMatchObject({
      name: "QwpIngressAckAbandonedError",
      targetSequence: 7n,
      fromFsn: 5n,
      toFsn: 7n,
    } satisfies Partial<QwpIngressAckAbandonedError>);
    expect(await readdir(directory)).not.toContain(".ack-watermark");

    const currentFrame = encodeQwpIngressFrame([symbolTable("SOL-USD")]);
    const current = session.sendFrame(currentFrame);
    await vi.waitFor(() => expect(connection.sent).toEqual([currentFrame]));
    connection.receive(ingressResponse(QWP_STATUS.OK, 0n));
    await expect(current).resolves.toMatchObject({ sequence: 0n });
    await expect(
      session.waitForAcknowledged(8n, 1_000),
    ).resolves.toBeUndefined();
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
      replayAcknowledgedFrameSequence: 5n,
      pendingReplayFrames: 0,
      totalFramesReplayed: 1,
    });
    expect(session.publishedFrameSequence).toBe(7n);
    await vi.waitFor(() => expect(session.acknowledgedFrameSequence).toBe(5n));
    await expect(session.waitForAcknowledged(6n, 1_000)).rejects.toBeInstanceOf(
      QwpIngressAckAbandonedError,
    );

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
    await expect(
      session.waitForAcknowledged(8n, 1_000),
    ).resolves.toBeUndefined();
    await session.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("does not resurrect a retired deferred tail on the next process start", async () => {
    // The two tests above retire the tail while `records` is already empty, so
    // the segment is unlinked and removeAcknowledgedThrough() runs -- which
    // hides the actual durability question. Publishing one frame *before* the
    // ACK keeps a live record in that segment, so nothing unlinks it, and the
    // retired tail's bytes stay on disk. discardThrough() must therefore
    // persist the recovery watermark: without it the next process start
    // recovered frames this client had already reported abandoned through a
    // DATA_LOSS QwpSenderError, and re-sent them still flagged DEFER_COMMIT so
    // the following frame committed half a transaction the server had rolled
    // back.
    const directory = await createTemporaryDirectory();
    const committed = encodeQwpIngressFrame([symbolTable("ETH-USD")]);
    const firstDeferred = encodeQwpIngressFrame([symbolTable("BTC-USD")], {
      deferCommit: true,
    });
    const secondDeferred = encodeQwpIngressFrame([symbolTable("SOL-USD")], {
      deferCommit: true,
    });
    const seed = new QwpNodeFileReplayStore({ directory });
    await seed.load();
    await seed.append({ frameSequence: 5n, payload: committed });
    await seed.append({ frameSequence: 6n, payload: firstDeferred });
    await seed.append({ frameSequence: 7n, payload: secondDeferred });
    await seed.close();

    const connection = new FakeConnection("primary");
    const senderErrors: QwpSenderError[] = [];
    const session = await QwpIngressSession.connect(async () => connection, {
      reconnect: { maxAttempts: 1 },
      replayStore: new QwpNodeFileReplayStore({ directory }),
      onSenderError: (error) => senderErrors.push(error),
    });
    expect(connection.sent).toEqual([committed]);

    // Store-and-forward send() returns at the journal boundary, so a producer
    // reaches this point long before the recovered prefix is acknowledged.
    // Frame 8 is deliberately left unacknowledged: it is the live record that
    // keeps the tail's segment from being unlinked, which is the whole point.
    const currentFrame = encodeQwpIngressFrame([symbolTable("BTC-ETH")]);
    const current = session.sendFrame(currentFrame);
    const currentSettled = current.then(
      () => undefined,
      () => undefined,
    );
    await vi.waitFor(() =>
      expect(connection.sent).toEqual([committed, currentFrame]),
    );

    connection.receive(ingressResponse(QWP_STATUS.OK, 0n, [["trades", 42n]]));
    await vi.waitFor(() => expect(senderErrors).toHaveLength(1));
    expect(senderErrors[0]).toMatchObject({
      category: QWP_SENDER_ERROR_CATEGORY.DATA_LOSS,
      appliedPolicy: QWP_SENDER_ERROR_POLICY.ABANDONED,
    });
    await session.close();
    await currentSettled;

    const reopened = new QwpNodeFileReplayStore({ directory });
    const recovered = await reopened.load();
    await reopened.close();
    // Frame 8 is the only one still owed to the server. The abandoned tail was
    // reported lost, so it must not come back.
    expect(recovered.map((record) => record.frameSequence)).toEqual([8n]);
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
  it("delivers reconnect events off the reconnect stack", async () => {
    // The ingress connection routes reconnect.onEvent through a bounded
    // inbox; the egress one invoked it inline, so a user observer ran on the
    // reconnect stack and the time it spent was charged to the outage it was
    // reporting -- enough, against a tightened maxDurationMs, to exhaust the
    // budget and end a session that would otherwise have recovered.
    const first = new FakeConnection("primary");
    const second = new FakeConnection("primary");
    const connections = [first, second];
    const order: string[] = [];
    const session = await QwpEgressSession.connect(
      async () => {
        const connection = connections.shift();
        if (!connection) throw new Error("no connection available");
        order.push("factory");
        queueMicrotask(() => connection.receive(serverInfo("primary")));
        return connection;
      },
      {
        reconnect: {
          maxAttempts: 2,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
          onEvent: (event) => order.push(`event:${event.kind}`),
        },
      },
    );

    first.drop();
    await vi.waitFor(() =>
      expect(order.filter((entry) => entry === "factory")).toHaveLength(2),
    );
    await vi.waitFor(() =>
      expect(order.some((entry) => entry.startsWith("event:"))).toBe(true),
    );

    // Both connect attempts complete before the first observer call, which is
    // only possible when the events are queued rather than invoked inline --
    // inline, `reconnecting` is emitted before the second factory call.
    const firstEventAt = order.findIndex((entry) => entry.startsWith("event:"));
    expect(order.slice(0, firstEventAt)).toEqual(["factory", "factory"]);
    await session.close();
  });

  it("counts reconnect notifications the observer could not keep up with", async () => {
    // The inbox drops its oldest pending entry under overflow, and nothing
    // reported that. `attempt` resets to one on every success, so a delivered
    // stream that lost events reads exactly like a healthy one. Ingress has
    // published these counters all along; egress incremented them and exposed
    // no reader.
    const handed: FakeConnection[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const session = await QwpEgressSession.connect(
      async () => {
        const connection = new FakeConnection("primary");
        handed.push(connection);
        queueMicrotask(() => connection.receive(serverInfo("primary")));
        return connection;
      },
      {
        connectionListenerInboxCapacity: 1,
        reconnect: {
          maxAttempts: 8,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
          onEvent: async () => {
            entered++;
            await gate;
          },
        },
      },
    );

    expect(session.metrics).toEqual({
      deliveredConnectionNotifications: 0,
      droppedConnectionNotifications: 0,
    });

    // The first event occupies the gated observer; the rest queue into a
    // single slot, so each new one discards the entry before it.
    handed[handed.length - 1].drop();
    await vi.waitFor(() => expect(entered).toBe(1));
    await vi.waitFor(() => expect(handed.length).toBeGreaterThan(1));
    handed[handed.length - 1].drop();
    await vi.waitFor(() =>
      expect(session.metrics.droppedConnectionNotifications).toBeGreaterThan(0),
    );
    expect(session.metrics.deliveredConnectionNotifications).toBe(1);

    release();
    await session.close();
  });

  it("waits for a late reconnect candidate before close resolves", async () => {
    const first = new FakeConnection("primary");
    const late = new FakeConnection("secondary");
    let factoryCalls = 0;
    let releaseLate!: () => void;
    const session = await QwpEgressSession.connect(
      async () => {
        factoryCalls++;
        if (factoryCalls === 1) {
          queueMicrotask(() => first.receive(serverInfo("primary")));
          return first;
        }
        return new Promise<QwpBinaryConnection>((resolve) => {
          releaseLate = () => resolve(late);
        });
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
    await vi.waitFor(() => expect(factoryCalls).toBe(2));
    let closeResolved = false;
    const closing = session.close().then(() => {
      closeResolved = true;
    });
    await Promise.resolve();
    expect(closeResolved).toBe(false);

    releaseLate();
    await closing;
    await expect(late.closed).resolves.toMatchObject({ code: 1000 });
  });

  it("does not start another attempt when the deadline expires in backoff", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999);
    let factoryCalls = 0;
    try {
      await expect(
        QwpEgressSession.connect(
          async () => {
            factoryCalls++;
            throw new QwpUpgradeError("offline", {
              kind: QWP_UPGRADE_ERROR_KIND.TRANSPORT,
              retryable: true,
              tryNextEndpoint: true,
            });
          },
          {
            reconnect: {
              maxAttempts: 0,
              initialBackoffMs: 1_000,
              maxBackoffMs: 1_000,
              maxDurationMs: 25,
            },
          },
        ),
      ).rejects.toBeInstanceOf(QwpReconnectExhaustedError);
      expect(factoryCalls).toBe(1);
    } finally {
      random.mockRestore();
    }
  });

  it("enforces the total reconnect deadline while awaiting SERVER_INFO", async () => {
    const connection = new FakeConnection("primary");
    const startedAt = Date.now();
    const connecting = QwpEgressSession.connect(async () => connection, {
      serverInfoTimeoutMs: 5_000,
      reconnect: {
        maxAttempts: 0,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
        maxDurationMs: 25,
      },
    });

    await expect(connecting).rejects.toBeInstanceOf(QwpReconnectExhaustedError);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await expect(connection.closed).resolves.toMatchObject({ code: 1000 });
  });

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
    second.receive(resultEnd(0n, 1n, 0n));

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

  it("does not replay credit grants a reset has already zeroed", async () => {
    // Replay restarts the request from row zero and resetForReplay() zeroes
    // the session's own `deliveredCreditBytes` with it, so the grants issued
    // against the dead connection are no longer counted by either side. QWP
    // credit is additive, so replaying them re-opened a window the session had
    // forgotten -- and with autoCredit on, one payload per consumed batch was
    // retained for the whole life of a streaming query with nothing to prune
    // it. The QUERY_REQUEST being replayed carries initialCredit itself.
    const first = new FakeConnection("primary");
    const second = new FakeConnection("secondary");
    const connections = [first, second];
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
        reconnect: { maxAttempts: 1, initialBackoffMs: 0, maxBackoffMs: 0 },
      },
    );
    const query = await session.query("select * from x");
    const iterator = query[Symbol.asyncIterator]();

    // Grants against the live connection, the way a consuming reader produces
    // them one per batch.
    for (let grant = 0; grant < 25; grant++) await query.grantCredit(4096);
    const creditKind = QWP_EGRESS_MESSAGE.CREDIT;
    await vi.waitFor(() =>
      expect(first.sent.filter((frame) => frame[0] === creditKind).length).toBe(
        25,
      ),
    );

    first.drop();
    await vi.waitFor(() => expect(second.sent.length).toBeGreaterThan(0));

    // Exactly the request, and no carried-over credit.
    expect(second.sent[0][0]).toBe(QWP_EGRESS_MESSAGE.QUERY_REQUEST);
    expect(second.sent.filter((frame) => frame[0] === creditKind)).toEqual([]);

    second.receive(resultEnd(0n, 0n, 0n));
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
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
    second.receive(resultEnd(0n, 1n, 0n));
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
    second.receive(resultEnd(0n, 1n, 0n));
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

  it("replays after a malformed RESULT_END even when its socket closes", async () => {
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
          maxAttempts: 2,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    );
    const query = await session.query("select * from x");

    // No batch was decoded, so this terminal's claimed batch count is invalid.
    // Closing immediately exercises the transport/session verdict handshake:
    // replay state must survive until finish() accepts the aggregate totals.
    first.receive(resultEnd(query.requestId, 1n, 0n));
    first.drop();

    await vi.waitFor(() => expect(second.sent).toEqual(first.sent));
    second.receive(emptyResultBatch(query.requestId));
    second.receive(resultEnd(query.requestId, 1n, 0n));
    await expect(query.completion).resolves.toMatchObject({
      kind: "result-end",
      finalSequence: 1n,
      totalRows: 0n,
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

  it("refuses to quarantine a slot acquired by a successor", async () => {
    const directory = await trackedDirectory();
    const successor = new QwpNodeFileReplayStore({ directory });
    await successor.load();
    await successor.append({ frameSequence: 0n, payload: Uint8Array.of(1) });

    await expect(
      quarantineQwpNodeReplayStore(directory, new Error("predecessor failed")),
    ).rejects.toBeInstanceOf(QwpReplayStoreLockedError);
    await expect(stat(directory)).resolves.toBeDefined();
    await expect(
      successor.append({ frameSequence: 1n, payload: Uint8Array.of(2) }),
    ).resolves.toBeUndefined();
    expect(successor.metrics.pendingRecords).toBe(2);
    await successor.close();
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

  it("validates a recovered payload again when lazy replay reads it", async () => {
    const directory = await trackedDirectory();
    const seed = new QwpNodeFileReplayStore({ directory });
    await seed.load();
    await seed.append({
      frameSequence: 0n,
      payload: Uint8Array.of(1, 2, 3, 4),
    });
    await seed.close();

    const recovered = new QwpNodeFileReplayStore({ directory });
    await expect(recovered.loadReferences()).resolves.toEqual([
      { frameSequence: 0n, payloadLength: 4 },
    ]);
    const [segment] = await assignedReplaySegments(directory);
    const file = await open(join(directory, segment), "r+");
    try {
      await file.write(Uint8Array.of(0xff), 0, 1, 24 + 8);
      await file.sync();
    } finally {
      await file.close();
    }

    await expect(recovered.readPayload(0n)).rejects.toBeInstanceOf(
      QwpReplayStoreCorruptionError,
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

  it("retries append-mode maintenance finalization after its directory sync fails", async () => {
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({ directory, maxSegmentBytes: 1 });
    await store.load();
    for (let sequence = 0n; sequence < 3n; sequence++) {
      await store.append({
        frameSequence: sequence,
        payload: Uint8Array.of(Number(sequence)),
      });
    }
    const syncDirectory = vi
      .spyOn(qwpSegmentMaintenanceWorker, "syncDirectory")
      .mockRejectedValueOnce(new Error("transient directory sync failure"));
    const internals = store as unknown as {
      pendingTrimSegments: unknown[];
      maintenanceFinalizationPending: boolean;
      maintenanceFailure?: unknown;
    };

    await store.acknowledgeThrough(2n);
    await vi.waitFor(() => {
      expect(internals.pendingTrimSegments).toHaveLength(0);
      expect(internals.maintenanceFinalizationPending).toBe(true);
      expect(internals.maintenanceFailure).toBeDefined();
    });
    await vi.waitFor(
      () => {
        expect(syncDirectory.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(internals.maintenanceFinalizationPending).toBe(false);
        expect(internals.maintenanceFailure).toBeUndefined();
      },
      { timeout: 4_000, interval: 100 },
    );
    await expect(
      store.append({ frameSequence: 3n, payload: Uint8Array.of(3) }),
    ).resolves.toBeUndefined();

    syncDirectory.mockRestore();
    await store.close();
  }, 10_000);

  it.each([
    QWP_SF_DURABILITY.APPEND,
    QWP_SF_DURABILITY.PERIODIC,
    QWP_SF_DURABILITY.MEMORY,
  ])(
    "retries empty-queue %s ACK finalization",
    async (durability) => {
      const directory = await trackedDirectory();
      const store = new QwpNodeFileReplayStore({
        directory,
        maxSegmentBytes: 1,
        durability,
      });
      await store.load();
      for (let sequence = 0n; sequence < 3n; sequence++) {
        await store.append({
          frameSequence: sequence,
          payload: Uint8Array.of(Number(sequence)),
        });
      }
      const internals = store as unknown as {
        pendingTrimSegments: unknown[];
        maintenanceFinalizationPending: boolean;
        maintenanceFailure?: unknown;
        removeAcknowledgedThrough(): Promise<void>;
      };
      const removeAcknowledgedThrough = vi
        .spyOn(internals, "removeAcknowledgedThrough")
        .mockRejectedValueOnce(new Error("transient ACK cleanup failure"));

      await store.acknowledgeThrough(2n);
      await vi.waitFor(() => {
        expect(internals.pendingTrimSegments).toHaveLength(0);
        expect(internals.maintenanceFinalizationPending).toBe(true);
        expect(internals.maintenanceFailure).toBeDefined();
      });
      await vi.waitFor(
        () => {
          expect(removeAcknowledgedThrough.mock.calls.length).toBeGreaterThan(
            1,
          );
          expect(internals.maintenanceFinalizationPending).toBe(false);
          expect(internals.maintenanceFailure).toBeUndefined();
        },
        { timeout: 4_000, interval: 100 },
      );
      await expect(
        stat(join(directory, ".ack-watermark")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        store.append({ frameSequence: 3n, payload: Uint8Array.of(3) }),
      ).resolves.toBeUndefined();

      removeAcknowledgedThrough.mockRestore();
      await store.close();
    },
    10_000,
  );

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

  it.each([
    QWP_SF_DURABILITY.APPEND,
    QWP_SF_DURABILITY.PERIODIC,
    QWP_SF_DURABILITY.MEMORY,
  ])(
    "preserves a possibly published %s hot spare for recovery",
    async (durability) => {
      const directory = await trackedDirectory();
      const store = new QwpNodeFileReplayStore({
        directory,
        durability,
      });
      await store.load();
      await store.append({ frameSequence: 0n, payload: Uint8Array.of(7) });
      const internals = store as unknown as {
        hotSpare?: { path: string };
        activateHotSpare(firstSequence: bigint): Promise<unknown>;
        advanceManifestForActivation(firstSequence: bigint): Promise<void>;
      };
      await vi.waitFor(() => expect(internals.hotSpare).toBeDefined());
      const advance = internals.advanceManifestForActivation.bind(internals);
      vi.spyOn(
        internals,
        "advanceManifestForActivation",
      ).mockImplementationOnce(async (firstSequence) => {
        await advance(firstSequence);
        throw new Error("fault after manifest publication");
      });

      await expect(internals.activateHotSpare(1n)).rejects.toThrow(
        /could not activate/,
      );
      const publishedPath = internals.hotSpare!.path;
      await store.close();
      await expect(stat(publishedPath)).resolves.toBeDefined();

      const recovered = new QwpNodeFileReplayStore({
        directory,
        durability,
      });
      await expect(recovered.load()).resolves.toMatchObject([
        { frameSequence: 0n },
      ]);
      await recovered.close();
    },
  );

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

  it("keeps the corruption verdict when the failed load's unwind also fails", async () => {
    // A failing load unwinds by closing handles and releasing the directory
    // lock. Both ran unguarded in a finally, so a fault there -- EMFILE, EIO,
    // an NFS ESTALE, exactly what QwpReplayStoreLockUnprovableError exists for
    // -- replaced the corruption verdict with a generic error.
    // isQuarantinableReplayRecoveryError then said no, so the slot was never
    // moved aside and the producer could not start on any later restart.
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({ directory, maxSegmentBytes: 1 });
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
      await file.write(sequence, 0, sequence.byteLength, 8);
      await file.sync();
    } finally {
      await file.close();
    }

    const originalRelease = QwpNodeAdvisoryLock.prototype.release;
    let releases = 0;
    const release = vi
      .spyOn(QwpNodeAdvisoryLock.prototype, "release")
      .mockImplementation(function (this: QwpNodeAdvisoryLock) {
        // load() releases the parent-anchored logical lock first, as part of
        // its own lock protocol; faulting that is a genuine acquisition
        // failure and a different case. Only the slot lock released by the
        // teardown -- every release after the first -- is faulted here.
        return ++releases === 1
          ? originalRelease.call(this)
          : Promise.reject(
              Object.assign(new Error("stale NFS handle"), { code: "ESTALE" }),
            );
      });
    try {
      const recovered = new QwpNodeFileReplayStore({ directory });
      // The verdict the caller acts on, not the teardown's complaint.
      await expect(recovered.load()).rejects.toMatchObject({
        name: "QwpReplayStoreCorruptionError",
        retryable: false,
      });
      expect(release).toHaveBeenCalled();
    } finally {
      release.mockRestore();
    }
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
    "preserves a journal when %s has intact records behind it",
    async (_label, shape) => {
      // Replay cannot cross the missing sequence, but a CRC-valid record after
      // the damage proves this is not an interrupted tail append. Preserve the
      // original bytes so the high-level connection can quarantine the slot.
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
      const beforeRecovery = await readFile(join(directory, segment));

      const reports: QwpNodeReplayDataLossReport[] = [];
      const recovered = new QwpNodeFileReplayStore({
        directory,
        onRecoveryDataLoss: (report) => reports.push(report),
      });
      await expect(recovered.load()).rejects.toThrow(/interior damage/);
      expect(reports).toEqual([]);
      expect(
        Buffer.compare(
          await readFile(join(directory, segment)),
          beforeRecovery,
        ),
      ).toBe(0);
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

  it("reports trailing records that never reached disk", async () => {
    // The one silent shape. A lost trailing page reads back as zeros, exactly
    // like a segment's unwritten reservation, so it leaves no torn record, no
    // CRC mismatch and no bytes to count -- while every other damage shape
    // reports. The durable append high-water mark in the ACK record is the
    // only witness that those sequences ever existed.
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
    // Persists the watermark, and with it the high-water mark of 11.
    await first.acknowledgeThrough(2n);
    await first.close();

    const segments = await assignedReplaySegments(directory);
    const tail = segments[segments.length - 1];
    const path = join(directory, tail);
    const size = (await stat(path)).size;
    const file = await open(path, "r+");
    try {
      // Only the final record's bytes: the rest of the segment survives, so
      // nothing in the file itself hints that anything is missing.
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
    expect(
      reports.some((report) => /never reached disk/.test(report.reason)),
    ).toBe(true);
    await recovered.close();
  });

  it("does not report a loss when the journal drains cleanly", async () => {
    // The false-positive guard for the check above: a fully acknowledged and
    // trimmed journal has nothing left to read back, and must not be mistaken
    // for one whose tail went missing.
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 4096,
      durability: "memory",
    });
    await store.load();
    for (let sequence = 0; sequence < 8; sequence++) {
      await store.append({
        frameSequence: BigInt(sequence),
        payload: new Uint8Array(600).fill(sequence + 1),
      });
    }
    await store.acknowledgeThrough(7n);
    await store.close();

    const reports: QwpNodeReplayDataLossReport[] = [];
    const reopened = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 4096,
      durability: "memory",
      onRecoveryDataLoss: (report) => reports.push(report),
    });
    await reopened.load();
    expect(reports).toEqual([]);
    await reopened.close();
  });

  it("reopens a multi-segment journal after retiring its manifest active base", async () => {
    // The reopen the test above stops short of. Recovery retires the flagged,
    // record-free active segment, but the manifest still named it as the
    // active base and the monotonic clamp in writeManifest() would not let the
    // boundary retract, so nothing was rewritten. The next load then rejected
    // the whole journal as a chain mismatch and abandoned the frames in the
    // segments that were intact. Blind SIGKILL trials hit this on 7.8% of
    // crashes. The single-segment sibling below passes because the store
    // removes the manifest outright when no segment is left.
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
      await file.write(Buffer.alloc(size - 24, 0), 0, size - 24, 24);
      await file.sync();
    } finally {
      await file.close();
    }

    const recovered = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 4096,
      durability: "memory",
      onRecoveryDataLoss: () => undefined,
    });
    const firstLoad = await recovered.load();
    expect(firstLoad.length).toBeGreaterThan(0);
    await recovered.close();

    // The frames the first load recovered are still on disk and must still be
    // replayable. Before the fix this threw a corruption error naming the
    // boundary recovery had just invalidated.
    const reopened = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 4096,
      durability: "memory",
    });
    const secondLoad = await reopened.load();
    expect(secondLoad.map((frame) => frame.frameSequence)).toEqual(
      firstLoad.map((frame) => frame.frameSequence),
    );
    await reopened.close();
  });

  it("retires an empty lost segment after reporting it once", async () => {
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 4096,
      durability: "memory",
    });
    await first.load();
    await first.append({
      frameSequence: 0n,
      payload: new Uint8Array(600).fill(1),
    });
    await first.close();

    const [segment] = await assignedReplaySegments(directory);
    const path = join(directory, segment);
    const size = (await stat(path)).size;
    const file = await open(path, "r+");
    try {
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
    await expect(recovered.load()).resolves.toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0].segmentFile).toBe(segment);
    await recovered.close();
    await expect(assignedReplaySegments(directory)).resolves.toEqual([]);

    const repeatedReports: QwpNodeReplayDataLossReport[] = [];
    const reopened = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 4096,
      durability: "memory",
      onRecoveryDataLoss: (report) => repeatedReports.push(report),
    });
    await expect(reopened.load()).resolves.toEqual([]);
    expect(repeatedReports).toEqual([]);
    await reopened.close();
  });

  it("leaves a freshly activated segment unflagged until its first record", async () => {
    // MANIFEST_REQUIRED_FLAG is the entire basis for reading an empty active
    // segment as "records were written and lost", so any moment in which the
    // flag is durable and no record is forges that verdict. activateHotSpare
    // used to stamp and fsync it, then run a whole trimSegment of the previous
    // segment -- a manifest write, its fsync, a directory fsync and a
    // cross-thread unlink -- and only then return to appendOnce for the record.
    // A kill anywhere in that stretch reported abandoned data to a producer
    // whose first append had not returned. The stamp belongs to the append.
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 4096,
      durability: "append",
    });
    await store.load();
    await store.append({
      frameSequence: 0n,
      payload: new Uint8Array(512).fill(1),
    });

    const rotate = store as unknown as {
      activateHotSpare(firstSequence: bigint): Promise<unknown>;
    };
    await rotate.activateHotSpare(1n);

    const flagOf = async (segment: string): Promise<number> => {
      const file = await open(join(directory, segment), "r");
      try {
        const byte = Buffer.alloc(1);
        await file.read(byte, 0, 1, 5);
        return byte.readUInt8(0);
      } finally {
        await file.close();
      }
    };
    const segments = await assignedReplaySegments(directory);
    const activated = segments[segments.length - 1];
    expect(await flagOf(activated), "activation must not stamp the flag").toBe(
      0,
    );

    await store.append({
      frameSequence: 1n,
      payload: new Uint8Array(512).fill(2),
    });
    expect(await flagOf(activated), "the first record stamps it").toBe(1);
    await store.close();
  });

  it("does not invent a loss on the restart after an empty active segment", async () => {
    // Recovery stamped MANIFEST_REQUIRED_FLAG onto every surviving segment,
    // including the empty active one it had just proved carries no flag -- and
    // that flag is the whole basis for reading "empty" as "records were lost".
    // The next restart therefore read back evidence recovery had forged and
    // reported a data loss that never happened. The stamp now belongs to the
    // next append, immediately before the first record, which is also where
    // activateHotSpare now leaves it.
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 8192,
      durability: "memory",
    });
    await first.load();
    for (let sequence = 0; sequence < 8; sequence++) {
      await first.append({
        frameSequence: BigInt(sequence),
        payload: new Uint8Array(600).fill(sequence + 1),
      });
    }
    await first.close();

    // A crash inside activateHotSpare's window: the manifest already names
    // this segment, but no record and no flag ever reached it.
    const [segment] = await assignedReplaySegments(directory);
    const path = join(directory, segment);
    const size = (await stat(path)).size;
    const file = await open(path, "r+");
    try {
      await file.write(Buffer.alloc(size - 24, 0), 0, size - 24, 24);
      await file.write(Buffer.of(0), 0, 1, 5);
      await file.sync();
    } finally {
      await file.close();
    }

    for (const pass of ["first", "second"]) {
      const reports: QwpNodeReplayDataLossReport[] = [];
      const reopened = new QwpNodeFileReplayStore({
        directory,
        maxSegmentBytes: 8192,
        durability: "memory",
        onRecoveryDataLoss: (report) => reports.push(report),
      });
      await expect(reopened.load()).resolves.toEqual([]);
      expect(reports, `${pass} recovery reported a loss`).toEqual([]);
      await reopened.close();
    }
  });

  it("retires an empty active segment that outlived its sequence origin", async () => {
    // activateHotSpare() writes a segment's base, fsyncs the manifest that
    // names it, and only then stamps the manifest-required flag. A crash in
    // that window leaves a real segment carrying a non-zero base, no records
    // and no flag -- and recovery is required to retain exactly that shape
    // (see the test above) rather than forge the flag.
    //
    // Retaining the base was the problem. Once the journal has drained, the
    // ACK watermark is gone and a reconnecting transport restarts its frame
    // numbering at 0, so the retained base belonged to a numbering nothing
    // else remembered. appendOnce()'s segment contiguity check then rejected
    // every frame, non-retryably and identically after each restart, while
    // load() went on resolving successfully with no data loss reported.
    const directory = await trackedDirectory();
    const first = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 8192,
      durability: "memory",
    });
    await first.load();
    for (let sequence = 0; sequence < 8; sequence++) {
      await first.append({
        frameSequence: BigInt(sequence),
        payload: new Uint8Array(600).fill(sequence + 1),
      });
    }
    // Drain it: the caught-up steady state, where trimming retires the spent
    // segments and drops the watermark. The next frame then activates a fresh
    // segment at a base above zero, which is what makes this state reachable.
    await first.acknowledgeThrough(7n);
    await first.append({
      frameSequence: 8n,
      payload: new Uint8Array(600).fill(9),
    });
    await first.close();

    const segments = await assignedReplaySegments(directory);
    expect(segments).toHaveLength(1);
    const path = join(directory, segments[0]);
    const size = (await stat(path)).size;
    const file = await open(path, "r+");
    try {
      await file.write(Buffer.alloc(size - 24, 0), 0, size - 24, 24);
      await file.write(Buffer.of(0), 0, 1, 5);
      await file.sync();
      // Guard the premise: a zero base would let this pass without the fix,
      // because the transport also restarts at zero.
      const header = Buffer.alloc(24);
      await file.read(header, 0, 24, 0);
      expect(header.readBigUInt64LE(8)).toBeGreaterThan(0n);
      expect(header.readUInt8(5)).toBe(0);
    } finally {
      await file.close();
    }

    const reports: QwpNodeReplayDataLossReport[] = [];
    const reopened = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 8192,
      durability: "memory",
      onRecoveryDataLoss: (report) => reports.push(report),
    });
    await expect(reopened.load()).resolves.toEqual([]);
    expect(reports).toEqual([]);
    // The frame the restarted transport actually offers.
    await reopened.append({
      frameSequence: 0n,
      payload: new Uint8Array(600).fill(1),
    });
    await reopened.close();

    // ...and the journal is genuinely usable again, not merely accepting one
    // append: the frame comes back on the next restart.
    const replayed = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 8192,
      durability: "memory",
    });
    await expect(replayed.load()).resolves.toEqual([
      { frameSequence: 0n, payload: new Uint8Array(600).fill(1) },
    ]);
    await replayed.close();
  });

  it("reports an undetermined-extent loss as such through onSenderError", async () => {
    // The store's own logger words this correctly; the onSenderError bridge
    // interpolated discardedBytes instead, so a whole lost segment reached an
    // alerting consumer as "discarded 0 journal byte(s)" -- which reads as
    // nothing lost. Both channels format through the same helper now.
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

    const segments = (await readdir(directory))
      .filter((name) => name.endsWith(".sfa"))
      .sort();
    const tail = segments[segments.length - 1];
    const path = join(directory, tail);
    const size = (await stat(path)).size;
    const file = await open(path, "r+");
    try {
      await file.write(Buffer.alloc(size - 24, 0), 0, size - 24, 24);
      await file.sync();
    } finally {
      await file.close();
    }

    const senderErrors: QwpSenderError[] = [];
    const session = await connectQwpNodeIngress(
      {
        // Nothing listens here; `async` startup resolves regardless, and the
        // recovery report is what this test is after.
        url: "ws://127.0.0.1:1/write/v4",
        storeAndForward: {
          directory,
          maxSegmentBytes: 4096,
          durability: "memory",
          initialConnectMode: "async",
        },
      },
      {
        onSenderError: (error) => senderErrors.push(error),
        reconnect: { initialBackoffMs: 10_000, maxBackoffMs: 10_000 },
      },
    );
    try {
      await vi.waitFor(() => expect(senderErrors).not.toHaveLength(0));
      const dataLoss = senderErrors.find(
        (error) => error.category === "data-loss",
      );
      expect(dataLoss?.serverMessage).toMatch(
        /lost journalled data of undetermined size/,
      );
      expect(dataLoss?.serverMessage).not.toMatch(/discarded 0 journal byte/);
    } finally {
      await session.close().catch(() => undefined);
    }
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

  it("revalidates a lapsed lease before appending", async () => {
    // A long synchronous section or suspended VM can delay the heartbeat past
    // its liveness window. The recorded process is still alive, so a contender
    // cannot adopt the slot and the holder can prove its token before writing.
    // Only Date is faked: the first operation after the clock jump must perform
    // that revalidation itself, without waiting for the heartbeat timer.
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
      ).resolves.toBeUndefined();
      await store.close();
    } finally {
      vi.useRealTimers();
    }

    const reopened = new QwpNodeFileReplayStore({ directory });
    await expect(reopened.load()).resolves.toEqual([
      { frameSequence: 0n, payload: Uint8Array.of(1) },
      { frameSequence: 1n, payload: Uint8Array.of(2) },
    ]);
    await reopened.close();
  });

  it("fences an append that loses its slot during segment activation", async () => {
    const directory = await trackedDirectory();
    const predecessor = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 1,
    });
    await predecessor.load();
    await predecessor.append({
      frameSequence: 0n,
      payload: Uint8Array.of(0),
    });

    type SyncHandle = { sync(): Promise<void> };
    const internals = predecessor as unknown as {
      hotSpare?: { handle: SyncHandle };
      slotLock?: { provenAtMs: number };
    };
    await vi.waitFor(() => expect(internals.hotSpare).toBeDefined());
    const handle = internals.hotSpare!.handle;
    const realSync = handle.sync.bind(handle);
    let syncCalls = 0;
    let resumeActivation!: () => void;
    const activationPaused = new Promise<void>((resolve) => {
      resumeActivation = resolve;
    });
    handle.sync = async () => {
      await realSync();
      syncCalls++;
      if (syncCalls === 2) await activationPaused;
    };

    const staleAppend = predecessor.append({
      frameSequence: 1n,
      payload: Uint8Array.of(11),
    });
    await vi.waitFor(() => expect(syncCalls).toBe(2));

    // Model an operator forcing a handoff after concluding the holder died.
    // The process is deliberately still alive here so the old in-flight
    // operation must notice the replacement token before committing state.
    await rm(join(directory, ".lock.owner"), {
      recursive: true,
      force: true,
    });
    internals.slotLock!.provenAtMs = Date.now() - 60_000;
    const successor = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 1,
      onRecoveryDataLoss: () => undefined,
    });
    await successor.load();
    await successor.append({
      frameSequence: 1n,
      payload: Uint8Array.of(22),
    });
    expect(await successor.readPayload(1n)).toEqual(Uint8Array.of(22));

    resumeActivation();
    await expect(staleAppend).rejects.toBeInstanceOf(
      QwpReplayStoreLockLostError,
    );
    expect(await successor.readPayload(1n)).toEqual(Uint8Array.of(22));

    await predecessor.close().catch(() => undefined);
    await successor.close();
    const reopened = new QwpNodeFileReplayStore({ directory });
    await expect(reopened.load()).resolves.toEqual([
      { frameSequence: 0n, payload: Uint8Array.of(0) },
      { frameSequence: 1n, payload: Uint8Array.of(22) },
    ]);
    await reopened.close();
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

  it.each([
    ["never landed", undefined],
    ["was torn mid-write", '{"pid":1,"host":'],
  ])(
    "reclaims an owner directory whose record %s",
    async (_label, contents) => {
      // The counterpart of the test above, past the liveness window. The
      // record-less state is also what a process killed inside a release used
      // to leave, and nothing recovered it: reclaimIfDefunct() returned before
      // consulting isPidAlive, so the slot stayed locked against every later
      // process -- including the orphan drainer, which reported it locked
      // forever without ever writing a `.failed` sentinel or reporting data
      // loss. The frames below were unreachable until an operator removed the
      // directory by hand.
      const directory = await trackedDirectory();
      const seeded = new QwpNodeFileReplayStore({ directory });
      await seeded.load();
      await seeded.append({ frameSequence: 0n, payload: Uint8Array.of(7) });
      await seeded.append({ frameSequence: 1n, payload: Uint8Array.of(8) });
      await seeded.close();

      const ownerPath = join(directory, ".lock.owner");
      await mkdir(ownerPath);
      if (contents !== undefined) {
        await writeFile(join(ownerPath, "owner"), contents);
      }
      await writeFile(join(directory, ".lock.pid"), `${process.pid}\n`);
      const aged = new Date(Date.now() - 60_000);
      await utimes(ownerPath, aged, aged);

      const store = new QwpNodeFileReplayStore({ directory });
      await expect(store.load()).resolves.toEqual([
        { frameSequence: 0n, payload: Uint8Array.of(7) },
        { frameSequence: 1n, payload: Uint8Array.of(8) },
      ]);
      await store.close();
    },
  );

  it("sweeps owner directories left aside by an interrupted release", async () => {
    // release() renames the owner directory aside before removing it, so a
    // process killed between the two leaves the mutex free rather than a
    // record-less directory nobody can reclaim. The aside directory holds no
    // lock, so the acquisition that follows clears it.
    const directory = await trackedDirectory();
    const stray = join(directory, ".lock.owner.abandoned-999999-0");
    await mkdir(stray, { recursive: true });
    await writeFile(join(stray, "owner"), "{}");

    const lock = await QwpNodeAdvisoryLock.acquire(directory);
    expect(await readdir(directory)).not.toContain(
      ".lock.owner.abandoned-999999-0",
    );
    await lock.release();
    expect(await readdir(directory)).not.toContain(".lock.owner");
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

  it("leaves the directory alone once its owner token was replaced", async () => {
    // Public operations fence on the owner token, but background maintenance
    // and teardown also have to avoid deleting the replacement owner's
    // segments, manifest, symbol dictionary, or ACK watermark.
    const directory = await trackedDirectory();
    const evicted = new QwpNodeFileReplayStore({ directory });
    await evicted.load();
    await evicted.appendSymbolDictionary(0, ["evicted"]);
    await evicted.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
    // Fully drained, so close() takes the teardown paths that delete: the
    // watermark, the dictionary, and the parent-anchored orphan pair.
    await evicted.acknowledgeThrough(0n);
    // acknowledgeThrough() schedules segment trimming in the background. Let
    // that work settle before forcing the token handoff so it cannot race the
    // successor's recovery for a reason unrelated to the cleanup fence.
    await vi.waitFor(
      async () => {
        expect(evicted.metrics.pendingSegments).toBe(0);
        expect(await readdir(directory)).not.toContain(".ack-watermark");
      },
      { timeout: 5_000 },
    );

    // Model an operator forcing a handoff after concluding the holder died.
    // The still-live holder must treat the replacement token as conclusive
    // loss and leave every successor-owned path alone during close.
    await rm(join(directory, ".lock.owner"), {
      recursive: true,
      force: true,
    });
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
    // which is the moment it used to start deleting.
    const evictedLock = (
      evicted as unknown as { slotLock: QwpNodeAdvisoryLock }
    ).slotLock;
    await (evictedLock as unknown as { beat(): Promise<void> }).beat();
    await expect(
      evicted.append({ frameSequence: 1n, payload: Uint8Array.of(2) }),
    ).rejects.toMatchObject({ name: "QwpReplayStoreLockLostError" });
    await evicted.close().catch(() => undefined);

    expect(await durableEntries()).toEqual(before);
    expect(await readFile(join(directory, ".symbol-dict"))).toEqual(
      successorDictionary,
    );
    // The successor is still healthy, and still owns the lock it took.
    await successor.append({ frameSequence: 3n, payload: Uint8Array.of(11) });
    await successor.close();
  });

  it("retries queued trims after a transient ownership lapse", async () => {
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({ directory, maxSegmentBytes: 1 });
    await store.load();
    for (let sequence = 0n; sequence < 6n; sequence++) {
      await store.append({
        frameSequence: sequence,
        payload: Uint8Array.of(Number(sequence)),
      });
    }
    const internals = store as unknown as {
      slotLock: QwpNodeAdvisoryLock;
      pendingTrimSegments: unknown[];
      maintenanceRetryTimer?: ReturnType<typeof setTimeout>;
      runMaintenanceBatch(): Promise<void>;
    };
    const lock = internals.slotLock;
    const realUnlink = qwpSegmentMaintenanceWorker.unlink.bind(
      qwpSegmentMaintenanceWorker,
    );
    const unlinked: string[] = [];
    const unlink = vi
      .spyOn(qwpSegmentMaintenanceWorker, "unlink")
      .mockImplementation(async (path: string) => {
        unlinked.push(path);
        await realUnlink(path);
        if (unlinked.length === 1) {
          // Model a stale but still matching acquisition immediately after the
          // first trim. ownership() cannot refresh while this getter is pinned.
          Object.defineProperty(lock, "lost", {
            configurable: true,
            get: () => true,
          });
        }
      });

    try {
      // Five segments become fully acknowledged in one maintenance batch.
      await store.acknowledgeThrough(4n);
      await vi.waitFor(() => expect(unlinked).toHaveLength(1));
      await vi.waitFor(() =>
        expect(internals.pendingTrimSegments).toHaveLength(4),
      );

      // Re-proving the same token resumes the preserved queue. Calling the
      // batch directly avoids making this regression test wait for its 1s timer.
      delete (lock as unknown as Record<string, unknown>).lost;
      // Production only ever reaches runMaintenanceBatch() through the store's
      // serializing queue. Calling it directly races the retry timer that the
      // ownership lapse just armed: both batches read pendingTrimSegments[0],
      // both unlink it, and both shift. Disarm it so this stays a test of the
      // preserved queue rather than an intermittent double-unlink.
      if (internals.maintenanceRetryTimer) {
        clearTimeout(internals.maintenanceRetryTimer);
        internals.maintenanceRetryTimer = undefined;
      }
      await internals.runMaintenanceBatch();
      expect(unlinked).toHaveLength(5);
      expect(internals.pendingTrimSegments).toHaveLength(0);
      expect(store.metrics.pendingSegments).toBe(1);
    } finally {
      delete (lock as unknown as Record<string, unknown>).lost;
      unlink.mockRestore();
      await store.close().catch(() => undefined);
    }

    const reopened = new QwpNodeFileReplayStore({ directory });
    const recovered = await reopened.load();
    expect(recovered.map((record) => record.frameSequence)).toEqual([5n]);
    await reopened.close();
  });

  it("does not unlink a segment while ownership is unprovable", async () => {
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({ directory, maxSegmentBytes: 1 });
    await store.load();
    for (let sequence = 0n; sequence < 4n; sequence++) {
      await store.append({
        frameSequence: sequence,
        payload: Uint8Array.of(Number(sequence)),
      });
    }
    const internals = store as unknown as {
      slotLock: QwpNodeAdvisoryLock;
      segmentOrder: { path: string }[];
      trimSegment(segment: { path: string }): Promise<void>;
    };
    const head = internals.segmentOrder[0];
    Object.defineProperty(internals.slotLock, "lost", {
      configurable: true,
      get: () => true,
    });

    try {
      await expect(internals.trimSegment(head)).rejects.toMatchObject({
        name: "QwpReplayStoreLockUnprovableError",
      });
      expect(await assignedReplaySegments(directory)).toContain(
        basename(head.path),
      );
    } finally {
      delete (internals.slotLock as unknown as Record<string, unknown>).lost;
      await store.close().catch(() => undefined);
    }

    const reopened = new QwpNodeFileReplayStore({ directory });
    const recovered = await reopened.load();
    expect(recovered.map((record) => record.frameSequence)).toEqual([
      0n,
      1n,
      2n,
      3n,
    ]);
    await reopened.close();
  });

  it("retries activation after manifest ownership becomes unprovable", async () => {
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({ directory, maxSegmentBytes: 1 });
    await store.load();
    await store.append({ frameSequence: 0n, payload: Uint8Array.of(0) });
    const internals = store as unknown as {
      slotLock: QwpNodeAdvisoryLock;
      activateHotSpare(firstSequence: bigint): Promise<unknown>;
    };
    const ownership = vi
      .spyOn(internals.slotLock, "ownership")
      .mockResolvedValueOnce("owned")
      .mockResolvedValueOnce("owned")
      .mockResolvedValueOnce("owned")
      // The spare has its final manifest-optional pathname at this point.
      .mockResolvedValueOnce("unprovable");

    try {
      await expect(internals.activateHotSpare(1n)).rejects.toMatchObject({
        name: "QwpReplayStoreLockUnprovableError",
      });
    } finally {
      ownership.mockRestore();
    }

    // The retry must reuse the renamed spare, publish its manifest boundary,
    // and append normally rather than depending on rename(path, path).
    await store.append({ frameSequence: 1n, payload: Uint8Array.of(1) });
    await store.close();

    const reopened = new QwpNodeFileReplayStore({ directory });
    const recovered = await reopened.load();
    expect(recovered.map((record) => record.frameSequence)).toEqual([0n, 1n]);
    await reopened.close();
  });

  it.each([
    { acknowledgedThrough: 0n, expectedSequences: [1n, 2n] },
    { acknowledgedThrough: 2n, expectedSequences: [] },
  ])(
    "leaves recovery files intact when manifest ownership lapses after ACK $acknowledgedThrough",
    async ({ acknowledgedThrough, expectedSequences }) => {
      const directory = await trackedDirectory();
      const seed = new QwpNodeFileReplayStore({
        directory,
        maxSegmentBytes: 1,
      });
      await seed.load();
      for (let sequence = 0n; sequence < 3n; sequence++) {
        await seed.append({
          frameSequence: sequence,
          payload: Uint8Array.of(Number(sequence)),
        });
      }
      await (
        seed as unknown as {
          persistAcknowledgedThrough(frameSequence: bigint): Promise<void>;
        }
      ).persistAcknowledgedThrough(acknowledgedThrough);
      await seed.close();
      const before = await assignedReplaySegments(directory);

      const recovering = new QwpNodeFileReplayStore({ directory });
      const ownership = vi
        .spyOn(QwpNodeAdvisoryLock.prototype, "ownership")
        .mockResolvedValueOnce("unprovable");
      try {
        await expect(recovering.load()).rejects.toMatchObject({
          name: "QwpReplayStoreLockUnprovableError",
        });
      } finally {
        ownership.mockRestore();
        await recovering.close().catch(() => undefined);
      }
      expect(await assignedReplaySegments(directory)).toEqual(before);

      const reopened = new QwpNodeFileReplayStore({ directory });
      const recovered = await reopened.load();
      expect(recovered.map((record) => record.frameSequence)).toEqual(
        expectedSequences,
      );
      await reopened.close();
    },
  );

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

  it("never re-proves a foreign owner after a stalled heartbeat", async () => {
    // A lapsed holder may refresh in place only while its acquisition token
    // still matches. Model external cleanup replacing the owner directory:
    // the resumed heartbeat must fence permanently without touching it.
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

  it("fences a heartbeat that touches a successor after token handoff", async () => {
    // Pause a heartbeat after its token read, force an external handoff, then
    // resume it at the pathname touch. The old heartbeat may refresh the
    // successor's mtime, but the second token check must fence the predecessor.
    const directory = await trackedDirectory();
    const predecessor = new QwpNodeFileReplayStore({ directory });
    await predecessor.load();
    await predecessor.append({
      frameSequence: 0n,
      payload: Uint8Array.of(1),
    });

    type LockInternals = {
      beat(): Promise<void>;
      ownershipState(): Promise<"owned" | "foreign" | "unknown">;
    };
    const predecessorLock = (
      predecessor as unknown as { slotLock: QwpNodeAdvisoryLock }
    ).slotLock;
    const lockInternals = predecessorLock as unknown as LockInternals;
    const ownerPath = join(directory, ".lock.owner");

    const realOwnershipState =
      lockInternals.ownershipState.bind(predecessorLock);
    let resumeHeartbeat!: () => void;
    const heartbeatPaused = new Promise<void>((resolve) => {
      resumeHeartbeat = resolve;
    });
    let ownerRead!: () => void;
    const ownerWasRead = new Promise<void>((resolve) => {
      ownerRead = resolve;
    });
    let ownershipReads = 0;
    lockInternals.ownershipState = async () => {
      const state = await realOwnershipState();
      if (++ownershipReads === 1) {
        ownerRead();
        await heartbeatPaused;
      }
      return state;
    };

    const staleHeartbeat = lockInternals.beat();
    await ownerWasRead;

    await rm(ownerPath, { recursive: true, force: true });
    const successor = new QwpNodeFileReplayStore({ directory });
    await successor.load();
    await successor.append({
      frameSequence: 1n,
      payload: Uint8Array.of(22),
    });
    // Ensure the resumed utimes changes the successor's recorded mtime, so its
    // next heartbeat also proves that a foreign touch does not evict an owner
    // whose token still matches.
    await new Promise((resolve) => setTimeout(resolve, 10));
    resumeHeartbeat();
    await staleHeartbeat;

    expect(predecessorLock.lost).toBe(true);
    await expect(
      predecessor.append({
        frameSequence: 1n,
        payload: Uint8Array.of(11),
      }),
    ).rejects.toBeInstanceOf(QwpReplayStoreLockLostError);
    expect(await successor.readPayload(1n)).toEqual(Uint8Array.of(22));

    const successorLock = (
      successor as unknown as { slotLock: QwpNodeAdvisoryLock }
    ).slotLock;
    await (successorLock as unknown as LockInternals).beat();
    expect(successorLock.lost).toBe(false);
    await successor.append({
      frameSequence: 2n,
      payload: Uint8Array.of(33),
    });

    await predecessor.close().catch(() => undefined);
    await successor.close();
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

  it("does not reclaim a live process whose heartbeat timestamp lapsed", async () => {
    const directory = await trackedDirectory();
    const ownerPath = join(directory, ".lock.owner");
    await mkdir(ownerPath);
    // A live PID with an old mtime may be suspended inside a write. Reclaiming
    // it would let that descriptor modify a successor's accepted journal.
    await writeFile(
      join(ownerPath, "owner"),
      JSON.stringify({ pid: process.pid, host: hostname() }),
    );
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(ownerPath, longAgo, longAgo);

    const store = new QwpNodeFileReplayStore({ directory });
    await expect(store.load()).rejects.toMatchObject({
      name: "QwpReplayStoreLockedError",
      directory,
    } satisfies Partial<QwpReplayStoreLockedError>);
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

  it("does not reclaim an ambiguous predecessor whose PID this process now has", async () => {
    const directory = await trackedDirectory();
    const ownerPath = join(directory, ".lock.owner");
    await mkdir(ownerPath);
    // A producer SIGKILLed and restarted into the same PID -- the container
    // shape where the app is always PID 1, or PID wraparound. isPidAlive()
    // answers "yes" because the successor *is* that PID now. Neither a stale
    // heartbeat nor the retired instance spelling proves the old holder dead.
    await writeFile(
      join(ownerPath, "owner"),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        instance: "00000000-0000-4000-8000-000000000000",
      }),
    );
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(ownerPath, longAgo, longAgo);

    const store = new QwpNodeFileReplayStore({ directory });
    await expect(store.load()).rejects.toMatchObject({
      name: "QwpReplayStoreLockedError",
      directory,
    } satisfies Partial<QwpReplayStoreLockedError>);
  });

  it("does not reclaim a stalled worker-thread owner with the shared PID", async () => {
    const directory = await trackedDirectory();
    const ownerPath = join(directory, ".lock.owner");
    const worker = new Worker(
      `
        const fs = require("node:fs");
        const { hostname } = require("node:os");
        const { parentPort, workerData } = require("node:worker_threads");
        fs.mkdirSync(workerData.ownerPath);
        fs.writeFileSync(
          workerData.ownerPath + "/owner",
          JSON.stringify({
            pid: process.pid,
            host: hostname(),
            token: "worker-owner",
            instance: "legacy-worker-registry"
          })
        );
        parentPort.postMessage("ready");
        setInterval(() => {}, 1_000);
      `,
      { eval: true, workerData: { ownerPath } },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once("message", () => resolve());
        worker.once("error", reject);
      });
      const longAgo = new Date(Date.now() - 60_000);
      await utimes(ownerPath, longAgo, longAgo);

      const store = new QwpNodeFileReplayStore({ directory });
      await expect(store.load()).rejects.toMatchObject({
        name: "QwpReplayStoreLockedError",
        directory,
      } satisfies Partial<QwpReplayStoreLockedError>);
    } finally {
      await worker.terminate();
    }
  });

  it("leaves a heartbeating same-PID holder from another registry alone", async () => {
    // The worker-thread shape. PROCESS_INSTANCE is minted per module registry,
    // and every worker loads its own copy of this module, so a live sibling
    // presents our PID, alive, with an instance we did not mint -- exactly the
    // shape of a dead predecessor. Only the heartbeat separates them, and
    // reclaiming a live holder let two threads append to one journal.
    const directory = await trackedDirectory();
    const ownerPath = join(directory, ".lock.owner");
    await mkdir(ownerPath);
    await writeFile(
      join(ownerPath, "owner"),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        instance: "00000000-0000-4000-8000-000000000000",
      }),
    );
    // Current mtime: the holder is still heartbeating.
    const now = new Date();
    await utimes(ownerPath, now, now);

    const store = new QwpNodeFileReplayStore({ directory });
    await expect(store.load()).rejects.toMatchObject({
      name: "QwpReplayStoreLockedError",
      directory,
    } satisfies Partial<QwpReplayStoreLockedError>);
  });

  it("leaves a slot held by this process's own live acquisition alone", async () => {
    // The mirror of the case above: a record this process really did write
    // must never be reclaimed as a reused PID, or a lock would steal itself.
    const directory = await trackedDirectory();
    const lock = await QwpNodeAdvisoryLock.acquire(directory);
    try {
      await expect(QwpNodeAdvisoryLock.acquire(directory)).rejects.toThrow(
        /advisory lock is already held/,
      );
    } finally {
      await lock.release();
    }
  });

  it("leaves a slot owned by another host alone", async () => {
    const directory = await trackedDirectory();
    const ownerPath = join(directory, ".lock.owner");
    await mkdir(ownerPath);
    // A PID on another host cannot be probed for liveness. No timestamp can
    // prove it dead, so the slot remains held until an operator intervenes.
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

  it("waits out a transient fault under the default backpressure policy too", async () => {
    // `error` is the journal-exhaustion policy, and it is the default the
    // typed storeAndForward object inherits while connect strings pin `wait`.
    // Applied to the whole retryable class it rejected the caller's append on
    // a transient provisioning fault the journal absorbs a moment later --
    // neither journal exhaustion nor an append deadline, the only two errors
    // an sf_dir producer should see.
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 1,
      // No backpressurePolicy: this is the `error` default under test.
      appendDeadlineMs: 3_000,
    });
    await store.load();
    await store.append({ frameSequence: 0n, payload: Uint8Array.of(1) });

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
    await expect(
      store.append({ frameSequence: 2n, payload: Uint8Array.of(3) }),
    ).resolves.toBeUndefined();
    expect(store.metrics).toMatchObject({
      pendingRecords: 3,
      totalBackpressureStalls: 1,
      totalAppendTimeouts: 0,
    });

    provision.mockRestore();
    await store.close();
  }, 10_000);

  it("still fails an exhausted journal fast under the default policy", async () => {
    // The other half of the contract: `error` must keep failing immediately on
    // capacity, which is the backwards-compatible behaviour it documents.
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxBytes: 66,
      maxSegmentBytes: 1,
      // No backpressurePolicy: the `error` default must still fail fast here.
      appendDeadlineMs: 30_000,
    });
    await store.load();
    await store.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
    await store.append({ frameSequence: 1n, payload: Uint8Array.of(2) });

    const started = Date.now();
    await expect(
      store.append({ frameSequence: 2n, payload: Uint8Array.of(3) }),
    ).rejects.toBeInstanceOf(QwpReplayStoreFullError);
    // Immediately, not after the 30s deadline a `wait` journal would burn.
    expect(Date.now() - started).toBeLessThan(5_000);

    await store.close();
  });

  it("does not let a wall-clock step expire a parked append", async () => {
    // monotonic-clock.ts names append deadlines as one of the three budgets it
    // exists for, and the in-memory store measures the identical deadline that
    // way. Measured on Date.now(), an NTP correction or a VM resume expired a
    // wait that had barely started: the transient-fault path re-enters on a
    // fixed cadence and re-reads the deadline on every pass, so the very next
    // poll after the step rejected with QwpReplayStoreAppendTimeoutError --
    // one of the only two errors allowed to reach a producer.
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 1,
      backpressurePolicy: QWP_SF_BACKPRESSURE_POLICY.WAIT,
      appendDeadlineMs: 5_000,
    });
    await store.load();
    await store.append({ frameSequence: 0n, payload: Uint8Array.of(1) });

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

    // The wall clock jumps past appendDeadlineMs while barely any real time
    // has elapsed. The step stays under the advisory lock's STALE_AFTER_MS,
    // which compares against a filesystem mtime and is wall-clock by design, so
    // this isolates the append deadline. Measured in elapsed time, the wait
    // survives the step and is released when maintenance self-heals.
    const realNow = Date.now;
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realNow.call(Date) + 8_000);
    try {
      await expect(recovering).resolves.toBeUndefined();
    } finally {
      clock.mockRestore();
    }
    expect(store.metrics).toMatchObject({
      waitingAppends: 0,
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

  it("waits out a transient trim fault in the batch preflight too", async () => {
    // The preflight the reconnecting connection runs before a multi-frame
    // publication parked only on capacity, so it rethrew the very trim fault
    // append() waits out. maxBatchSizeBytes defaults to the segment size for
    // every sf_dir producer, so a flush large enough to split then failed on a
    // filesystem hiccup that an identical smaller flush absorbed -- and with
    // an error that is neither journal exhaustion nor an append deadline.
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

    const unlink = vi
      .spyOn(qwpSegmentMaintenanceWorker, "unlink")
      .mockRejectedValueOnce(
        Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        }),
      );
    await store.acknowledgeThrough(0n);
    await vi.waitFor(() => expect(unlink).toHaveBeenCalled());

    await expect(
      store.prepareAppendBatch([Uint8Array.of(3)]),
    ).resolves.toBeUndefined();
    expect(store.metrics).toMatchObject({ totalAppendTimeouts: 0 });

    unlink.mockRestore();
    await store.close();
  }, 15_000);

  it("waits out a transient trim fault on the symbol dictionary too", async () => {
    // The dictionary writes went straight to assertReady(), so one parked trim
    // fault rejected exactly the flushes that introduced a new symbol value
    // while every other flush in the same window was parked and succeeded a
    // moment later. That reached at()/atNow(), not only an explicit flush(),
    // with an error that is neither journal exhaustion nor an append deadline
    // -- and the ingress connection answered it by disabling delta symbol
    // dictionaries for the rest of the connection's life.
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

    const unlink = vi
      .spyOn(qwpSegmentMaintenanceWorker, "unlink")
      .mockRejectedValueOnce(
        Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        }),
      );
    await store.acknowledgeThrough(0n);
    await vi.waitFor(() => expect(unlink).toHaveBeenCalled());

    // Both dictionary entry points meet the parked failure at assertReady(),
    // exactly where a fresh append meets it, and must wait it out the same way.
    await expect(
      store.appendSymbolDictionary(0, ["new-symbol"]),
    ).resolves.toBeUndefined();
    await expect(store.loadSymbolDictionary()).resolves.toEqual(["new-symbol"]);
    expect(store.metrics).toMatchObject({ totalAppendTimeouts: 0 });

    unlink.mockRestore();
    await store.close();
  }, 15_000);

  it("reports an unprovable lock as retryable rather than as a takeover", async () => {
    // Reading the owner record is the only heartbeat step that needs a
    // descriptor, so descriptor pressure anywhere in the host process fails
    // precisely it while stat() and utimes() keep succeeding. Past the
    // liveness window that used to surface as QwpReplayStoreLockLostError --
    // retryable: false, and claiming a takeover that never happened -- which
    // terminated the ingress session for a fault that heals on its own.
    // Classified retryable, the append parks on it and heals; classified as a
    // takeover it would reject the producer outright. Parking is what proves
    // the classification, since only exhaustion and the append deadline are
    // allowed to surface.
    const directory = await trackedDirectory();
    const store = new QwpNodeFileReplayStore({
      directory,
      appendDeadlineMs: 10_000,
    });
    await store.load();
    await store.append({ frameSequence: 0n, payload: Uint8Array.of(1) });

    const ownerPath = join(directory, ".lock.owner");
    const recordPath = join(ownerPath, "owner");
    const record = await readFile(recordPath, "utf8");
    const untouched = await stat(ownerPath);
    // A directory where the record belongs yields EISDIR for every reader,
    // standing in for a transient fault without a mock.
    await unlink(recordPath);
    await mkdir(recordPath);
    await utimes(ownerPath, untouched.atime, untouched.mtime);

    const internals = store as unknown as {
      slotLock?: { provenAtMs: number };
    };
    internals.slotLock!.provenAtMs = Date.now() - 60_000;

    const parked = store.append({
      frameSequence: 1n,
      payload: Uint8Array.of(2),
    });
    // A takeover would have rejected here instead of stalling.
    await vi.waitFor(() =>
      expect(store.metrics.totalBackpressureStalls).toBeGreaterThanOrEqual(1),
    );

    // The fault clears and the parked append completes, so nothing was lost.
    await rm(recordPath, { recursive: true });
    await writeFile(recordPath, record);
    await utimes(ownerPath, untouched.atime, untouched.mtime);
    await expect(parked).resolves.toBeUndefined();
    expect(store.metrics).toMatchObject({
      pendingRecords: 2,
      totalAppendTimeouts: 0,
    });
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
