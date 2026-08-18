import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectQwpNodeEgress,
  connectQwpNodeIngress,
  connectQwpNodeWebSocket,
  createQwpNodeSender,
  encodeQwpFrame,
  QWP_EGRESS_MESSAGE,
  QWP_STATUS,
  QWP_UPGRADE_ERROR_KIND,
  QwpByteWriter,
  QwpUpgradeError,
} from "../../src/qwp/node";

function serverInfo(): Uint8Array {
  const payload = new QwpByteWriter()
    .writeUint8(QWP_EGRESS_MESSAGE.SERVER_INFO)
    .writeUint8(0)
    .writeBigUint64(1n)
    .writeUint32(0)
    .writeBigInt64(123n)
    .writeUint16(0)
    .writeUint16(0);
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

describe("QWP Node transport", () => {
  let server: WebSocketServer | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
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
