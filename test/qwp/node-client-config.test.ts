import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  connectQwpNodeClient,
  createQwpNodeClient,
  parseQwpNodeClientConfig,
  type QwpNodeClientOptions,
  type QwpWebSocketLike,
} from "../../src/qwp/node";

class RejectingWebSocket {
  binaryType = "";
  readyState = 0;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor() {
    queueMicrotask(() => this.emit("error", new Error("offline")));
  }

  send(): void {}

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code: 1000, reason: "", wasClean: true });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) this.listeners.set(type, (listeners = new Set()));
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("QWP unified Node client configuration", () => {
  it("uses one ordered cluster and authentication configuration for both sides", () => {
    const options = parseQwpNodeClientConfig(
      "wss::addr=db-a.example:9443,db-b.example;addr=db-c.example:9555;" +
        "username=admin;password=s;;ecret;client_id=typescript-test;" +
        "target=replica;zone=eu-west-1a;compression=zstd;compression_level=3;" +
        "max_batch_rows=512;initial_credit=8192;buffer_pool_size=2;" +
        "sender_pool_min=0;sender_pool_max=2;query_pool_min=1;query_pool_max=8;" +
        "acquire_timeout_ms=2500;query_close_timeout_ms=7000;",
    );

    expect(String(options.ingress.url)).toBe(
      "wss://db-a.example:9443/write/v4",
    );
    expect(options.ingress.failoverUrls?.map(String)).toEqual([
      "wss://db-b.example:9000/write/v4",
      "wss://db-c.example:9555/write/v4",
    ]);
    expect(String(options.egress.url)).toBe("wss://db-a.example:9443/read/v1");
    expect(options.egress.failoverUrls?.map(String)).toEqual([
      "wss://db-b.example:9000/read/v1",
      "wss://db-c.example:9555/read/v1",
    ]);
    const authorization = `Basic ${Buffer.from(
      "admin:s;ecret",
      "utf8",
    ).toString("base64")}`;
    expect(options.ingress.authorization).toBe(authorization);
    expect(options.egress.authorization).toBe(authorization);
    expect(options.ingress.clientId).toBe("typescript-test");
    expect(options.egress.clientId).toBe("typescript-test");
    expect(options.egress).toMatchObject({
      target: "replica",
      zone: "eu-west-1a",
      compression: "zstd",
      compressionLevel: 3,
      maxBatchRows: 512,
    });
    expect(options.egressSession).toMatchObject({
      initialCredit: 8192,
      bufferPoolSize: 2,
      cancelDrainTimeoutMs: 7000,
    });
    expect(options.egressSession?.reconnect).toBeUndefined();
    expect(options.pool).toMatchObject({
      senderPoolMin: 0,
      senderPoolMax: 2,
      queryPoolMin: 1,
      queryPoolMax: 8,
      acquireTimeoutMs: 2500,
    });
  });

  it("coordinates lazy_connect across persistent ingress and the query pool", () => {
    const options = parseQwpNodeClientConfig(
      "ws::addr=localhost;sf_dir=/tmp/qwp-unified-test;lazy_connect=on;",
    );

    expect(options.lazyConnect).toBe(true);
    expect(options.ingress.storeAndForward).toMatchObject({
      directory: "/tmp/qwp-unified-test",
      initialConnectMode: "async",
    });
    expect(options.pool?.queryPoolMin).toBe(0);
  });

  it("preserves failover=off as an explicit programmatic opt-out", () => {
    const options = parseQwpNodeClientConfig(
      "ws::addr=localhost;failover=off;",
    );

    expect(options.egressSession?.reconnect).toBe(false);
  });

  it("starts lazy persistent ingress without prewarming egress", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qwp-unified-client-"));
    const attemptedPaths: string[] = [];
    let client: Awaited<ReturnType<typeof connectQwpNodeClient>> | undefined;
    try {
      client = await connectQwpNodeClient(
        `ws::addr=offline.example;sf_dir=${directory};lazy_connect=on;sender_pool_max=1;`,
        {
          webSocket: {
            webSocketFactory: (url, { onConnected }) => {
              attemptedPaths.push(new URL(url).pathname);
              onConnected();
              return new RejectingWebSocket() as unknown as QwpWebSocketLike;
            },
          },
        },
      );

      expect(attemptedPaths).toEqual(["/write/v4"]);
      expect(client.metrics.senders.total).toBe(1);
      expect(client.metrics.queries.total).toBe(0);
    } finally {
      await client?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects lazy startup conflicts before constructing the client", () => {
    expect(() =>
      parseQwpNodeClientConfig(
        "ws::addr=localhost;lazy_connect=on;initial_connect_retry=sync;sf_dir=/tmp/qwp;",
      ),
    ).toThrow(/lazyConnect requires.*initialConnectMode='async'/);
    expect(() =>
      parseQwpNodeClientConfig(
        "ws::addr=localhost;lazy_connect=on;query_pool_min=1;sf_dir=/tmp/qwp;",
      ),
    ).toThrow(/lazyConnect requires queryPoolMin=0/);
    expect(() =>
      parseQwpNodeClientConfig("ws::addr=localhost;lazy_connect=on;"),
    ).toThrow(/lazyConnect requires ingress storeAndForward/);
    expect(() =>
      createQwpNodeClient({
        ingress: { url: "ws://localhost:9000/write/v4" },
        egress: { url: "ws://localhost:9000/read/v1" },
        lazyConnect: true,
      }),
    ).toThrow(/lazyConnect requires ingress storeAndForward/);
  });

  it("validates ingress, egress, pool, and shared conflicts up front", () => {
    expect(() =>
      parseQwpNodeClientConfig("ws::addr=localhost;auto_flush=perhaps;"),
    ).toThrow(/Invalid auto_flush/);
    expect(() =>
      parseQwpNodeClientConfig("ws::addr=localhost;compression_level=23;"),
    ).toThrow(/compression_level must be an integer between 1 and 22/);
    expect(() =>
      parseQwpNodeClientConfig(
        "ws::addr=localhost;sender_pool_min=3;sender_pool_max=2;",
      ),
    ).toThrow(/senderPoolMin cannot exceed senderPoolMax/);
    expect(() =>
      parseQwpNodeClientConfig(
        "ws::addr=localhost;username=admin;password=secret;token=oidc;",
      ),
    ).toThrow(/cannot be combined/);
    expect(() =>
      parseQwpNodeClientConfig(
        "ws::addr=localhost;failover=off;failover_backoff_initial_ms=1000;failover_backoff_max_ms=10;",
      ),
    ).toThrow(/maximum backoff/);
    expect(() =>
      parseQwpNodeClientConfig("ws::addr=localhost;tls_verify=unsafe_off;"),
    ).toThrow(/only supported by the wss schema/);
  });

  it("validates the string before applying explicit programmatic overrides", () => {
    const options = parseQwpNodeClientConfig(
      "ws::addr=localhost;target=primary;query_pool_max=2;",
      {
        egress: { target: "replica" },
        pool: { queryPoolMax: 6 },
      },
    );
    expect(options.egress.target).toBe("replica");
    expect(options.pool?.queryPoolMax).toBe(6);

    expect(() =>
      parseQwpNodeClientConfig("ws::addr=localhost;compression_level=99;", {
        egress: { compressionLevel: 1 },
      }),
    ).toThrow(/compression_level/);
  });

  it("keeps the existing object API and accepts a string in the same facade", async () => {
    const legacy: QwpNodeClientOptions = {
      ingress: { url: "ws://localhost:9000/write/v4" },
      egress: { url: "ws://localhost:9000/read/v1" },
      pool: { senderPoolMin: 0, queryPoolMin: 0 },
    };
    const objectClient = createQwpNodeClient(legacy);
    const stringClient = createQwpNodeClient(
      "ws::addr=localhost;sender_pool_min=0;query_pool_min=0;",
    );
    expect(objectClient.metrics.senders.minimum).toBe(0);
    expect(stringClient.metrics.queries.minimum).toBe(0);
    await Promise.all([objectClient.close(), stringClient.close()]);
  });

  it("rejects duplicate, unknown, and unsupported active keys", () => {
    expect(() =>
      parseQwpNodeClientConfig(
        "ws::addr=db-a;addr=db-b;target=primary;target=replica;",
      ),
    ).toThrow(/Duplicate.*target/);
    expect(() =>
      parseQwpNodeClientConfig("ws::addr=localhost;made_up=1;"),
    ).toThrow(/Unknown.*made_up/);
    expect(() =>
      parseQwpNodeClientConfig("ws::addr=localhost;sf_max_segment_bytes=1m;"),
    ).toThrow(/not supported by the TypeScript client/);
  });

  it("validates cluster authorities and supports bracketed IPv6", () => {
    const options = parseQwpNodeClientConfig(
      "ws::addr=[::1],[2001:db8::2]:9443;sender_pool_min=0;query_pool_min=0;",
    );
    expect(String(options.ingress.url)).toBe("ws://[::1]:9000/write/v4");
    expect(options.egress.failoverUrls?.map(String)).toEqual([
      "ws://[2001:db8::2]:9443/read/v1",
    ]);
    for (const address of ["host:", "host:0", "host:65536", "::1"]) {
      expect(() => parseQwpNodeClientConfig(`ws::addr=${address};`)).toThrow(
        /Invalid QWP cluster address/,
      );
    }
  });
});
