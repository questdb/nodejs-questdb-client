import { mkdtemp, readdir, rm } from "node:fs/promises";
import type { AddressInfo, Socket } from "node:net";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Sender } from "../../src";
import { preloadQwpNode } from "../../src/sender";

// The root Sender lazy-loads the QWP Node subsystem through the package's own
// subpath (the built artifact); against source, warm its cache with the source
// module so the ws:: senders built here run the code under test.
beforeAll(preloadQwpNode);
import {
  QWP_FLAG_DELTA_SYMBOL_DICTIONARY,
  QWP_MAGIC,
  QWP_STATUS,
  QwpByteWriter,
  QwpNodeFileReplayStore,
  decodeQwpIngressSymbolDictionaryDelta,
} from "../../src/qwp/node";

function okResponse(sequence: bigint, table: string): Uint8Array {
  const encodedTable = new TextEncoder().encode(table);
  return new QwpByteWriter()
    .writeUint8(QWP_STATUS.OK)
    .writeBigUint64(sequence)
    .writeUint16(1)
    .writeUint16(encodedTable.length)
    .writeBytes(encodedTable)
    .writeBigInt64(1n)
    .toUint8Array();
}

describe("Sender QWP integration", () => {
  let server: WebSocketServer | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  it("applies fail-fast persistent startup from the configuration string", async () => {
    const reservation = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      reservation.once("listening", resolve);
      reservation.once("error", reject);
    });
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    const directory = await mkdtemp(join(tmpdir(), "qwp-sender-startup-"));
    const sender = await Sender.fromConfig(
      `ws::addr=127.0.0.1:${port};sf_dir=${directory};initial_connect_retry=off`,
      {
        qwp: {
          webSocket: {
            connectTimeoutMs: 100,
          },
          session: {
            reconnect: {
              maxAttempts: 0,
              maxDurationMs: 0,
              initialBackoffMs: 0,
              maxBackoffMs: 0,
            },
          },
        },
      },
    );
    try {
      await expect(sender.connect()).rejects.toThrow();
    } finally {
      await sender.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses ws:: configuration, bearer authentication, and fluent rows", async () => {
    const frames: Uint8Array[] = [];
    let acknowledge: (() => void) | undefined;
    let authorization: string | undefined;
    let requestPath: string | undefined;
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("headers", (headers) => {
      headers.push("X-QWP-Version: 1");
      headers.push("X-QWP-Max-Batch-Size: 1048576");
    });
    server.on("connection", (socket, request) => {
      authorization = request.headers.authorization;
      requestPath = request.url;
      socket.on("message", (payload) => {
        frames.push(new Uint8Array(payload as Buffer));
        acknowledge = () =>
          socket.send(okResponse(BigInt(frames.length - 1), "trades"));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const { port } = server.address() as AddressInfo;

    const sender = await Sender.fromConfig(
      `ws::addr=127.0.0.1:${port};token=secret;auto_flush=off`,
    );
    await sender.connect();
    await sender
      .table("trades")
      .symbol("symbol", "ETH-USD")
      .floatColumn("price", 2_615.54)
      .intColumn("amount", 2)
      .atNow();
    await expect(sender.flushAndGetSequence()).resolves.toBe(0n);
    expect(sender.publishedSequence).toBe(0n);
    expect(sender.acknowledgedSequence).toBe(-1n);
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf("function"));
    const acknowledged = sender.waitForAcknowledged(0n, 1_000);
    acknowledge!();
    await expect(acknowledged).resolves.toBeUndefined();
    expect(sender.acknowledgedSequence).toBe(0n);
    await sender.close();

    expect(authorization).toBe("Bearer secret");
    expect(requestPath).toBe("/write/v4");
    expect(frames).toHaveLength(1);
    expect(frames[0][5] & QWP_FLAG_DELTA_SYMBOL_DICTIONARY).toBe(
      QWP_FLAG_DELTA_SYMBOL_DICTIONARY,
    );
    expect(decodeQwpIngressSymbolDictionaryDelta(frames[0])).toEqual({
      startId: 0,
      entries: ["ETH-USD"],
    });
    expect(
      new DataView(
        frames[0].buffer,
        frames[0].byteOffset,
        frames[0].byteLength,
      ).getUint32(0, true),
    ).toBe(QWP_MAGIC);
  });

  it("uses the unified cluster vocabulary and fails over between addr entries", async () => {
    let authorization: string | undefined;
    let clientId: string | undefined;
    let requestPath: string | undefined;
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("headers", (headers) => {
      headers.push("X-QWP-Version: 1");
      headers.push("X-QWP-Max-Batch-Size: 1048576");
    });
    server.on("connection", (_socket, request) => {
      authorization = request.headers.authorization;
      clientId = request.headers["x-qwp-client-id"] as string | undefined;
      requestPath = request.url;
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const { port } = server.address() as AddressInfo;

    const sender = await Sender.fromConfig(
      "ws::" +
        `addr=127.0.0.1:1,127.0.0.1:${port};` +
        "user=admin;pass=secret;client_id=sender-config-test;" +
        "connect_timeout=250;reconnect_initial_backoff_millis=1;" +
        "reconnect_max_backoff_millis=2;reconnect_max_duration_millis=1000;" +
        "request_durable_ack=off;target=replica;compression=raw;" +
        "sender_pool_min=0;query_pool_min=0;auto_flush=off;",
    );
    try {
      await sender.connect();
      expect(requestPath).toBe("/write/v4");
      expect(clientId).toBe("sender-config-test");
      expect(authorization).toBe(
        `Basic ${Buffer.from("admin:secret", "utf8").toString("base64")}`,
      );
    } finally {
      await sender.close();
    }
  });

  it("honors auto_flush_bytes from the ws:: configuration string", async () => {
    const frames: Uint8Array[] = [];
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("headers", (headers) => {
      headers.push("X-QWP-Version: 1");
      headers.push("X-QWP-Max-Batch-Size: 1048576");
    });
    server.on("connection", (socket) => {
      socket.on("message", (payload) => {
        frames.push(new Uint8Array(payload as Buffer));
        socket.send(okResponse(BigInt(frames.length - 1), "events"));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const { port } = server.address() as AddressInfo;

    const sender = await Sender.fromConfig(
      `ws::addr=127.0.0.1:${port};auto_flush_rows=0;auto_flush_interval=0;auto_flush_bytes=8`,
    );
    try {
      await sender.connect();
      await sender.table("events").intColumn("value", 42).atNow();

      expect(sender.publishedSequence).toBe(0n);
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      await expect(sender.flush()).resolves.toBe(false);
    } finally {
      await sender.close();
    }
  });

  it("publishes pending rows and drains their ACK on close", async () => {
    const frames: Uint8Array[] = [];
    let ackSent = false;
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("headers", (headers) => {
      headers.push("X-QWP-Version: 1");
      headers.push("X-QWP-Max-Batch-Size: 1048576");
    });
    server.on("connection", (socket) => {
      socket.on("message", (payload) => {
        frames.push(new Uint8Array(payload as Buffer));
        setTimeout(() => {
          ackSent = true;
          socket.send(okResponse(0n, "events"));
        }, 25);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const { port } = server.address() as AddressInfo;

    const sender = await Sender.fromConfig(
      `ws::addr=127.0.0.1:${port};auto_flush=off;close_flush_timeout_millis=1000`,
    );
    await sender.connect();
    await sender.table("events").intColumn("value", 42).atNow();

    await expect(sender.close()).resolves.toBeUndefined();
    expect(frames).toHaveLength(1);
    expect(ackSent).toBe(true);
    expect(sender.acknowledgedSequence).toBe(0n);
  });

  it("releases the store-and-forward slot before close() returns", async () => {
    // close() aborts a connect that is still negotiating, but the signal only
    // ever reached the eager initial connection -- which is skipped for
    // precisely the configurations that own a replay store. So close()
    // returned and resolved while the abandoned connect went on holding the
    // slot lock for the rest of its connect budget: a second sender on the
    // same directory failed with QwpReplayStoreLockedError naming its own
    // process, and the session kept doing real work after shutdown.
    //
    // The peer accepts TCP and never answers the upgrade -- a stalled proxy or
    // load balancer -- so the attempt hangs for the whole connect timeout
    // rather than failing fast the way a refused port would.
    const sockets = new Set<Socket>();
    const stalled = createTcpServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.resume();
    });
    await new Promise<void>((resolve, reject) => {
      stalled.once("error", reject);
      stalled.listen(0, "127.0.0.1", resolve);
    });
    const port = (stalled.address() as AddressInfo).port;
    const directory = await mkdtemp(join(tmpdir(), "qwp-close-lock-"));
    let connecting: Promise<unknown> = Promise.resolve();
    try {
      const sender = await Sender.fromConfig(
        `ws::addr=127.0.0.1:${port};` +
          `sf_dir=${directory};auto_flush=off;` +
          "connect_timeout=30000;reconnect_max_duration_millis=30000;",
      );
      connecting = sender.connect().catch(() => undefined);
      // Let the connect reach the upgrade, so the store is loaded and its lock
      // taken before close() runs.
      await vi.waitFor(() => expect(sockets.size).toBe(1));
      await sender.close();

      // The lock may outlive close() by an in-flight load, but not by the
      // connect budget -- three seconds is an order of magnitude under the 30s
      // configured here and far above a load.
      const deadline = Date.now() + 3_000;
      let reopened = false;
      let lastError: unknown;
      while (!reopened && Date.now() < deadline) {
        const probe = new QwpNodeFileReplayStore({
          directory: join(directory, "default"),
        });
        try {
          await probe.load();
          await probe.close();
          reopened = true;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      expect(reopened, `slot still locked: ${lastError}`).toBe(true);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => stalled.close(() => resolve()));
      await connecting;
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }, 40_000);

  it("closes the socket and reports a bounded close-drain timeout", async () => {
    const frames: Uint8Array[] = [];
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("headers", (headers) => {
      headers.push("X-QWP-Version: 1");
      headers.push("X-QWP-Max-Batch-Size: 1048576");
    });
    server.on("connection", (socket) => {
      socket.on("message", (payload) => {
        frames.push(new Uint8Array(payload as Buffer));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const { port } = server.address() as AddressInfo;

    const sender = await Sender.fromConfig(
      `ws::addr=127.0.0.1:${port};auto_flush=off;close_flush_timeout_millis=25`,
    );
    await sender.connect();
    await sender.table("events").intColumn("value", 42).atNow();

    await expect(sender.close()).rejects.toMatchObject({
      name: "QwpSenderCloseTimeoutError",
      timeoutMs: 25,
      targetSequence: 0n,
      acknowledgedSequence: -1n,
    });
    expect(frames).toHaveLength(1);
  });
});
