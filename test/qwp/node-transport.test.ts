import type { AddressInfo, Socket } from "node:net";
import { createServer as createTcpServer } from "node:net";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectQwpNodeClient,
  connectQwpNodeEgress,
  connectQwpNodeIngress,
  connectQwpNodeWebSocket,
  createQwpNodeSender,
  encodeQwpFrame,
  QWP_EGRESS_CAPABILITY,
  QWP_EGRESS_MESSAGE,
  QWP_SERVER_ROLE,
  QWP_STATUS,
  QWP_UPGRADE_ERROR_KIND,
  QWP_UPGRADE_TIMEOUT_PHASE,
  QwpByteWriter,
  QwpNodeFileReplayStore,
  QwpReplayStoreCorruptionError,
  QwpReplayStoreQuarantinedError,
  QwpUpgradeError,
  writeQwpVarint,
} from "../../src/qwp/node";

function serverInfo(
  role = QWP_SERVER_ROLE.STANDALONE,
  zone?: string,
): Uint8Array {
  const capabilities = zone === undefined ? 0 : QWP_EGRESS_CAPABILITY.ZONE;
  const payload = new QwpByteWriter()
    .writeUint8(QWP_EGRESS_MESSAGE.SERVER_INFO)
    .writeUint8(role)
    .writeBigUint64(1n)
    .writeUint32(capabilities)
    .writeBigInt64(123n)
    .writeUint16(0)
    .writeUint16(0);
  if (zone !== undefined) {
    const encodedZone = new TextEncoder().encode(zone);
    payload.writeUint16(encodedZone.length).writeBytes(encodedZone);
  }
  return encodeQwpFrame(payload.toUint8Array());
}

function writeTable(
  writer: QwpByteWriter,
  name: string,
  sequenceTransaction: bigint,
): void {
  const encoded = new TextEncoder().encode(name);
  writer
    .writeUint16(encoded.length)
    .writeBytes(encoded)
    .writeBigInt64(sequenceTransaction);
}

function okResponse(
  sequence: bigint,
  table: string,
  sequenceTransaction: bigint,
): Uint8Array {
  const writer = new QwpByteWriter()
    .writeUint8(QWP_STATUS.OK)
    .writeBigUint64(sequence)
    .writeUint16(1);
  writeTable(writer, table, sequenceTransaction);
  return writer.toUint8Array();
}

function durableResponse(
  table: string,
  sequenceTransaction: bigint,
): Uint8Array {
  const writer = new QwpByteWriter()
    .writeUint8(QWP_STATUS.DURABLE_ACK)
    .writeUint16(1);
  writeTable(writer, table, sequenceTransaction);
  return writer.toUint8Array();
}

function resultEnd(requestId = 0n): Uint8Array {
  const payload = new QwpByteWriter()
    .writeUint8(QWP_EGRESS_MESSAGE.RESULT_END)
    .writeBigUint64(requestId);
  writeQwpVarint(payload, 0);
  writeQwpVarint(payload, 0);
  return encodeQwpFrame(payload.toUint8Array());
}

describe("QWP Node transport", () => {
  let server: WebSocketServer | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  it("times out authentication separately after a real TCP connection", async () => {
    const sockets = new Set<Socket>();
    const tcpServer = createTcpServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      // Accept the HTTP upgrade request but deliberately never answer it.
      socket.resume();
    });
    await new Promise<void>((resolve, reject) => {
      tcpServer.once("error", reject);
      tcpServer.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = tcpServer.address() as AddressInfo;
      await expect(
        connectQwpNodeWebSocket({
          url: `ws://127.0.0.1:${address.port}/write/v4`,
          connectTimeoutMs: 1_000,
          authTimeoutMs: 25,
          closeTimeoutMs: 25,
        }),
      ).rejects.toMatchObject({
        name: "QwpUpgradeError",
        kind: QWP_UPGRADE_ERROR_KIND.TIMEOUT,
        timeoutPhase: QWP_UPGRADE_TIMEOUT_PHASE.AUTHENTICATION,
        message: "QWP authentication/WebSocket upgrade timed out after 25ms",
      } satisfies Partial<QwpUpgradeError>);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        tcpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("negotiates durable ACK and polls progress with a WebSocket PING", async () => {
    const table = "trades";
    const sequenceTransaction = 7n;
    let requestedDurableAck: string | undefined;
    let pingCount = 0;

    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("headers", (headers) => {
      headers.push("X-QWP-Version: 1");
      headers.push("X-QWP-Max-Batch-Size: 64");
      headers.push("X-QuestDB-Role: primary");
      headers.push("X-QuestDB-Zone: eu-west-1a");
      headers.push("X-QWP-Durable-Ack: enabled");
    });
    server.on("connection", (socket, request) => {
      requestedDurableAck = request.headers["x-qwp-request-durable-ack"];
      socket.once("message", () => {
        socket.send(okResponse(0n, table, sequenceTransaction));
      });
      socket.once("ping", () => {
        pingCount++;
        socket.send(durableResponse(table, sequenceTransaction));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });

    const address = server.address() as AddressInfo;
    const session = await connectQwpNodeIngress(
      {
        url: `ws://127.0.0.1:${address.port}/write/v4`,
        requestDurableAck: true,
      },
      { durableAckKeepaliveMs: 10 },
    );
    try {
      expect(session.handshake).toMatchObject({
        qwpVersion: 1,
        maxBatchSizeBytes: 64,
        durableAckEnabled: true,
        serverRole: "primary",
        serverZone: "eu-west-1a",
      });
      expect(session.maxBatchSizeBytes).toBe(64);
      const ack = await session.sendFrame(Uint8Array.of(1));
      await session.waitForDurable(ack, 1_000);
      expect(requestedDurableAck).toBe("true");
      expect(pingCount).toBe(1);
    } finally {
      await session.close();
    }
  });

  it("surfaces the server-clamped Zstd level from a real upgrade", async () => {
    let acceptEncoding: string | undefined;
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("headers", (headers) => {
      headers.push("X-QWP-Version: 1");
      headers.push("X-QWP-Content-Encoding: zstd;level=9");
    });
    server.on("connection", (socket, request) => {
      acceptEncoding = request.headers["x-qwp-accept-encoding"];
      socket.send(serverInfo());
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });

    const address = server.address() as AddressInfo;
    const session = await connectQwpNodeEgress({
      url: `ws://127.0.0.1:${address.port}/read/v1`,
      compression: "auto",
      compressionLevel: 22,
    });
    try {
      expect(acceptEncoding).toBe("zstd;level=22,raw");
      expect(session.negotiatedCompression).toEqual({
        codec: "zstd",
        level: 9,
      });
      expect(session.negotiatedZstdLevel).toBe(9);
    } finally {
      await session.close();
    }
  });

  it("classifies a real role-rejected HTTP upgrade", async () => {
    server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      verifyClient: (_info, done) => {
        done(false, 421, "Misdirected Request", {
          "X-QuestDB-Role": "PRIMARY_CATCHUP",
          "X-QuestDB-Zone": "eu-west-2",
        });
      },
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });

    const address = server.address() as AddressInfo;
    const connecting = connectQwpNodeWebSocket({
      url: `ws://127.0.0.1:${address.port}/write/v4`,
    });
    const error = await connecting.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "QwpUpgradeError",
      kind: QWP_UPGRADE_ERROR_KIND.ROLE_REJECTED,
      retryable: true,
      tryNextEndpoint: true,
      statusCode: 421,
      serverRole: "PRIMARY_CATCHUP",
      serverZone: "eu-west-2",
      isTopologicalRoleReject: false,
      isTransientRoleReject: true,
    } satisfies Partial<QwpUpgradeError>);
  });

  it("routes egress to the requested role using SERVER_INFO", async () => {
    const primary = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const replica = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    primary.on("connection", (socket) => {
      socket.send(serverInfo(QWP_SERVER_ROLE.PRIMARY, "zone-b"));
    });
    replica.on("connection", (socket) => {
      socket.send(serverInfo(QWP_SERVER_ROLE.REPLICA, "zone-a"));
    });
    await Promise.all([listen(primary), listen(replica)]);

    const primaryAddress = primary.address() as AddressInfo;
    const replicaAddress = replica.address() as AddressInfo;
    const session = await connectQwpNodeEgress({
      url: `ws://127.0.0.1:${primaryAddress.port}/read/v1`,
      failoverUrls: [`ws://127.0.0.1:${replicaAddress.port}/read/v1`],
      target: "replica",
      zone: "ZONE-A",
    });
    try {
      await expect(session.ready).resolves.toMatchObject({
        role: QWP_SERVER_ROLE.REPLICA,
        zoneId: "zone-a",
      });
      expect(session.handshake).toMatchObject({
        serverRole: "REPLICA",
        serverZone: "zone-a",
      });
    } finally {
      await session.close();
      await Promise.all([closeServer(primary), closeServer(replica)]);
    }
  });

  it("combines pooled ingress with concurrent borrowed query connections", async () => {
    const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    endpoint.on("connection", (socket, request) => {
      if (request.url === "/read/v1") {
        socket.send(serverInfo());
        socket.on("message", () => socket.send(resultEnd()));
      } else {
        socket.on("message", () => socket.send(okResponse(0n, "trades", 1n)));
      }
    });
    await listen(endpoint);
    const address = endpoint.address() as AddressInfo;
    const client = await connectQwpNodeClient({
      ingress: {
        url: `ws://127.0.0.1:${address.port}/write/v4`,
      },
      egress: {
        url: `ws://127.0.0.1:${address.port}/read/v1`,
      },
      sender: { autoFlush: false },
      pool: {
        senderPoolMin: 1,
        senderPoolMax: 1,
        queryPoolMin: 1,
        queryPoolMax: 2,
      },
    });
    try {
      const sender = await client.borrowSender();
      await sender.table("trades").symbol("symbol", "ETH-USD").atNow();
      await sender.close();

      const [first, second] = await Promise.all([
        client.borrowQuery(),
        client.borrowQuery(),
      ]);
      try {
        const [firstQuery, secondQuery] = await Promise.all([
          first.query("select 1"),
          second.query("select 2"),
        ]);
        await Promise.all([firstQuery.completion, secondQuery.completion]);
        expect(client.metrics.queries).toMatchObject({
          total: 2,
          leased: 2,
        });
      } finally {
        await Promise.all([first.close(), second.close()]);
      }
    } finally {
      await client.close();
      await closeServer(endpoint);
    }
  });

  it("background-drains an out-of-range pooled slot left by a failed producer", async () => {
    const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    endpoint.on("headers", (headers) => {
      headers.push("X-QWP-Version: 1");
      headers.push("X-QWP-Durable-Ack: enabled");
    });
    const received: Uint8Array[] = [];
    let pingCount = 0;
    endpoint.on("connection", (socket) => {
      let sequence = 0n;
      socket.on("message", (payload) => {
        received.push(new Uint8Array(payload as Buffer));
        socket.send(okResponse(sequence++, "trades", 1n));
      });
      socket.on("ping", () => {
        pingCount++;
        socket.send(durableResponse("trades", 1n));
      });
    });
    await listen(endpoint);
    const address = endpoint.address() as AddressInfo;
    const rootDirectory = await mkdtemp(join(tmpdir(), "qwp-node-pool-"));
    const orphanDirectory = join(rootDirectory, "sender-3");
    const orphan = new QwpNodeFileReplayStore({
      directory: orphanDirectory,
    });
    await orphan.load();
    await orphan.append({
      frameSequence: 0n,
      payload: Uint8Array.of(4, 5, 6),
    });
    await orphan.close();

    const events: string[] = [];
    const client = await connectQwpNodeClient({
      ingress: {
        url: `ws://127.0.0.1:${address.port}/write/v4`,
        requestDurableAck: true,
        storeAndForward: {
          directory: rootDirectory,
          orphanScanIntervalMs: 0,
          onOrphanDrainEvent: (event) => events.push(event.kind),
        },
      },
      ingressSession: { durableAckKeepaliveMs: 10 },
      egress: {
        url: `ws://127.0.0.1:${address.port}/read/v1`,
      },
      pool: {
        senderPoolMin: 1,
        senderPoolMax: 1,
        queryPoolMin: 0,
        queryPoolMax: 1,
      },
    });
    try {
      await vi.waitFor(
        async () => {
          expect(
            (await readdir(orphanDirectory)).filter((name) =>
              name.endsWith(".qwp"),
            ),
          ).toEqual([]);
          expect(events).toContain("drained");
        },
        { timeout: 2_000 },
      );
      expect(received).toContainEqual(Uint8Array.of(4, 5, 6));
      expect(pingCount).toBeGreaterThan(0);
    } finally {
      await client.close();
      await closeServer(endpoint);
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("quarantines a corrupt foreground slot and continues with a fresh producer", async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("headers", (headers) => {
      headers.push("X-QWP-Version: 1");
    });
    server.on("connection", (socket) => {
      socket.on("message", () => socket.send(okResponse(0n, "trades", 1n)));
    });
    await listen(server);

    const rootDirectory = await mkdtemp(join(tmpdir(), "qwp-node-recovery-"));
    const directory = join(rootDirectory, "sender-0");
    const seed = new QwpNodeFileReplayStore({ directory });
    await seed.load();
    await seed.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
    await seed.close();
    const [record] = (await readdir(directory)).filter((name) =>
      name.endsWith(".qwp"),
    );
    await writeFile(join(directory, record), Uint8Array.of(0));

    const events: QwpReplayStoreQuarantinedError[] = [];
    const address = server.address() as AddressInfo;
    try {
      const session = await connectQwpNodeIngress({
        url: `ws://127.0.0.1:${address.port}/write/v4`,
        storeAndForward: {
          directory,
          initialConnectMode: "sync",
          onRecoveryQuarantine: (event) => events.push(event.error),
        },
      });
      try {
        await expect(
          session.sendFrame(Uint8Array.of(2)),
        ).resolves.toMatchObject({ sequence: 0n });
      } finally {
        await session.close();
      }

      const quarantineDirectory = join(
        rootDirectory,
        "sender-0.unreplayable-0",
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(QwpReplayStoreQuarantinedError);
      expect(events[0].cause).toBeInstanceOf(QwpReplayStoreCorruptionError);
      expect(events[0].quarantineDirectory).toBe(quarantineDirectory);
      expect(await readdir(quarantineDirectory)).toEqual(
        expect.arrayContaining([record, ".qwp.failed"]),
      );
      expect(
        (await readdir(directory)).filter((name) => name.endsWith(".qwp")),
      ).toEqual([]);
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("fails over and replays an unacknowledged frame through the public Node API", async () => {
    const primary = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const secondary = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const directory = await mkdtemp(join(tmpdir(), "qwp-node-failover-"));
    const primaryFrames: Uint8Array[] = [];
    const secondaryFrames: Uint8Array[] = [];
    for (const endpoint of [primary, secondary]) {
      endpoint.on("headers", (headers) => {
        headers.push("X-QWP-Version: 1");
      });
    }
    primary.on("connection", (socket) => {
      socket.once("message", (payload) => {
        primaryFrames.push(new Uint8Array(payload as Buffer));
        socket.terminate();
      });
    });
    secondary.on("connection", (socket) => {
      socket.once("message", (payload) => {
        secondaryFrames.push(new Uint8Array(payload as Buffer));
        socket.send(okResponse(0n, "trades", 1n));
      });
    });
    await Promise.all([listen(primary), listen(secondary)]);

    const primaryAddress = primary.address() as AddressInfo;
    const secondaryAddress = secondary.address() as AddressInfo;
    const session = await connectQwpNodeIngress(
      {
        url: `ws://127.0.0.1:${primaryAddress.port}/write/v4`,
        failoverUrls: [`ws://127.0.0.1:${secondaryAddress.port}/write/v4`],
        storeAndForward: { directory },
      },
      {
        ackTimeoutMs: 2_000,
        reconnect: {
          maxAttempts: 1,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
        },
      },
    );
    try {
      const response = await session.sendFrame(Uint8Array.of(1, 2, 3));
      expect(response).toMatchObject({ status: QWP_STATUS.OK, sequence: 0n });
      expect(primaryFrames).toEqual([Uint8Array.of(1, 2, 3)]);
      expect(secondaryFrames).toEqual([Uint8Array.of(1, 2, 3)]);
    } finally {
      await session.close();
      await Promise.all([closeServer(primary), closeServer(secondary)]);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("publishes through the high-level sender before an endpoint is online", async () => {
    const reservation = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await listen(reservation);
    const port = (reservation.address() as AddressInfo).port;
    await closeServer(reservation);
    const directory = await mkdtemp(join(tmpdir(), "qwp-node-offline-"));
    const sender = createQwpNodeSender(
      {
        url: `ws://127.0.0.1:${port}/write/v4`,
        connectTimeoutMs: 100,
        storeAndForward: { directory },
      },
      { autoFlush: false },
      {
        reconnect: {
          initialBackoffMs: 10,
          maxBackoffMs: 10,
        },
      },
    );

    try {
      await expect(sender.connect()).resolves.toBe(true);
      await sender.table("trades").symbol("symbol", "ETH-USD").atNow();
      await expect(sender.flush()).resolves.toBe(true);
      expect(
        (await readdir(directory)).filter((name) => name.endsWith(".qwp")),
      ).toHaveLength(1);

      server = new WebSocketServer({ host: "127.0.0.1", port });
      server.on("headers", (headers) => {
        headers.push("X-QWP-Version: 1");
      });
      server.on("connection", (socket) => {
        let sequence = 0n;
        socket.on("message", () => {
          socket.send(okResponse(sequence++, "trades", 1n));
        });
      });
      await listen(server);

      await vi.waitFor(
        async () =>
          expect(
            (await readdir(directory)).filter((name) => name.endsWith(".qwp")),
          ).toEqual([]),
        { timeout: 2_000 },
      );
    } finally {
      await sender.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function listen(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server.address()) {
      resolve();
      return;
    }
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

function closeServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
