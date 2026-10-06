import type { AddressInfo, Socket } from "node:net";
import { createServer as createTcpServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectQwpNodeClient,
  connectQwpNodeEgress,
  createQwpNodeSender,
  encodeQwpFrame,
  encodeQwpIngressFrame,
  QWP_COLUMN_TYPE,
  QWP_EGRESS_CAPABILITY,
  QWP_EGRESS_MESSAGE,
  QWP_SERVER_ROLE,
  QWP_SENDER_ERROR_CATEGORY,
  QWP_SENDER_ERROR_POLICY,
  QWP_STATUS,
  QWP_UPGRADE_ERROR_KIND,
  QWP_UPGRADE_TIMEOUT_PHASE,
  QwpByteWriter,
  QwpFailoverError,
  QwpReconnectExhaustedError,
  QwpReplayStoreCorruptionError,
  QwpReplayStoreQuarantinedError,
  QwpSymbolDictionary,
  QwpTableBuffer,
  QwpUpgradeError,
  type QwpIngressReconnectOptions,
  type QwpSenderError,
  writeQwpVarint,
} from "../../packages/nodejs-client/src";
// Internal: the package root exports neither the ingress-session factory nor
// the raw WebSocket connector, nor the store-and-forward journal.
import {
  connectQwpNodeIngress,
  connectQwpNodeWebSocket,
} from "../../packages/nodejs-client/src/qwp";
import { QwpNodeFileReplayStore } from "../../packages/nodejs-client/src/qwp-node/file-replay-store";
import { publishAndWait } from "./publish-and-wait";

function serverInfo(
  role: number = QWP_SERVER_ROLE.STANDALONE,
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

describe("QWP Node client identity", () => {
  it("reports the published package version to the server", async () => {
    // QWP.md documents client_id as what identifies this client in server-side
    // diagnostics, and the default is what almost every deployment sends. It
    // was pinned at typescript/1.0.0 while the package shipped 4.2.0, so every
    // release looked identical to the server. Asserted on the wire against the
    // manifest, since nothing else keeps a hardcoded version in step.
    const manifest = JSON.parse(
      await readFile(
        join(import.meta.dirname, "../../packages/nodejs-client/package.json"),
        "utf8",
      ),
    ) as { version: string };

    let clientId: string | undefined;
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    wss.on("headers", (headers) => headers.push("X-QWP-Version: 1"));
    wss.on("connection", (_socket, request) => {
      clientId = request.headers["x-qwp-client-id"] as string | undefined;
    });
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
    const { port } = wss.address() as AddressInfo;

    const connection = await connectQwpNodeWebSocket({
      url: `ws://127.0.0.1:${port}/write/v4`,
    });
    try {
      expect(clientId).toBe(`typescript/${manifest.version}`);
    } finally {
      await connection.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});

describe("QWP Node transport", () => {
  let server: WebSocketServer | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  it("refuses to authenticate with credentials embedded in the endpoint URL", async () => {
    // `ws` turns URL userinfo into an Authorization: Basic header, so this is
    // a live credential -- and it used to be echoed straight back out in
    // QwpFailoverError's message, in every attempts[].endpoint, and on
    // QwpUpgradeError.url, which is what a caller's connect-failure logging
    // writes to disk. The connect-string parser already rejected the same
    // shape.
    const seen: string[] = [];
    const httpServer = createHttpServer((request, response) => {
      seen.push(String(request.headers.authorization ?? "(none)"));
      response.writeHead(500);
      response.end("no");
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });

    try {
      const { port } = httpServer.address() as AddressInfo;
      const secret = "hunter2-do-not-log-me";
      const url = `ws://admin:${secret}@127.0.0.1:${port}/write/v4`;
      const failure = await connectQwpNodeWebSocket({
        url,
        failoverUrls: [url],
      }).then(
        () => undefined,
        (error: unknown) => error as QwpFailoverError,
      );

      // Nothing reached the wire, so no credential was ever presented.
      expect(seen).toEqual([]);
      expect(String(failure?.cause)).toContain("must not carry a password");
      // The aggregate walks every endpoint, so neither its message nor the
      // per-attempt record may carry the secret back to the caller's log.
      expect(failure?.message).not.toContain(secret);
      expect(JSON.stringify(failure?.attempts)).not.toContain(secret);
      // Second line of defence: whatever an endpoint carried, the aggregate
      // failure must not repeat it back.
      const aggregate = await connectQwpNodeWebSocket({
        url: `ws://127.0.0.1:${port}/write/v4`,
        failoverUrls: [`ws://127.0.0.1:${port}/write/v4`],
      }).then(
        () => undefined,
        (error: unknown) => error as QwpFailoverError,
      );
      expect(aggregate?.message).not.toContain(secret);
      expect(JSON.stringify(aggregate?.attempts)).not.toContain(secret);
    } finally {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects an Authorization header combined with the authorization option", async () => {
    // The typed field conflicting with connect-string credentials is rejected
    // "rather than doing either quietly"; the same conflict spelled through
    // the headers escape hatch used to be resolved quietly, and the caller's
    // own header simply never went on the wire.
    const seen: string[] = [];
    const httpServer = createHttpServer((request, response) => {
      seen.push(String(request.headers.authorization ?? "(none)"));
      response.writeHead(500);
      response.end("no");
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });

    try {
      const { port } = httpServer.address() as AddressInfo;
      await expect(
        connectQwpNodeWebSocket({
          url: `ws://127.0.0.1:${port}/write/v4`,
          headers: { Authorization: "Negotiate caller-value" },
          authorization: "Bearer option-value",
        }),
      ).rejects.toThrow(/cannot be combined with the 'authorization' option/);
      expect(seen).toEqual([]);

      // Either one on its own still reaches the server unchanged.
      await connectQwpNodeWebSocket({
        url: `ws://127.0.0.1:${port}/write/v4`,
        headers: { authorization: "Negotiate caller-value" },
      }).catch(() => undefined);
      expect(seen).toEqual(["Negotiate caller-value"]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
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

  it("lets an explicit connect timeout bound the closing handshake too", async () => {
    // Closing is a handshake like opening, and a peer that accepted the
    // upgrade and then stopped reading never answers the close frame, so
    // close() runs to the full closeTimeoutMs default. The pool's own shutdown
    // deadline does not bound it either: the await that fires terminate() runs
    // before that deadline is consumed. A connect string can narrow
    // connect_timeout but has no key for this one, so a caller who asked for a
    // short budget was held for 15s -- 75x, the shape already fixed for the
    // upgrade deadline above.
    const deaf = new Set<Socket>();
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    wss.on("headers", (headers) => headers.push("X-QWP-Version: 1"));
    wss.on("connection", (_socket, request) => {
      deaf.add(request.socket);
      request.socket.pause();
    });
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
    const { port } = wss.address() as AddressInfo;

    try {
      const connection = await connectQwpNodeWebSocket({
        url: `ws://127.0.0.1:${port}/write/v4`,
        connectTimeoutMs: 150,
      });
      const started = Date.now();
      await connection.close();
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      // A paused socket never finishes closing, so the server would wait it out.
      for (const socket of deaf) socket.destroy();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it("lets an explicit connect timeout bound the upgrade too", async () => {
    // Opening a connection is two deadlines, and the upgrade runs under the
    // second one. A caller who set only connectTimeoutMs was therefore held
    // for the undocumented 15s authTimeoutMs default -- 75x the bound they
    // asked for -- whenever a peer accepted TCP and never answered.
    const sockets = new Set<Socket>();
    const tcpServer = createTcpServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.resume();
    });
    await new Promise<void>((resolve, reject) => {
      tcpServer.once("error", reject);
      tcpServer.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = tcpServer.address() as AddressInfo;
      const started = Date.now();
      await expect(
        connectQwpNodeWebSocket({
          url: `ws://127.0.0.1:${address.port}/write/v4`,
          connectTimeoutMs: 40,
          closeTimeoutMs: 25,
        }),
      ).rejects.toMatchObject({
        name: "QwpUpgradeError",
        kind: QWP_UPGRADE_ERROR_KIND.TIMEOUT,
        timeoutPhase: QWP_UPGRADE_TIMEOUT_PHASE.AUTHENTICATION,
        message: "QWP authentication/WebSocket upgrade timed out after 40ms",
      } satisfies Partial<QwpUpgradeError>);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        tcpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("paces durable ACK polls with the keepalive once durable ACK is requested", async () => {
    const table = "trades";
    const sequenceTransaction = 7n;
    let requestedDurableAck: string | string[] | undefined;
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
    const session = await connectQwpNodeIngress({
      url: `ws://127.0.0.1:${address.port}/write/v4`,
      requestDurableAck: true,
      durableAckKeepaliveMs: 10,
    });
    try {
      expect(session.handshake).toMatchObject({
        qwpVersion: 1,
        maxBatchSizeBytes: 64,
        durableAckEnabled: true,
        serverRole: "primary",
        serverZone: "eu-west-1a",
      });
      expect(session.maxBatchSizeBytes).toBe(64);
      // With durable tracking the ACK watermark advances only on durability.
      await expect(
        publishAndWait(session, Uint8Array.of(1), 1_000),
      ).resolves.toBe(0n);
      expect(requestedDurableAck).toBe("true");
      expect(pingCount).toBe(1);
    } finally {
      await session.close();
    }
  });

  it("ignores the keepalive option unless durable ACK is requested", async () => {
    const requestedDurableAck: (string | string[] | undefined)[] = [];
    let pingCount = 0;

    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("headers", (headers) => {
      headers.push("X-QWP-Version: 1");
      // Offered unasked, so only the client's own request can turn on tracking.
      headers.push("X-QWP-Durable-Ack: enabled");
    });
    server.on("connection", (socket, request) => {
      requestedDurableAck.push(request.headers["x-qwp-request-durable-ack"]);
      socket.once("message", () => {
        socket.send(okResponse(0n, "trades", 7n));
      });
      socket.on("ping", () => {
        pingCount++;
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });

    const address = server.address() as AddressInfo;
    // As in the Java and Rust clients, the keepalive alone neither requests
    // durable ACKs nor conflicts with an explicit `false`. Had it reached the
    // session anyway, the capability offered above would hold the ACK
    // watermark for durable progress, and the ordinary OK would not advance it.
    for (const requestDurableAck of [undefined, false]) {
      const session = await connectQwpNodeIngress({
        url: `ws://127.0.0.1:${address.port}/write/v4`,
        requestDurableAck,
        durableAckKeepaliveMs: 10,
      });
      try {
        expect(session.handshake.durableAckEnabled).toBe(true);
        await expect(
          publishAndWait(session, Uint8Array.of(1), 1_000),
        ).resolves.toBe(0n);
      } finally {
        await session.close();
      }
    }
    expect(requestedDurableAck).toEqual([undefined, undefined]);
    expect(pingCount).toBe(0);
  });

  it("still validates a keepalive it ignores", async () => {
    await expect(
      connectQwpNodeIngress({
        url: "ws://127.0.0.1:1/write/v4",
        durableAckKeepaliveMs: -1,
      }),
    ).rejects.toThrow(
      "durableAckKeepaliveMs must be a non-negative finite number",
    );
  });

  it("reports a malformed endpoint URL instead of retrying it", async () => {
    // A URL that does not parse is local configuration, and no reconnect can
    // repair it. It threw before the catch that marks the other configuration
    // rejections non-retryable, so the classifier's fail-open default retried
    // the same parse for the whole configured budget and then replaced the
    // caller's error with a generic exhaustion.
    let webSocketFactoryCalls = 0;
    const started = Date.now();
    await expect(
      connectQwpNodeIngress({
        url: "not an absolute URL",
        webSocketFactory: () => {
          webSocketFactoryCalls++;
          throw new Error("the endpoint must never be dialled");
        },
        reconnect: {
          reconnectInitialBackoffMs: 200,
          reconnectMaxBackoffMs: 200,
          reconnectMaxDurationMs: 5_000,
        },
      }),
    ).rejects.toThrow(/Invalid URL/);
    // No backoff was served, so this is the parse error itself rather than an
    // exhaustion that happens to carry one as its cause.
    expect(Date.now() - started).toBeLessThan(200);
    expect(webSocketFactoryCalls).toBe(0);

    const secret = "malformed-password";
    const error = await connectQwpNodeIngress({
      url: `ws://alice:${secret}@`,
      reconnect: false,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe("Invalid URL");
    expect(Object.keys(error as object)).not.toContain("input");
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("surfaces the server-clamped Zstd level from a real upgrade", async () => {
    let acceptEncoding: string | string[] | undefined;
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
      cluster: { url: `ws://127.0.0.1:${address.port}` },
      ingress: { autoFlush: false },
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
      headers.push("X-QuestDB-Role: PRIMARY");
      headers.push("X-QuestDB-Zone: eu-west-1");
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
    // Pooled slots are `<senderId>-<slot>`, and senderId defaults to `default`.
    const orphanDirectory = join(rootDirectory, "default-3");
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
      cluster: { url: `ws://127.0.0.1:${address.port}` },
      ingress: {
        target: "primary",
        zone: "eu-west-1",
        requestDurableAck: true,
        durableAckKeepaliveMs: 10,
        storeAndForward: {
          directory: rootDirectory,
          orphanScanIntervalMs: 0,
          onOrphanDrainEvent: (event) => events.push(event.kind),
        },
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
          expect(await assignedReplaySegments(orphanDirectory)).toEqual([]);
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

  it("drains a pooled orphan under the durability its producers requested", async () => {
    // The pooled orphan scanner builds its recovery sessions from the same
    // `ingress` options as the foreground senders. An adopted slot that
    // negotiated no durable ACK would let an ordinary OK advance the persisted
    // watermark and trim the journal for rows the caller had asked to keep
    // until they were durable. Losing the server's not-yet-durable write after
    // that leaves nothing to replay.
    const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const durableRequests: (string | undefined)[] = [];
    endpoint.on("headers", (headers, request) => {
      if (request.url?.startsWith("/write/v4")) {
        durableRequests.push(
          request.headers["x-qwp-request-durable-ack"] as string | undefined,
        );
      }
      headers.push("X-QWP-Version: 1");
      headers.push("X-QWP-Durable-Ack: enabled");
    });
    const received: Uint8Array[] = [];
    let releaseDurable: (() => void) | undefined;
    endpoint.on("connection", (socket) => {
      let sequence = 0n;
      socket.on("message", (payload) => {
        received.push(new Uint8Array(payload as Buffer));
        // Ordinary acceptance only. The durable confirmation is withheld until
        // the assertion below has observed that the journal still holds it.
        socket.send(okResponse(sequence++, "trades", 1n));
        releaseDurable = () => socket.send(durableResponse("trades", 1n));
      });
      socket.on("ping", () => releaseDurable?.());
    });
    await listen(endpoint);
    const address = endpoint.address() as AddressInfo;
    const rootDirectory = await mkdtemp(join(tmpdir(), "qwp-node-pool-dur-"));
    const orphanDirectory = join(rootDirectory, "default-3");
    const orphan = new QwpNodeFileReplayStore({ directory: orphanDirectory });
    await orphan.load();
    await orphan.append({ frameSequence: 0n, payload: Uint8Array.of(1, 2, 3) });
    await orphan.close();

    const events: string[] = [];
    const client = await connectQwpNodeClient({
      cluster: { url: `ws://127.0.0.1:${address.port}` },
      ingress: {
        // The only place durability is configured: no durableAckKeepaliveMs.
        requestDurableAck: true,
        storeAndForward: {
          directory: rootDirectory,
          orphanScanIntervalMs: 0,
          onOrphanDrainEvent: (event) => events.push(event.kind),
        },
      },
      pool: {
        senderPoolMin: 1,
        senderPoolMax: 1,
        queryPoolMin: 0,
        queryPoolMax: 1,
      },
    });
    try {
      // The orphan's own upgrade carries the producers' durable request.
      await vi.waitFor(
        () => expect(durableRequests.length).toBeGreaterThan(1),
        {
          timeout: 2_000,
        },
      );
      expect(durableRequests).not.toContain(undefined);

      // Replayed, ordinarily acknowledged -- and still retained, because an
      // ordinary OK is not the acknowledgement this journal was promised.
      await vi.waitFor(
        () => expect(received).toContainEqual(Uint8Array.of(1, 2, 3)),
        { timeout: 2_000 },
      );
      expect(await assignedReplaySegments(orphanDirectory)).not.toEqual([]);
      expect(events).not.toContain("drained");

      releaseDurable?.();
      await vi.waitFor(
        async () => {
          expect(await assignedReplaySegments(orphanDirectory)).toEqual([]);
          expect(events).toContain("drained");
        },
        { timeout: 2_000 },
      );
    } finally {
      await client.close();
      await closeServer(endpoint);
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("recovers an idle in-range SFA slot without prewarming to pool maximum", async () => {
    const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    endpoint.on("headers", (headers) => {
      headers.push("X-QWP-Version: 1");
    });
    const received: Uint8Array[] = [];
    endpoint.on("connection", (socket) => {
      let sequence = 0n;
      socket.on("message", (payload) => {
        received.push(new Uint8Array(payload as Buffer));
        socket.send(okResponse(sequence++, "trades", 1n));
      });
    });
    await listen(endpoint);
    const address = endpoint.address() as AddressInfo;
    const rootDirectory = await mkdtemp(join(tmpdir(), "qwp-node-pool-in-"));
    const idleManagedDirectory = join(rootDirectory, "default-1");
    const idleManaged = new QwpNodeFileReplayStore({
      directory: idleManagedDirectory,
    });
    await idleManaged.load();
    await idleManaged.append({
      frameSequence: 0n,
      payload: Uint8Array.of(7, 8, 9),
    });
    await idleManaged.close();

    const events: string[] = [];
    const client = await connectQwpNodeClient({
      cluster: { url: `ws://127.0.0.1:${address.port}` },
      ingress: {
        storeAndForward: {
          directory: rootDirectory,
          orphanScanIntervalMs: 0,
          onOrphanDrainEvent: (event) => events.push(event.kind),
        },
      },
      pool: {
        senderPoolMin: 1,
        senderPoolMax: 2,
        queryPoolMin: 0,
        queryPoolMax: 1,
      },
    });
    try {
      expect(client.metrics.senders).toMatchObject({
        minimum: 1,
        maximum: 2,
        total: 1,
      });
      await vi.waitFor(
        async () => {
          expect(await assignedReplaySegments(idleManagedDirectory)).toEqual(
            [],
          );
          expect(events).toContain("drained");
        },
        { timeout: 2_000 },
      );
      expect(received).toContainEqual(Uint8Array.of(7, 8, 9));
      expect(client.metrics.senders.total).toBe(1);
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
    // The slot a session opens below its configured directory.
    const directory = join(rootDirectory, "default");
    const seed = new QwpNodeFileReplayStore({ directory });
    await seed.load();
    await seed.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
    await seed.close();
    const [record] = await assignedReplaySegments(directory);
    await writeFile(join(directory, record), Uint8Array.of(0));

    const events: QwpReplayStoreQuarantinedError[] = [];
    const senderErrors: QwpSenderError[] = [];
    const address = server.address() as AddressInfo;
    try {
      const session = await connectQwpNodeIngress({
        url: `ws://127.0.0.1:${address.port}/write/v4`,
        storeAndForward: {
          directory: rootDirectory,
          onRecoveryQuarantine: (event) => {
            events.push(event.error);
            expect(event.senderError.quarantinedPath).toBe(
              event.quarantineDirectory,
            );
          },
        },
        initialConnectMode: "sync",
        onSenderError: (error) => senderErrors.push(error),
      });
      try {
        await expect(publishAndWait(session, Uint8Array.of(2))).resolves.toBe(
          0n,
        );
        // Recovery delivers this one before the session exists, so it cannot
        // pass through the inbox the session owns. The documented counter read
        // zero for it, which is the one data-loss event an operator polling
        // the metrics snapshot most needs to see.
        expect(session.metrics.deliveredErrorNotifications).toBe(1);
      } finally {
        await session.close();
      }

      const quarantineDirectory = join(rootDirectory, "default.unreplayable-0");
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(QwpReplayStoreQuarantinedError);
      expect(events[0].cause).toBeInstanceOf(QwpReplayStoreCorruptionError);
      expect(events[0].quarantineDirectory).toBe(quarantineDirectory);
      expect(senderErrors).toHaveLength(1);
      expect(senderErrors[0]).toMatchObject({
        category: QWP_SENDER_ERROR_CATEGORY.DATA_LOSS,
        appliedPolicy: QWP_SENDER_ERROR_POLICY.ABANDONED,
        quarantinedPath: quarantineDirectory,
      });
      expect(await readdir(quarantineDirectory)).toEqual(
        expect.arrayContaining([record, ".failed"]),
      );
      expect(await assignedReplaySegments(directory)).toEqual([]);
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("skips an ingress endpoint whose role the target excludes", async () => {
    // target and zone reached the egress connection factory only, so ingress
    // matched every role and ranked every endpoint as same-zone: writes landed
    // on whichever endpoint came first in the configuration, replica included.
    const roleServer = async (role: string) => {
      const instance = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      instance.on("headers", (headers) => {
        headers.push("X-QWP-Version: 1");
        headers.push(`X-QuestDB-Role: ${role}`);
      });
      instance.on("connection", (socket) => {
        socket.on("message", () => socket.send(okResponse(0n, "trades", 1n)));
      });
      await listen(instance);
      return instance;
    };
    const replica = await roleServer("REPLICA");
    server = await roleServer("PRIMARY");
    const replicaPort = (replica.address() as AddressInfo).port;
    const primaryPort = (server.address() as AddressInfo).port;

    try {
      // The replica is preferred by configuration order, so only the role
      // check can move the write off it.
      const session = await connectQwpNodeIngress({
        url: `ws://127.0.0.1:${replicaPort}/write/v4`,
        failoverUrls: [`ws://127.0.0.1:${primaryPort}/write/v4`],
        target: "primary",
      });
      try {
        expect(session.handshake.serverRole?.toUpperCase()).toBe("PRIMARY");
        await expect(publishAndWait(session, Uint8Array.of(1))).resolves.toBe(
          0n,
        );
      } finally {
        await session.close();
      }
    } finally {
      await new Promise<void>((resolve) => replica.close(() => resolve()));
    }
  });

  it("accepts an ingress endpoint that declares no role at all", async () => {
    // Ingress reads the role from an upgrade response header, which an older
    // server may not send and a proxy may strip. Egress always learns one from
    // SERVER_INFO, so applying the egress rule unchanged would refuse to write
    // to a node purely for staying silent. A server that does know its role
    // still rejects a misdirected write itself, with a 421.
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("headers", (headers) => {
      headers.push("X-QWP-Version: 1");
    });
    server.on("connection", (socket) => {
      socket.on("message", () => socket.send(okResponse(0n, "trades", 1n)));
    });
    await listen(server);

    const address = server.address() as AddressInfo;
    const session = await connectQwpNodeIngress({
      url: `ws://127.0.0.1:${address.port}/write/v4`,
      target: "primary",
    });
    try {
      await expect(publishAndWait(session, Uint8Array.of(1))).resolves.toBe(0n);
    } finally {
      await session.close();
    }
  });

  it("retries a recoverable slot instead of quarantining it on the first failure", async () => {
    // A power loss between an ACK and the checkpoint that trims the segment it
    // emptied can leave a durable manifest head above the durable watermark,
    // which recovery rejects. Quarantining on the first failure abandoned the
    // whole journal -- yet the failed load's own close() drops the stranded
    // watermark, so a second attempt recovers every frame. The bytes were
    // never lost; only the decision to stop after one try lost them.
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("headers", (headers) => {
      headers.push("X-QWP-Version: 1");
    });
    const delivered: number[] = [];
    server.on("connection", (socket) => {
      socket.on("message", (data: Buffer) => {
        delivered.push(data.byteLength);
        socket.send(okResponse(BigInt(delivered.length - 1), "trades", 1n));
      });
    });
    await listen(server);

    const rootDirectory = await mkdtemp(join(tmpdir(), "qwp-node-retry-"));
    const directory = join(rootDirectory, "default");
    const payload = (value: number) => new Uint8Array(2048).fill(value & 0xff);
    const seed = new QwpNodeFileReplayStore({
      directory,
      maxSegmentBytes: 8192,
    });
    await seed.load();
    for (let sequence = 0n; sequence < 10n; sequence++) {
      await seed.append({ frameSequence: sequence, payload: payload(0) });
    }
    await seed.acknowledgeThrough(1n);
    await vi.waitFor(async () =>
      expect(await readFile(join(directory, ".ack-watermark"))).toBeDefined(),
    );
    // The watermark as it stood before the trim below advanced the manifest.
    const stranded = await readFile(join(directory, ".ack-watermark"));
    for (let sequence = 10n; sequence < 24n; sequence++) {
      await seed.append({ frameSequence: sequence, payload: payload(1) });
    }
    await seed.acknowledgeThrough(17n);
    await vi.waitFor(async () =>
      expect(await assignedReplaySegments(directory)).toHaveLength(2),
    );
    await seed.close();
    // Model the lost page: the manifest and the unlinks reached disk, the
    // watermark that justified them did not.
    await writeFile(join(directory, ".ack-watermark"), stranded);

    const quarantined: QwpReplayStoreQuarantinedError[] = [];
    const senderErrors: QwpSenderError[] = [];
    const address = server.address() as AddressInfo;
    try {
      const session = await connectQwpNodeIngress({
        url: `ws://127.0.0.1:${address.port}/write/v4`,
        storeAndForward: {
          directory: rootDirectory,
          onRecoveryQuarantine: (event) => quarantined.push(event.error),
        },
        initialConnectMode: "sync",
        onSenderError: (error) => senderErrors.push(error),
      });
      await session.close();

      expect(quarantined).toEqual([]);
      expect(senderErrors).toEqual([]);
      // The slot keeps its name: nothing was moved aside for an operator.
      const siblings = await readdir(rootDirectory);
      expect(siblings).toContain("default");
      expect(siblings.filter((name) => name.startsWith("default."))).toEqual(
        [],
      );
      // And the six frames the journal still held were replayed, not dropped.
      expect(delivered.length).toBeGreaterThanOrEqual(6);
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("keeps the ACK watermark when a load fails before it can read the journal", async () => {
    // The sibling test above turns on a failed load's close() dropping a
    // *stranded* watermark. That drop used to be unconditional, and a load
    // that failed for an unrelated reason -- EACCES/EMFILE/EIO/ENOSPC on a
    // segment, all classified retryable -- took the same path: records is
    // empty there because nothing was ever read, not because nothing
    // survives. Dropping the watermark on that reading resurrected every
    // acknowledged frame on the next start, so QuestDB received them twice.
    const rootDirectory = await mkdtemp(join(tmpdir(), "qwp-node-wm-"));
    const directory = join(rootDirectory, "sender-0");
    try {
      const seed = new QwpNodeFileReplayStore({
        directory,
        durability: "append",
      });
      await seed.load();
      for (let sequence = 0n; sequence < 4n; sequence++) {
        await seed.append({
          frameSequence: sequence,
          payload: new Uint8Array(64).fill(0x41),
        });
      }
      await seed.acknowledgeThrough(1n);
      await seed.close();

      const segment = join(directory, "sf-0000000000000000.sfa");
      await chmod(segment, 0o000);
      const failing = new QwpNodeFileReplayStore({ directory });
      await expect(failing.loadReferences()).rejects.toThrow(
        /could not scan QWP store-and-forward segment/,
      );
      await failing.close();
      // The watermark the scan never reached is still there.
      expect(await readdir(directory)).toContain(".ack-watermark");

      await chmod(segment, 0o600);
      const restarted = new QwpNodeFileReplayStore({ directory });
      const recovered = await restarted.loadReferences();
      // Only the two unacknowledged frames replay; 0 and 1 stay acknowledged.
      expect(recovered.map((entry) => entry.frameSequence)).toEqual([2n, 3n]);
      await restarted.close();
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("repairs a corrupt dictionary sidecar instead of quarantining self-contained frames", async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("headers", (headers) => {
      headers.push("X-QWP-Version: 1");
    });
    const received: Uint8Array[] = [];
    server.on("connection", (socket) => {
      socket.on("message", (payload) => {
        received.push(new Uint8Array(payload as Buffer));
      });
    });
    await listen(server);

    const rootDirectory = await mkdtemp(join(tmpdir(), "qwp-node-recovery-"));
    const directory = join(rootDirectory, "default");
    const dictionary = new QwpSymbolDictionary();
    const table = new QwpTableBuffer("trades");
    table
      .getOrCreateColumn("symbol", QWP_COLUMN_TYPE.SYMBOL)!
      .values.push("ETH-USD");
    table.nextRow();
    const replayFrame = encodeQwpIngressFrame([table], {
      dictionary,
      confirmedMaxSymbolId: -1,
    });
    const seed = new QwpNodeFileReplayStore({ directory });
    await seed.load();
    await seed.appendSymbolDictionary(0, dictionary.entriesFrom(0));
    await seed.append({ frameSequence: 0n, payload: replayFrame });
    await seed.close();
    await writeFile(join(directory, ".symbol-dict"), Uint8Array.of(0));

    const quarantined: QwpReplayStoreQuarantinedError[] = [];
    const address = server.address() as AddressInfo;
    try {
      const session = await connectQwpNodeIngress({
        url: `ws://127.0.0.1:${address.port}/write/v4`,
        storeAndForward: {
          directory: rootDirectory,
          onRecoveryQuarantine: (event) => quarantined.push(event.error),
        },
        initialConnectMode: "sync",
      });
      await vi.waitFor(() => expect(received).toHaveLength(2));
      await session.close();

      expect(quarantined).toEqual([]);
      expect((await readdir(rootDirectory)).sort()).toEqual([
        ".slot-locks",
        "default",
      ]);
      const verify = new QwpNodeFileReplayStore({ directory });
      await expect(verify.load()).resolves.toHaveLength(1);
      await expect(verify.loadSymbolDictionary()).resolves.toEqual(["ETH-USD"]);
      await verify.close();
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("infers a store-and-forward startup from the settings that tune retrying", async () => {
    // As in the Java, Rust and Python clients: a reconnect policy that only
    // observes events leaves the first connect a single attempt, while one
    // that tunes retrying makes it retry until reconnectMaxDurationMs runs out.
    let attempts = 0;
    const dropping = createTcpServer((socket) => {
      attempts++;
      socket.destroy();
    });
    await new Promise<void>((resolve) =>
      dropping.listen(0, "127.0.0.1", resolve),
    );
    const port = (dropping.address() as AddressInfo).port;
    const root = await mkdtemp(join(tmpdir(), "qwp-node-sf-startup-"));
    const startup = (
      directory: string,
      reconnect: QwpIngressReconnectOptions,
    ): Promise<unknown> =>
      connectQwpNodeIngress({
        url: `ws://127.0.0.1:${port}/write/v4`,
        storeAndForward: { directory: join(root, directory) },
        reconnect,
      }).then(
        async (session) => {
          await session.close();
          return undefined;
        },
        (reason: unknown) => reason,
      );
    try {
      const observed = await startup("observed", { onEvent: () => undefined });
      expect(observed).toBeInstanceOf(Error);
      expect(observed).not.toBeInstanceOf(QwpReconnectExhaustedError);
      expect(attempts).toBe(1);

      attempts = 0;
      const tuned = await startup("tuned", {
        reconnectMaxDurationMs: 300,
        reconnectInitialBackoffMs: 10,
        reconnectMaxBackoffMs: 10,
      });
      expect(tuned).toBeInstanceOf(QwpReconnectExhaustedError);
      expect(attempts).toBeGreaterThan(1);
    } finally {
      await new Promise<void>((resolve) => dropping.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
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
    const session = await connectQwpNodeIngress({
      url: `ws://127.0.0.1:${primaryAddress.port}/write/v4`,
      failoverUrls: [`ws://127.0.0.1:${secondaryAddress.port}/write/v4`],
      storeAndForward: { directory },
      ackTimeoutMs: 2_000,
      reconnect: { reconnectInitialBackoffMs: 0, reconnectMaxBackoffMs: 0 },
    });
    try {
      await expect(
        publishAndWait(session, Uint8Array.of(1, 2, 3)),
      ).resolves.toBe(0n);
      expect(primaryFrames).toEqual([Uint8Array.of(1, 2, 3)]);
      expect(secondaryFrames).toEqual([Uint8Array.of(1, 2, 3)]);
    } finally {
      await session.close();
      await Promise.all([closeServer(primary), closeServer(secondary)]);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("adopts orphans only below the configured directory", async () => {
    // Sibling adoption scans the parent of the journal directory, which is the
    // configured slot root: QWP.md tells operators to dedicate it. Typed
    // options once journalled into the configured directory itself, so that
    // parent was whatever the application kept next to it -- and the drainer
    // adopted, transmitted and emptied an unrelated neighbour's journal. Every
    // journal is a slot below the configured directory now, as with sf_dir.
    const root = await mkdtemp(join(tmpdir(), "qwp-node-siblings-"));
    const neighbour = join(root, "unrelated-neighbour");
    try {
      const seeded = new QwpNodeFileReplayStore({ directory: neighbour });
      await seeded.load();
      await seeded.append({ frameSequence: 0n, payload: Uint8Array.of(9) });
      await seeded.close();

      const session = await connectQwpNodeIngress({
        url: "ws://127.0.0.1:1/write/v4",
        connectTimeoutMs: 50,
        storeAndForward: {
          directory: join(root, "journal"),
          drainOrphans: true,
          orphanScanIntervalMs: 50,
        },
        initialConnectMode: "async",
      });
      try {
        // Past the point where a scanner rooted at the parent reaches it, and
        // checked while this session is still open: adoption is visible as the
        // neighbour's slot lock being held, before any of its frames move.
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(await readdir(neighbour)).not.toContain(".lock.owner");
        const verify = new QwpNodeFileReplayStore({ directory: neighbour });
        await expect(verify.load()).resolves.toEqual([
          { frameSequence: 0n, payload: Uint8Array.of(9) },
        ]);
        await verify.close();
      } finally {
        await session.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes through the high-level sender before an endpoint is online", async () => {
    const reservation = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await listen(reservation);
    const port = (reservation.address() as AddressInfo).port;
    await closeServer(reservation);
    const directory = await mkdtemp(join(tmpdir(), "qwp-node-offline-"));
    const sender = createQwpNodeSender({
      url: `ws://127.0.0.1:${port}/write/v4`,
      connectTimeoutMs: 100,
      storeAndForward: { directory },
      initialConnectMode: "async",
      autoFlush: false,
      reconnect: {
        reconnectInitialBackoffMs: 10,
        reconnectMaxBackoffMs: 10,
      },
    });

    try {
      await expect(sender.connect()).resolves.toBe(true);
      await sender.table("trades").symbol("symbol", "ETH-USD").atNow();
      await expect(sender.flush()).resolves.toBe(true);
      // The `default` slot, as `sf_dir` without a `sender_id` would use.
      const journal = join(directory, "default");
      expect(await assignedReplaySegments(journal)).toHaveLength(1);
      expect(await assignedReplaySegments(directory)).toEqual([]);

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
        async () => expect(await assignedReplaySegments(journal)).toEqual([]),
        { timeout: 2_000 },
      );
    } finally {
      await sender.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("applies initialConnectMode to a store-and-forward session", async () => {
    // A journal always replays in the background, but its startup policy is
    // still the caller's: the store's own default used to win, so a journal
    // with `initialConnectMode: "async"` still failed fast while offline.
    const reservation = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await listen(reservation);
    const port = (reservation.address() as AddressInfo).port;
    await closeServer(reservation);
    const url = `ws://127.0.0.1:${port}/write/v4`;
    const root = await mkdtemp(join(tmpdir(), "qwp-node-session-mode-"));
    try {
      const session = await connectQwpNodeIngress({
        url,
        connectTimeoutMs: 100,
        storeAndForward: { directory: join(root, "journal") },
        initialConnectMode: "async",
      });
      await session.close();
    } finally {
      await rm(root, { recursive: true, force: true });
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

async function assignedReplaySegments(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith(".sfa"));
}
