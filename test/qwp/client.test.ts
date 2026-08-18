import { describe, expect, it } from "vitest";
import {
  encodeQwpFrame,
  QWP_EGRESS_MESSAGE,
  QWP_SERVER_ROLE,
  QWP_STATUS,
  QwpBinaryConnection,
  QwpByteWriter,
  QwpClient,
  QwpClientClosedError,
  QwpConnectionCloseInfo,
  QwpEgressSession,
  QwpEgressSessionOptions,
  QwpHandshakeMetadata,
  QwpIngressResponse,
  QwpPoolAcquireTimeoutError,
  QwpSender,
  QwpSenderSession,
} from "../../src/qwp";
import { QwpAsyncQueue } from "../../src/qwp/internal/async-queue";

function writeString(writer: QwpByteWriter, value: string): void {
  const encoded = new TextEncoder().encode(value);
  writer.writeUint16(encoded.length).writeBytes(encoded);
}

function serverInfo(nodeId: string): Uint8Array {
  const payload = new QwpByteWriter()
    .writeUint8(QWP_EGRESS_MESSAGE.SERVER_INFO)
    .writeUint8(QWP_SERVER_ROLE.STANDALONE)
    .writeBigUint64(1n)
    .writeUint32(0)
    .writeBigInt64(123n);
  writeString(payload, "cluster");
  writeString(payload, nodeId);
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
    if (!this.closedSettled) {
      this.closedSettled = true;
      this.incoming.end();
      this.resolveClosed({ code, reason, wasClean: code === 1000 });
    }
    return Promise.resolve();
  }

  receive(payload: Uint8Array): void {
    this.incoming.push(payload);
  }
}

class FakeSenderSession implements QwpSenderSession {
  flushes = 0;
  closes = 0;

  sendTables(): Promise<QwpIngressResponse> {
    this.flushes++;
    return Promise.resolve({
      status: QWP_STATUS.OK,
      sequence: BigInt(this.flushes - 1),
      tables: [],
    });
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
    await first.close();
    expect(senderSessions[0].flushes).toBe(1);
    expect(senderSessions[0].closes).toBe(0);
    expect(() => first.table("late")).toThrow(QwpClientClosedError);

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
