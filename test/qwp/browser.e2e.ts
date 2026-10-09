import { createServer, Server } from "node:http";
import { readFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import path from "node:path";
import { Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  encodeQwpFrame,
  QWP_COMPRESSION_CODEC,
  QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL,
  QWP_DEFAULT_EGRESS_INITIAL_CREDIT,
  QWP_EGRESS_CAPABILITY,
  QWP_EGRESS_MESSAGE,
  QWP_STATUS,
  QwpByteReader,
  QwpByteWriter,
  readQwpVarint,
  writeQwpVarint,
} from "../../packages/nodejs-client/src";

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function waitForWebSocketServer(server: WebSocketServer): Promise<void> {
  if (server.address()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

// Rooted at the browser package dist/: the entry imports package-local shared
// chunks, so serving only dist/es would 404 every shared-module request.
function createModuleServer(): Server {
  const moduleRoot = path.resolve(
    process.cwd(),
    "packages/browser-client/dist",
  );
  return createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const file = path.resolve(moduleRoot, `.${requestUrl.pathname}`);
      if (!file.startsWith(`${moduleRoot}${path.sep}`)) {
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/javascript; charset=utf-8",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
}

function writeU16String(writer: QwpByteWriter, value: string): void {
  const bytes = new TextEncoder().encode(value);
  writer.writeUint16(bytes.length).writeBytes(bytes);
}

function browserServerInfo(compression?: {
  codec: number;
  level: number;
}): Uint8Array {
  const payload = new QwpByteWriter();
  payload
    .writeUint8(QWP_EGRESS_MESSAGE.SERVER_INFO)
    .writeUint8(0)
    .writeBigUint64(1n)
    .writeUint32(compression ? QWP_EGRESS_CAPABILITY.COMPRESSION : 0)
    .writeBigInt64(0n);
  writeU16String(payload, "browser-test-cluster");
  writeU16String(payload, "browser-test-node");
  if (compression) {
    payload.writeUint8(compression.codec).writeUint8(compression.level);
  }
  return encodeQwpFrame(payload.toUint8Array());
}

function browserIngressServerInfo(
  maxBatchSizeBytes: number,
  durableAckEnabled = false,
): Uint8Array {
  return new QwpByteWriter()
    .writeUint8(QWP_STATUS.SERVER_INFO)
    .writeUint32(maxBatchSizeBytes)
    .writeUint8(durableAckEnabled ? 0x01 : 0x00)
    .toUint8Array();
}

function browserEmptyResultBatch(requestId: bigint): Uint8Array {
  const payload = new QwpByteWriter();
  payload.writeUint8(QWP_EGRESS_MESSAGE.RESULT_BATCH).writeBigUint64(requestId);
  writeQwpVarint(payload, 0); // batch sequence
  writeQwpVarint(payload, 0); // table name
  writeQwpVarint(payload, 0); // row count
  writeQwpVarint(payload, 0); // column count
  return encodeQwpFrame(payload.toUint8Array(), 0, 1);
}

function browserResultEnd(
  requestId: bigint,
  finalSequence = 0n,
  totalRows = 0n,
): Uint8Array {
  const payload = new QwpByteWriter();
  payload.writeUint8(QWP_EGRESS_MESSAGE.RESULT_END).writeBigUint64(requestId);
  writeQwpVarint(payload, finalSequence);
  writeQwpVarint(payload, totalRows);
  return encodeQwpFrame(payload.toUint8Array());
}

const QWP_V1_PROTOCOL = "questdb.qwp.v1";
const CREDENTIAL_PREFIX = "questdb.qwp.authorization.";

/**
 * Decodes the credentials in a subprotocol offer by QuestDB's rules --
 * unpadded canonical base64url of printable ASCII that neither starts nor ends
 * with a space -- and returns their Authorization values.
 */
function offeredAuthorizations(protocols: ReadonlySet<string>): string[] {
  return [...protocols]
    .filter((protocol) => protocol.startsWith(CREDENTIAL_PREFIX))
    .map((protocol) => {
      const encoded = protocol.slice(CREDENTIAL_PREFIX.length);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(encoded.length % 4).not.toBe(1);
      const decoded = Buffer.from(encoded, "base64url");
      expect(decoded.toString("base64url")).toBe(encoded);
      const value = decoded.toString("latin1");
      expect(value).toMatch(/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/);
      return value;
    });
}

function browserCancelled(requestId: bigint): Uint8Array {
  const message = new TextEncoder().encode("cancelled by client deadline");
  const payload = new QwpByteWriter();
  payload
    .writeUint8(QWP_EGRESS_MESSAGE.QUERY_ERROR)
    .writeBigUint64(requestId)
    .writeUint8(QWP_STATUS.CANCELLED)
    .writeUint16(message.length)
    .writeBytes(message);
  return encodeQwpFrame(payload.toUint8Array());
}

describe("QWP in a real browser", () => {
  let assetServer: Server;
  let assetUrl: string;
  let browser: Browser;

  beforeAll(async () => {
    assetServer = createModuleServer();
    await listen(assetServer);
    const address = assetServer.address() as AddressInfo;
    assetUrl = `http://127.0.0.1:${address.port}/es/index.mjs`;

    browser = await chromium.launch({
      channel: process.env.QWP_BROWSER_CHANNEL,
      executablePath: process.env.QWP_BROWSER_EXECUTABLE_PATH,
      headless: true,
    });
  });

  afterAll(async () => {
    await browser?.close();
    if (assetServer) await close(assetServer);
  });

  it("decompresses Zstd and reuses row views in the browser bundle", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(assetUrl);
      const result = await page.evaluate(async (moduleUrl) => {
        const importModule = new Function("url", "return import(url)") as (
          url: string,
        ) => Promise<Record<string, any>>;
        const qwp = await importModule(moduleUrl);
        const compressedBody = Uint8Array.from([
          40, 181, 47, 253, 96, 153, 0, 157, 0, 0, 96, 0, 0, 0, 100, 1, 1, 120,
          4, 0, 42, 0, 0, 1, 0, 138, 171, 46, 9,
        ]);
        const payload = new qwp.QwpByteWriter()
          .writeUint8(qwp.QWP_EGRESS_MESSAGE.RESULT_BATCH)
          .writeBigUint64(7n);
        qwp.writeQwpVarint(payload, 0);
        payload.writeBytes(compressedBody);
        const frame = qwp.encodeQwpFrame(
          payload.toUint8Array(),
          qwp.QWP_FLAG_DELTA_SYMBOL_DICTIONARY | qwp.QWP_FLAG_ZSTD,
          1,
        );
        const message = qwp.decodeQwpEgressMessage(frame);
        const batch = new qwp.QwpResultBatchDecoder().decodeView(message);
        let sharedRow: any;
        let reusesRow = true;
        let visits = 0;
        batch.forEachRow((row: any) => {
          sharedRow ??= row;
          reusesRow &&= sharedRow === row;
          visits++;
        });
        const lastRow = batch.row(99);
        return {
          requestId: String(batch.requestId),
          rowCount: batch.rowCount,
          lastValue: lastRow.getInt(0),
          lastRowIndex: lastRow.rowIndex,
          reusesRow,
          rowViewExported: lastRow instanceof qwp.QwpResultRowView,
          visits,
        };
      }, assetUrl);

      expect(result).toEqual({
        requestId: "7",
        rowCount: 100,
        lastValue: 42,
        lastRowIndex: 99,
        reusesRow: true,
        rowViewExported: true,
        visits: 100,
      });
    } finally {
      await page.close();
    }
  });

  it("negotiates durable ACKs through the real browser WebSocket API", async () => {
    const offeredProtocols: string[] = [];
    let requestedPath: string | undefined;
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      handleProtocols: (protocols) => {
        offeredProtocols.push(...protocols);
        return protocols.has(QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL)
          ? QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL
          : false;
      },
    });
    server.on("connection", (socket, request) => {
      requestedPath = request.url;
      // The echoed subprotocol only confirms the server speaks the browser
      // negotiation; the capability bit on this frame is the durable-ACK
      // verdict itself, so a server with durable ACK on must set it.
      socket.send(browserIngressServerInfo(1_048_576, true));
    });
    await waitForWebSocketServer(server);
    const address = server.address() as AddressInfo;
    const page = await browser.newPage();
    try {
      await page.goto(assetUrl);
      const result = await page.evaluate(
        async ({ moduleUrl, url }) => {
          const importModule = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<Record<string, any>>;
          const qwp = await importModule(moduleUrl);
          const connection = await qwp.connectQwpBrowserIngress({
            url,
            requestDurableAck: true,
          });
          try {
            return connection.handshake;
          } finally {
            await connection.close();
          }
        },
        {
          moduleUrl: assetUrl,
          url: `ws://127.0.0.1:${address.port}/write/v4`,
        },
      );

      expect(offeredProtocols).toContain(QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL);
      expect(
        new URL(requestedPath!, "http://localhost").searchParams.get(
          "qwp_browser_handshake",
        ),
      ).toBe("v1");
      expect(result).toEqual({
        qwpVersion: 1,
        durableAckEnabled: true,
        maxBatchSizeBytes: 1_048_576,
      });
    } finally {
      await page.close();
      await closeWebSocketServer(server);
    }
  });

  it("authenticates a cross-origin page through the credential subprotocol", async () => {
    // The page is served from another port, so every upgrade below is a
    // cross-origin one: the third-party application this path exists for.
    // A JWT-sized token checks that the browser accepts a long subprotocol.
    const token = `eyJ${"a".repeat(1_200)}.eyJ${"b".repeat(600)}.${"c".repeat(342)}`;
    const upgrades: {
      path: string;
      origin?: string;
      authorizations: string[];
      selected: string | false;
    }[] = [];
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      // QuestDB's selection: durable ACK when offered on ingress, otherwise
      // questdb.qwp.v1, never the credential.
      handleProtocols: (protocols, request) => {
        const path = new URL(request.url!, "http://localhost").pathname;
        const selected =
          path.endsWith("/write/v4") &&
          protocols.has(QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL)
            ? QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL
            : protocols.has(QWP_V1_PROTOCOL)
              ? QWP_V1_PROTOCOL
              : false;
        upgrades.push({
          path,
          origin: request.headers.origin,
          authorizations: offeredAuthorizations(protocols),
          selected,
        });
        return selected;
      },
    });
    server.on("connection", (socket, request) => {
      socket.send(
        request.url!.startsWith("/read/v1")
          ? browserServerInfo()
          : browserIngressServerInfo(1_048_576, true),
      );
    });
    await waitForWebSocketServer(server);
    const address = server.address() as AddressInfo;
    const page = await browser.newPage();
    try {
      await page.goto(assetUrl);
      const result = await page.evaluate(
        async ({ moduleUrl, url, token }) => {
          const importModule = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<Record<string, any>>;
          const qwp = await importModule(moduleUrl);
          let providerCalls = 0;
          let signalsAreAbortSignals = true;
          const client = await qwp.connectQwpBrowserClient({
            cluster: {
              url,
              auth: async ({ signal }: { signal: AbortSignal }) => {
                providerCalls++;
                signalsAreAbortSignals &&= signal instanceof AbortSignal;
                return { type: "bearer", token };
              },
            },
            ingress: { requestDurableAck: true },
          });
          try {
            return { providerCalls, signalsAreAbortSignals };
          } finally {
            await client.close();
          }
        },
        {
          moduleUrl: assetUrl,
          url: `ws://127.0.0.1:${address.port}`,
          token,
        },
      );

      expect(result).toEqual({
        providerCalls: 2,
        signalsAreAbortSignals: true,
      });
      const pageOrigin = new URL(assetUrl).origin;
      expect(
        upgrades.sort((left, right) => left.path.localeCompare(right.path)),
      ).toEqual([
        {
          path: "/read/v1",
          origin: pageOrigin,
          authorizations: [`Bearer ${token}`],
          selected: QWP_V1_PROTOCOL,
        },
        {
          path: "/write/v4",
          origin: pageOrigin,
          authorizations: [`Bearer ${token}`],
          selected: QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL,
        },
      ]);
    } finally {
      await page.close();
      await closeWebSocketServer(server);
    }
  });

  it("refuses a server that echoes the credential, in a real browser", async () => {
    // The credential is in the offer, so a browser accepts a 101 that selects
    // it; only the client's own check stands between that and an open session.
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      handleProtocols: (protocols) =>
        [...protocols].find((protocol) =>
          protocol.startsWith(CREDENTIAL_PREFIX),
        ) ?? false,
    });
    let connections = 0;
    server.on("connection", (socket) => {
      connections++;
      socket.send(browserServerInfo());
    });
    await waitForWebSocketServer(server);
    const address = server.address() as AddressInfo;
    const page = await browser.newPage();
    try {
      await page.goto(assetUrl);
      const result = await page.evaluate(
        async ({ moduleUrl, url }) => {
          const importModule = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<Record<string, any>>;
          const qwp = await importModule(moduleUrl);
          try {
            const session = await qwp.connectQwpBrowserEgress({
              url,
              auth: { type: "bearer", token: "echoed-secret" },
            });
            await session.close();
            return { connected: true };
          } catch (error) {
            const failure = error as Record<string, unknown>;
            return {
              name: failure.name,
              kind: failure.kind,
              retryable: failure.retryable,
              tryNextEndpoint: failure.tryNextEndpoint,
            };
          }
        },
        {
          moduleUrl: assetUrl,
          url: `ws://127.0.0.1:${address.port}/read/v1`,
        },
      );

      expect(connections).toBe(1);
      expect(result).toEqual({
        name: "QwpUpgradeError",
        kind: "capability-mismatch",
        retryable: false,
        tryNextEndpoint: false,
      });
    } finally {
      await page.close();
      await closeWebSocketServer(server);
    }
  });

  it("walks failoverUrls when the preferred endpoint refuses, in a real browser", async () => {
    // A browser never sees the HTTP response, so a refused connection surfaces
    // as a bare error event that openQwpWebSocket classifies `opaque` with
    // tryNextEndpoint left undefined. The fake-socket coverage in
    // session.test.ts can only approximate that shape; this drives real
    // Chromium at a genuinely refused port so the classification is the
    // browser's own, which is what the previous failover coverage could not do
    // -- it injected a factory throw carrying tryNextEndpoint: true, which no
    // real browser WebSocket produces.
    const healthy = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let healthyConnections = 0;
    healthy.on("connection", (socket) => {
      healthyConnections++;
      socket.send(browserIngressServerInfo(1_048_576));
    });
    await waitForWebSocketServer(healthy);
    const healthyPort = (healthy.address() as AddressInfo).port;

    // Bind and release a port so the preferred endpoint reliably refuses.
    const vacated = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await waitForWebSocketServer(vacated);
    const refusedPort = (vacated.address() as AddressInfo).port;
    await closeWebSocketServer(vacated);

    const page = await browser.newPage();
    try {
      await page.goto(assetUrl);
      const handshake = await page.evaluate(
        async ({ moduleUrl, url, failoverUrls }) => {
          const importModule = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<Record<string, any>>;
          const qwp = await importModule(moduleUrl);
          const connection = await qwp.connectQwpBrowserIngress({
            url,
            failoverUrls,
          });
          try {
            return connection.handshake;
          } finally {
            await connection.close();
          }
        },
        {
          moduleUrl: assetUrl,
          url: `ws://127.0.0.1:${refusedPort}/write/v4`,
          failoverUrls: [`ws://127.0.0.1:${healthyPort}/write/v4`],
        },
      );

      // The sweep reached the secondary rather than stopping at the refusal.
      expect(healthyConnections).toBe(1);
      expect(handshake).toMatchObject({ qwpVersion: 1 });
    } finally {
      await page.close();
      await closeWebSocketServer(healthy);
    }
  });

  it("falls back to raw when an older egress server ignores compression", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket) => socket.send(browserServerInfo()));
    await waitForWebSocketServer(server);
    const address = server.address() as AddressInfo;
    const page = await browser.newPage();
    try {
      await page.goto(assetUrl);
      const result = await page.evaluate(
        async ({ moduleUrl, url }) => {
          const importModule = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<Record<string, any>>;
          const qwp = await importModule(moduleUrl);
          const session = await qwp.connectQwpBrowserEgress({
            url,
            compression: "zstd",
            compressionLevel: 7,
            maxBatchRows: 512,
          });
          try {
            return session.negotiatedCompression;
          } finally {
            await session.close();
          }
        },
        {
          moduleUrl: assetUrl,
          url: `ws://127.0.0.1:${address.port}/read/v1`,
        },
      );

      expect(result).toEqual({ codec: "raw", level: 0 });
    } finally {
      await page.close();
      await closeWebSocketServer(server);
    }
  });

  it("omits resetDictionary for an older egress server in a real browser", async () => {
    let requestPayload: Uint8Array | undefined;
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket) => {
      socket.send(browserServerInfo());
      socket.on("message", (data) => {
        requestPayload = new Uint8Array(data as Buffer).slice();
        const reader = new QwpByteReader(requestPayload);
        expect(reader.readUint8()).toBe(QWP_EGRESS_MESSAGE.QUERY_REQUEST);
        socket.send(browserResultEnd(reader.readBigUint64()));
      });
    });
    await waitForWebSocketServer(server);
    const address = server.address() as AddressInfo;
    const page = await browser.newPage();
    try {
      await page.goto(assetUrl);
      await page.evaluate(
        async ({ moduleUrl, url }) => {
          const importModule = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<Record<string, any>>;
          const qwp = await importModule(moduleUrl);
          const session = await qwp.connectQwpBrowserEgress({ url });
          try {
            const query = await session.query("select 1", {
              resetDictionary: true,
            });
            await query.completion;
          } finally {
            await session.close();
          }
        },
        {
          moduleUrl: assetUrl,
          url: `ws://127.0.0.1:${address.port}/read/v1`,
        },
      );

      const request = new QwpByteReader(requestPayload!);
      expect(request.readUint8()).toBe(QWP_EGRESS_MESSAGE.QUERY_REQUEST);
      expect(request.readBigUint64()).toBe(0n);
      const sqlLength = Number(readQwpVarint(request));
      expect(request.readUtf8(sqlLength)).toBe("select 1");
      expect(readQwpVarint(request)).toBe(
        BigInt(QWP_DEFAULT_EGRESS_INITIAL_CREDIT),
      );
      expect(readQwpVarint(request)).toBe(0n);
      expect(request.remaining).toBe(0);
    } finally {
      await page.close();
      await closeWebSocketServer(server);
    }
  });

  it("falls back cleanly when an older ingress server sends no cap", async () => {
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
    });
    await waitForWebSocketServer(server);
    const address = server.address() as AddressInfo;
    const page = await browser.newPage();
    try {
      await page.goto(assetUrl);
      const result = await page.evaluate(
        async ({ moduleUrl, url }) => {
          const importModule = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<Record<string, any>>;
          const qwp = await importModule(moduleUrl);
          const connection = await qwp.connectQwpBrowserIngress({
            url,
            ingressNegotiationTimeoutMs: 10,
          });
          try {
            return connection.handshake;
          } finally {
            await connection.close();
          }
        },
        {
          moduleUrl: assetUrl,
          url: `ws://127.0.0.1:${address.port}/write/v4`,
        },
      );

      expect(result).toEqual({ qwpVersion: 1 });
    } finally {
      await page.close();
      await closeWebSocketServer(server);
    }
  });

  it("negotiates Zstd through the real browser WebSocket API", async () => {
    let requestedPath: string | undefined;
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
    });
    server.on("connection", (socket, request) => {
      requestedPath = request.url;
      socket.send(
        browserServerInfo({ codec: QWP_COMPRESSION_CODEC.ZSTD, level: 3 }),
      );
    });
    await waitForWebSocketServer(server);
    const address = server.address() as AddressInfo;
    const page = await browser.newPage();
    try {
      await page.goto(assetUrl);
      const result = await page.evaluate(
        async ({ moduleUrl, url }) => {
          const importModule = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<Record<string, any>>;
          const qwp = await importModule(moduleUrl);
          const session = await qwp.connectQwpBrowserEgress({
            url,
            compression: "zstd",
            compressionLevel: 7,
            maxBatchRows: 512,
          });
          try {
            return {
              compression: session.negotiatedCompression,
              level: session.negotiatedZstdLevel,
            };
          } finally {
            await session.close();
          }
        },
        {
          moduleUrl: assetUrl,
          url: `ws://127.0.0.1:${address.port}/read/v1`,
        },
      );

      expect(
        new URL(requestedPath!, "http://localhost").searchParams.get(
          "qwp_accept_encoding",
        ),
      ).toBe("zstd;level=7,raw");
      expect(
        new URL(requestedPath!, "http://localhost").searchParams.get(
          "qwp_max_batch_rows",
        ),
      ).toBe("512");
      expect(result).toEqual({
        compression: { codec: "zstd", level: 3 },
        level: 3,
      });
    } finally {
      await page.close();
      await closeWebSocketServer(server);
    }
  });

  it("replenishes egress credit and cancels deadlines in a real browser", async () => {
    const received: Uint8Array[] = [];
    const resultBatch = browserEmptyResultBatch(0n);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket) => {
      socket.send(browserServerInfo());
      socket.on("message", (data) => {
        const payload = new Uint8Array(data as Buffer).slice();
        received.push(payload);
        const reader = new QwpByteReader(payload);
        const kind = reader.readUint8();
        const requestId = reader.readBigUint64();
        if (kind === QWP_EGRESS_MESSAGE.QUERY_REQUEST && requestId === 0n) {
          socket.send(resultBatch);
        } else if (kind === QWP_EGRESS_MESSAGE.CREDIT && requestId === 0n) {
          // One batch was sent, and RESULT_END carries the sequence of the last
          // batch, so this stream ends at batch 0.
          socket.send(browserResultEnd(requestId, 0n));
        } else if (kind === QWP_EGRESS_MESSAGE.CANCEL && requestId === 1n) {
          socket.send(browserCancelled(requestId));
        }
      });
    });
    await waitForWebSocketServer(server);
    const address = server.address() as AddressInfo;
    const page = await browser.newPage();
    try {
      await page.goto(assetUrl);
      const result = await page.evaluate(
        async ({ moduleUrl, url }) => {
          const importModule = new Function("url", "return import(url)") as (
            url: string,
          ) => Promise<Record<string, any>>;
          const qwp = await importModule(moduleUrl);
          const session = await qwp.connectQwpBrowserEgress(
            { url },
            { queryTimeoutMs: 25 },
          );
          try {
            const flowing = await session.query("select 1", {
              initialCredit: 1,
            });
            const iterator = flowing[Symbol.asyncIterator]();
            const batch = await iterator.next();
            const done = await iterator.next();
            await flowing.completion;

            const expiring = await session.query("select sleep(1000)");
            let timeout: {
              name?: string;
              requestId?: string;
              timeoutMs?: number;
            };
            try {
              await expiring.completion;
              timeout = {};
            } catch (error) {
              const failure = error as {
                name?: string;
                requestId?: bigint;
                timeoutMs?: number;
              };
              timeout = {
                name: failure.name,
                requestId: failure.requestId?.toString(),
                timeoutMs: failure.timeoutMs,
              };
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
            return {
              batchRows: batch.value.rowCount,
              done: done.done,
              timeout,
            };
          } finally {
            await session.close();
          }
        },
        {
          moduleUrl: assetUrl,
          url: `ws://127.0.0.1:${address.port}/read/v1`,
        },
      );

      expect(result).toEqual({
        batchRows: 0,
        done: true,
        timeout: {
          name: "QwpEgressQueryTimeoutError",
          requestId: "1",
          timeoutMs: 25,
        },
      });
      expect(received.map((payload) => payload[0])).toEqual([
        QWP_EGRESS_MESSAGE.QUERY_REQUEST,
        QWP_EGRESS_MESSAGE.CREDIT,
        QWP_EGRESS_MESSAGE.QUERY_REQUEST,
        QWP_EGRESS_MESSAGE.CANCEL,
      ]);
      const credit = new QwpByteReader(received[1]);
      expect(credit.readUint8()).toBe(QWP_EGRESS_MESSAGE.CREDIT);
      expect(credit.readBigUint64()).toBe(0n);
      expect(readQwpVarint(credit)).toBe(BigInt(resultBatch.byteLength));
      const defaultCreditRequest = new QwpByteReader(received[2]);
      expect(defaultCreditRequest.readUint8()).toBe(
        QWP_EGRESS_MESSAGE.QUERY_REQUEST,
      );
      expect(defaultCreditRequest.readBigUint64()).toBe(1n);
      const sqlLength = Number(readQwpVarint(defaultCreditRequest));
      defaultCreditRequest.readBytes(sqlLength);
      expect(readQwpVarint(defaultCreditRequest)).toBe(
        BigInt(QWP_DEFAULT_EGRESS_INITIAL_CREDIT),
      );
    } finally {
      await page.close();
      await closeWebSocketServer(server);
    }
  });
});
