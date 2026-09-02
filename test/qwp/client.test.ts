import { describe, expect, it, vi } from "vitest";
import {
  encodeQwpFrame,
  QWP_EGRESS_CAPABILITY,
  QWP_EGRESS_MESSAGE,
  QWP_SERVER_ROLE,
  QWP_STATUS,
  QwpBinaryConnection,
  QwpByteWriter,
  QwpClient,
  QwpClientClosedError,
  QwpConnectionCloseInfo,
  QwpEgressSession,
  QwpEgressSessionClosedError,
  QwpEgressSessionOptions,
  QwpHandshakeMetadata,
  QwpIngressResponse,
  QwpPoolAcquireTimeoutError,
  type QwpPoolSlotReservation,
  QwpSender,
  QwpSenderSession,
  designatedTimestamp,
  long,
  symbol as qwpSymbol,
} from "../../packages/client-core/src/qwp";
import { QwpAsyncQueue } from "../../packages/client-core/src/_qwp/_internal/async-queue";

function writeString(writer: QwpByteWriter, value: string): void {
  const encoded = new TextEncoder().encode(value);
  writer.writeUint16(encoded.length).writeBytes(encoded);
}

function serverInfo(
  nodeId: string,
  options: {
    readonly role?: number;
    readonly clusterId?: string;
    readonly zoneId?: string;
    readonly capabilities?: number;
  } = {},
): Uint8Array {
  const capabilities =
    (options.capabilities ?? 0) |
    (options.zoneId === undefined ? 0 : QWP_EGRESS_CAPABILITY.ZONE);
  const payload = new QwpByteWriter()
    .writeUint8(QWP_EGRESS_MESSAGE.SERVER_INFO)
    .writeUint8(options.role ?? QWP_SERVER_ROLE.STANDALONE)
    .writeBigUint64(1n)
    .writeUint32(capabilities)
    .writeBigInt64(123n);
  writeString(payload, options.clusterId ?? "cluster");
  writeString(payload, nodeId);
  if (options.zoneId !== undefined) writeString(payload, options.zoneId);
  return encodeQwpFrame(payload.toUint8Array());
}

function queryError(requestId: bigint): Uint8Array {
  const payload = new QwpByteWriter()
    .writeUint8(QWP_EGRESS_MESSAGE.QUERY_ERROR)
    .writeBigUint64(requestId)
    .writeUint8(QWP_STATUS.CANCELLED);
  writeString(payload, "cancelled");
  return encodeQwpFrame(payload.toUint8Array());
}

function resultEnd(requestId: bigint): Uint8Array {
  return encodeQwpFrame(
    new QwpByteWriter()
      .writeUint8(QWP_EGRESS_MESSAGE.RESULT_END)
      .writeBigUint64(requestId)
      .writeUint8(0)
      .writeUint8(0)
      .toUint8Array(),
  );
}

class FakeConnection implements QwpBinaryConnection {
  readonly handshake: QwpHandshakeMetadata = { qwpVersion: 1 };
  readonly messages: AsyncIterable<Uint8Array>;
  readonly sent: Uint8Array[] = [];
  closeCount = 0;
  readonly closed: Promise<QwpConnectionCloseInfo>;
  private readonly incoming = new QwpAsyncQueue<Uint8Array>();
  private readonly resolveClosed: (info: QwpConnectionCloseInfo) => void;
  private closedSettled = false;

  constructor(readonly endpoint: string) {
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
    this.closeCount++;
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

class FakeSenderSession implements QwpSenderSession {
  flushes = 0;
  closes = 0;
  publishedFrameSequence = -1n;
  acknowledgedFrameSequence = -1n;

  sendTables(): Promise<QwpIngressResponse> {
    this.flushes++;
    const sequence = ++this.publishedFrameSequence;
    this.acknowledgedFrameSequence = sequence;
    return Promise.resolve({
      status: QWP_STATUS.OK,
      sequence,
      tables: [],
    });
  }

  publishTables(): Promise<void> {
    this.flushes++;
    this.acknowledgedFrameSequence = ++this.publishedFrameSequence;
    return Promise.resolve();
  }

  waitForDurable(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closes++;
    return Promise.resolve();
  }
}

async function createQuerySession(
  slot: number,
  connections: FakeConnection[],
  options: QwpEgressSessionOptions = {},
): Promise<QwpEgressSession> {
  const connection = new FakeConnection(`query-${slot}`);
  connections.push(connection);
  const session = new QwpEgressSession(connection, options);
  connection.receive(serverInfo(`node-${slot}`));
  await session.ready;
  return session;
}

describe("QWP pooled client", () => {
  it("coordinates a pooled sender slot with background recovery", async () => {
    const listeners = new Set<() => void>();
    let recovering = true;
    let reserved = false;
    let creations = 0;
    let releases = 0;
    const reservation: QwpPoolSlotReservation = {
      tryReserve: () => {
        if (recovering || reserved) return false;
        reserved = true;
        return true;
      },
      release: () => {
        reserved = false;
        releases++;
      },
      onAvailable: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const client = new QwpClient(
      {
        senderSlotReservation: reservation,
        createSender: async () => {
          creations++;
          const session = new FakeSenderSession();
          const sender = new QwpSender(async () => session, {
            autoFlush: false,
          });
          await sender.connect();
          return sender;
        },
        createQuerySession: async () => {
          throw new Error("query factory should not run");
        },
      },
      {
        senderPoolMin: 0,
        senderPoolMax: 1,
        queryPoolMin: 0,
        queryPoolMax: 1,
        acquireTimeoutMs: 500,
      },
    );

    const borrowing = client.borrowSender();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(creations).toBe(0);

    recovering = false;
    for (const listener of listeners) listener();
    const sender = await borrowing;
    expect(creations).toBe(1);
    await sender.close();
    expect(releases).toBe(0);
    await client.close();
    expect(releases).toBe(1);
  });

  it("validates idle, lifetime, and housekeeping options", () => {
    const factories = {
      createSender: async () => {
        throw new Error("sender factory should not run");
      },
      createQuerySession: async () => {
        throw new Error("query factory should not run");
      },
    };
    expect(() => new QwpClient(factories, { idleTimeoutMs: -1 })).toThrow(
      "idleTimeoutMs must be a non-negative number",
    );
    expect(
      () => new QwpClient(factories, { maxLifetimeMs: Number.NaN }),
    ).toThrow("maxLifetimeMs must be a non-negative number");
    expect(
      () => new QwpClient(factories, { housekeepingIntervalMs: 99 }),
    ).toThrow("housekeepingIntervalMs must be at least 100");
  });

  it("starts and stops runtime background services exactly once", async () => {
    let starts = 0;
    let closes = 0;
    const client = new QwpClient(
      {
        createSender: async () => {
          throw new Error("sender factory should not run");
        },
        createQuerySession: async () => {
          throw new Error("query factory should not run");
        },
        start: async () => {
          starts++;
        },
        close: async () => {
          closes++;
        },
      },
      {
        senderPoolMin: 0,
        senderPoolMax: 1,
        queryPoolMin: 0,
        queryPoolMax: 1,
      },
    );

    await Promise.all([client.connect(), client.connect()]);
    expect(starts).toBe(1);
    await Promise.all([client.close(), client.close()]);
    expect(closes).toBe(1);
  });

  it("flushes and reuses an exclusively borrowed sender", async () => {
    const senderSessions: FakeSenderSession[] = [];
    let senderCreations = 0;
    const client = new QwpClient(
      {
        createSender: async () => {
          senderCreations++;
          const session = new FakeSenderSession();
          senderSessions.push(session);
          const sender = new QwpSender(async () => session, {
            autoFlush: false,
          });
          await sender.connect();
          return sender;
        },
        createQuerySession: async () => {
          throw new Error("query factory should not run");
        },
      },
      {
        senderPoolMin: 1,
        senderPoolMax: 1,
        queryPoolMin: 0,
        queryPoolMax: 1,
      },
    );
    await client.connect();

    const first = await client.borrowSender();
    await first.table("trades").symbol("symbol", "ETH-USD").atNow();
    const objects = first.writer("objects", { symbol: qwpSymbol() });
    // The lease guard memoizes its wrappers, so method identity is stable.
    expect(objects.row).toBe(objects.row);
    await objects.row({ symbol: "BTC-USD" });
    await first.close();
    expect(senderSessions[0].flushes).toBe(1);
    expect(senderSessions[0].closes).toBe(0);
    expect(() => first.table("late")).toThrow(QwpClientClosedError);
    expect(() => objects.row({ symbol: "late" })).toThrow(QwpClientClosedError);

    const second = await client.borrowSender();
    expect(senderCreations).toBe(1);
    await second.close();
    expect(client.metrics.senders).toMatchObject({
      total: 1,
      available: 1,
      leased: 0,
    });

    await client.close();
    expect(senderSessions[0].closes).toBe(1);
  });

  it("stops an in-flight writer stream when its lease is released", async () => {
    const senderSessions: FakeSenderSession[] = [];
    let senderCreations = 0;
    const client = new QwpClient(
      {
        createSender: async () => {
          senderCreations++;
          const session = new FakeSenderSession();
          senderSessions.push(session);
          const sender = new QwpSender(async () => session, {
            autoFlush: false,
          });
          await sender.connect();
          return sender;
        },
        createQuerySession: async () => {
          throw new Error("query factory should not run");
        },
      },
      {
        senderPoolMin: 1,
        senderPoolMax: 1,
        queryPoolMin: 0,
        queryPoolMax: 1,
      },
    );
    await client.connect();

    const first = await client.borrowSender();
    const events = first.writer("events", {
      value: long(),
      timestamp: designatedTimestamp("ns"),
    });

    let resumeSource!: () => void;
    const suspended = new Promise<void>((resolve) => {
      resumeSource = resolve;
    });
    async function* source() {
      yield { value: 1n, timestamp: 10n };
      await suspended;
      yield { value: 2n, timestamp: 20n };
      yield { value: 3n, timestamp: 30n };
    }

    const inFlight = events.rows(source());
    await new Promise((resolve) => setImmediate(resolve));
    await first.close();
    expect(senderSessions[0].flushes).toBe(1);

    // The pool hands the very same sender to the next borrower.
    const second = await client.borrowSender();
    expect(senderCreations).toBe(1);

    resumeSource();
    await expect(inFlight).rejects.toBeInstanceOf(QwpClientClosedError);

    // Rows yielded after the release must not reach the new lease.
    await second.flush();
    expect(senderSessions[0].flushes).toBe(1);

    await second.close();
    await client.close();
  });

  it("waits for a borrowed sender without closing it underneath its owner", async () => {
    const senderSessions: FakeSenderSession[] = [];
    const client = new QwpClient(
      {
        createSender: async () => {
          const session = new FakeSenderSession();
          senderSessions.push(session);
          const sender = new QwpSender(async () => session, {
            autoFlush: false,
          });
          await sender.connect();
          return sender;
        },
        createQuerySession: async () => {
          throw new Error("query factory should not run");
        },
      },
      {
        senderPoolMin: 0,
        senderPoolMax: 1,
        queryPoolMin: 0,
        queryPoolMax: 1,
        acquireTimeoutMs: 500,
      },
    );
    const sender = await client.borrowSender();
    let closeSettled = false;
    const closing = client.close().then(() => {
      closeSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(closeSettled).toBe(false);
    expect(senderSessions[0].closes).toBe(0);
    await sender.table("trades").symbol("symbol", "ETH-USD").atNow();
    await sender.close();
    await closing;
    expect(senderSessions[0].flushes).toBe(1);
    expect(senderSessions[0].closes).toBe(1);
  });

  it("runs independently borrowed query connections concurrently", async () => {
    const connections: FakeConnection[] = [];
    let queryCreations = 0;
    const client = new QwpClient(
      {
        createSender: async () => {
          throw new Error("sender factory should not run");
        },
        createQuerySession: async (slot) => {
          queryCreations++;
          return createQuerySession(slot, connections);
        },
      },
      {
        senderPoolMin: 0,
        senderPoolMax: 1,
        queryPoolMin: 0,
        queryPoolMax: 2,
        acquireTimeoutMs: 500,
      },
    );

    const [first, second] = await Promise.all([
      client.borrowQuery(),
      client.borrowQuery(),
    ]);
    const [firstInfo, secondInfo] = await Promise.all([
      first.ready,
      second.ready,
    ]);
    expect(new Set([firstInfo.nodeId, secondInfo.nodeId])).toEqual(
      new Set(["node-0", "node-1"]),
    );
    expect(queryCreations).toBe(2);

    let thirdResolved = false;
    const thirdBorrow = client.borrowQuery().then((lease) => {
      thirdResolved = true;
      return lease;
    });
    await Promise.resolve();
    expect(thirdResolved).toBe(false);
    await first.close();
    const third = await thirdBorrow;
    expect(queryCreations).toBe(2);
    expect(client.metrics.queries.leased).toBe(2);

    await Promise.all([second.close(), third.close()]);
    await client.close();
    expect(connections).toHaveLength(2);
  });

  it("exposes immutable server information and refreshes it after failover", async () => {
    const first = new FakeConnection("primary");
    const second = new FakeConnection("replica");
    const connections = [first, second];
    const client = new QwpClient(
      {
        createSender: async () => {
          throw new Error("sender factory should not run");
        },
        createQuerySession: async () =>
          QwpEgressSession.connect(
            async () => {
              const connection = connections.shift();
              if (!connection) throw new Error("no connection available");
              queueMicrotask(() =>
                connection.receive(
                  serverInfo(`node-${connection.endpoint}`, {
                    role:
                      connection === first
                        ? QWP_SERVER_ROLE.PRIMARY
                        : QWP_SERVER_ROLE.REPLICA,
                    zoneId: connection === first ? "zone-a" : "zone-b",
                    capabilities:
                      connection === first
                        ? QWP_EGRESS_CAPABILITY.QUERY_FLAGS
                        : 0,
                  }),
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
          ),
      },
      {
        senderPoolMin: 0,
        senderPoolMax: 1,
        queryPoolMin: 0,
        queryPoolMax: 1,
      },
    );

    const lease = await client.borrowQuery();
    const initial = lease.serverInfo;
    expect(initial).toMatchObject({
      role: QWP_SERVER_ROLE.PRIMARY,
      clusterId: "cluster",
      nodeId: "node-primary",
      zoneId: "zone-a",
      capabilities:
        QWP_EGRESS_CAPABILITY.QUERY_FLAGS | QWP_EGRESS_CAPABILITY.ZONE,
    });
    expect(await lease.ready).toBe(initial);
    expect(Object.isFrozen(initial)).toBe(true);

    const query = await lease.query("select 1");
    first.drop();
    await vi.waitFor(() => expect(second.sent).toHaveLength(1));
    expect(lease.serverInfo).toMatchObject({
      role: QWP_SERVER_ROLE.REPLICA,
      clusterId: "cluster",
      nodeId: "node-replica",
      zoneId: "zone-b",
      capabilities: QWP_EGRESS_CAPABILITY.ZONE,
    });
    expect(lease.serverInfo).not.toBe(initial);
    expect(Object.isFrozen(lease.serverInfo)).toBe(true);

    second.receive(resultEnd(query.requestId));
    await query.completion;
    await lease.close();
    expect(() => lease.serverInfo).toThrow(QwpClientClosedError);
    await client.close();
  });

  it("reaps idle excess connections without shrinking below pool minimums", async () => {
    vi.useFakeTimers();
    try {
      const senderSessions: FakeSenderSession[] = [];
      const connections: FakeConnection[] = [];
      let queryCreations = 0;
      const client = new QwpClient(
        {
          createSender: async () => {
            const session = new FakeSenderSession();
            senderSessions.push(session);
            const sender = new QwpSender(async () => session, {
              autoFlush: false,
            });
            await sender.connect();
            return sender;
          },
          createQuerySession: async (slot) => {
            queryCreations++;
            return createQuerySession(slot, connections);
          },
        },
        {
          senderPoolMin: 0,
          senderPoolMax: 1,
          queryPoolMin: 1,
          queryPoolMax: 2,
          idleTimeoutMs: 200,
          maxLifetimeMs: 0,
          housekeepingIntervalMs: 100,
        },
      );
      await client.connect();

      const sender = await client.borrowSender();
      const [first, second] = await Promise.all([
        client.borrowQuery(),
        client.borrowQuery(),
      ]);
      await Promise.all([sender.close(), first.close(), second.close()]);
      expect(client.metrics).toMatchObject({
        senders: { total: 1, available: 1 },
        queries: { total: 2, available: 2 },
      });

      await vi.advanceTimersByTimeAsync(200);
      expect(client.metrics).toMatchObject({
        senders: { total: 0, available: 0 },
        queries: { total: 1, available: 1 },
      });
      expect(senderSessions[0].closes).toBe(1);
      expect(connections.reduce((sum, item) => sum + item.closeCount, 0)).toBe(
        1,
      );

      const retained = await client.borrowQuery();
      expect(queryCreations).toBe(2);
      await retained.close();
      await client.close();
      expect(connections.reduce((sum, item) => sum + item.closeCount, 0)).toBe(
        2,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("recycles over-age connections after their active lease returns", async () => {
    vi.useFakeTimers();
    try {
      const connections: FakeConnection[] = [];
      let queryCreations = 0;
      const client = new QwpClient(
        {
          createSender: async () => {
            throw new Error("sender factory should not run");
          },
          createQuerySession: async (slot) => {
            queryCreations++;
            return createQuerySession(slot, connections);
          },
        },
        {
          senderPoolMin: 0,
          senderPoolMax: 1,
          queryPoolMin: 0,
          queryPoolMax: 1,
          idleTimeoutMs: 0,
          maxLifetimeMs: 250,
          housekeepingIntervalMs: 100,
        },
      );

      const first = await client.borrowQuery();
      await first.close();
      await vi.advanceTimersByTimeAsync(200);
      const active = await client.borrowQuery();
      expect(queryCreations).toBe(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(connections[0].closeCount).toBe(0);
      await active.close();
      await vi.advanceTimersByTimeAsync(100);
      expect(connections[0].closeCount).toBe(1);
      expect(client.metrics.queries.total).toBe(0);

      const replacement = await client.borrowQuery();
      expect(queryCreations).toBe(2);
      await replacement.close();
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reuse a reaped slot until its teardown completes", async () => {
    vi.useFakeTimers();
    try {
      const connections: FakeConnection[] = [];
      let queryCreations = 0;
      let releaseClose!: () => void;
      const closeReleased = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      const client = new QwpClient(
        {
          createSender: async () => {
            throw new Error("sender factory should not run");
          },
          createQuerySession: async (slot) => {
            queryCreations++;
            const session = await createQuerySession(slot, connections);
            if (queryCreations === 1) {
              const close = session.close.bind(session);
              vi.spyOn(session, "close").mockImplementation(async () => {
                await closeReleased;
                await close();
              });
            }
            return session;
          },
        },
        {
          senderPoolMin: 0,
          senderPoolMax: 1,
          queryPoolMin: 0,
          queryPoolMax: 1,
          acquireTimeoutMs: 1_000,
          idleTimeoutMs: 100,
          maxLifetimeMs: 0,
          housekeepingIntervalMs: 100,
        },
      );

      const first = await client.borrowQuery();
      await first.close();
      await vi.advanceTimersByTimeAsync(100);
      expect(client.metrics.queries.total).toBe(0);

      let replacementResolved = false;
      const borrowing = client.borrowQuery().then((lease) => {
        replacementResolved = true;
        return lease;
      });
      await Promise.resolve();
      expect(replacementResolved).toBe(false);
      expect(queryCreations).toBe(1);

      releaseClose();
      const replacement = await borrowing;
      expect(queryCreations).toBe(2);
      await replacement.close();
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels and closes every borrowed query session during client shutdown", async () => {
    const connections: FakeConnection[] = [];
    const client = new QwpClient(
      {
        createSender: async () => {
          throw new Error("sender factory should not run");
        },
        createQuerySession: (slot) => createQuerySession(slot, connections),
      },
      {
        senderPoolMin: 0,
        senderPoolMax: 1,
        queryPoolMin: 0,
        queryPoolMax: 2,
        acquireTimeoutMs: 10,
      },
    );
    const lease = await client.borrowQuery();
    const idleLease = await client.borrowQuery();
    const query = await lease.query("select 1");
    const completion = expect(query.completion).rejects.toBeInstanceOf(
      QwpEgressSessionClosedError,
    );

    await client.close();
    await completion;
    expect(connections[0].sent).toHaveLength(2);
    expect(connections[0].sent[1][0]).toBe(QWP_EGRESS_MESSAGE.CANCEL);
    expect(connections[0].closeCount).toBe(1);
    expect(connections[1].sent).toHaveLength(0);
    expect(connections[1].closeCount).toBe(1);
    await expect(lease.query("select 2")).rejects.toBeInstanceOf(
      QwpEgressSessionClosedError,
    );
    await expect(idleLease.query("select 3")).rejects.toBeInstanceOf(
      QwpEgressSessionClosedError,
    );
    expect(client.metrics).toMatchObject({
      closing: true,
      closed: true,
      queries: { total: 0, leased: 0 },
    });

    await lease.close();
    await idleLease.close();
    expect(connections[0].closeCount).toBe(1);
    expect(connections[1].closeCount).toBe(1);
  });

  it("runs reusable view queries through a pooled query lease", async () => {
    const connections: FakeConnection[] = [];
    const client = new QwpClient(
      {
        createSender: async () => {
          throw new Error("sender factory should not run");
        },
        createQuerySession: (slot) => createQuerySession(slot, connections),
      },
      {
        senderPoolMin: 0,
        senderPoolMax: 1,
        queryPoolMin: 0,
        queryPoolMax: 1,
      },
    );

    const lease = await client.borrowQuery();
    const query = await lease.queryViews("select 1", () => {
      throw new Error("a RESULT_BATCH was not expected");
    });
    connections[0].receive(resultEnd(query.requestId));
    await expect(query.completion).resolves.toMatchObject({ totalRows: 0n });
    await lease.close();
    expect(client.metrics.queries).toMatchObject({ available: 1, leased: 0 });
    await client.close();
  });

  it("times out when every query connection is leased", async () => {
    const connections: FakeConnection[] = [];
    const client = new QwpClient(
      {
        createSender: async () => {
          throw new Error("sender factory should not run");
        },
        createQuerySession: (slot) => createQuerySession(slot, connections),
      },
      {
        senderPoolMin: 0,
        senderPoolMax: 1,
        queryPoolMin: 0,
        queryPoolMax: 1,
        acquireTimeoutMs: 10,
      },
    );
    const lease = await client.borrowQuery();
    await expect(client.borrowQuery()).rejects.toMatchObject({
      name: "QwpPoolAcquireTimeoutError",
      resource: "query",
      timeoutMs: 10,
    } satisfies Partial<QwpPoolAcquireTimeoutError>);
    await lease.close();
    await client.close();
  });

  it("cancels and drains an active query before returning its connection", async () => {
    const connections: FakeConnection[] = [];
    let queryCreations = 0;
    const client = new QwpClient(
      {
        createSender: async () => {
          throw new Error("sender factory should not run");
        },
        createQuerySession: async (slot) => {
          queryCreations++;
          return createQuerySession(slot, connections);
        },
      },
      {
        senderPoolMin: 0,
        senderPoolMax: 1,
        queryPoolMin: 0,
        queryPoolMax: 1,
        acquireTimeoutMs: 500,
      },
    );
    const lease = await client.borrowQuery();
    const query = await lease.query("select * from long_running()");
    const releasing = lease.close();
    await Promise.resolve();
    expect(client.metrics.queries.leased).toBe(1);
    expect(connections[0].sent).toHaveLength(2);

    connections[0].receive(queryError(query.requestId));
    await releasing;
    const reused = await client.borrowQuery();
    expect(queryCreations).toBe(1);
    await reused.close();
    await client.close();
  });

  it("discards a query connection that cannot drain before lease return", async () => {
    const connections: FakeConnection[] = [];
    let queryCreations = 0;
    const client = new QwpClient(
      {
        createSender: async () => {
          throw new Error("sender factory should not run");
        },
        createQuerySession: async (slot) => {
          queryCreations++;
          return createQuerySession(slot, connections, {
            cancelDrainTimeoutMs: 10,
          });
        },
      },
      {
        senderPoolMin: 0,
        senderPoolMax: 1,
        queryPoolMin: 0,
        queryPoolMax: 1,
        acquireTimeoutMs: 500,
      },
    );
    const lease = await client.borrowQuery();
    await lease.query("select * from never_finishes()");
    await lease.close();
    expect(client.metrics.queries.total).toBe(0);

    const replacement = await client.borrowQuery();
    expect(queryCreations).toBe(2);
    await replacement.close();
    await client.close();
  });
});
