import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  connectQwpNodeClient,
  createQwpNodeClient,
  QwpNodeFileReplayStore,
  parseQwpNodeClientConfig,
  Sender,
  type QwpNodeClientOptions,
  type QwpWebSocketLike,
} from "../../packages/nodejs-client/src";

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

class PendingWebSocket {
  binaryType = "";
  readyState = 0;
  closeCount = 0;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  send(): void {}

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.closeCount++;
    this.readyState = 3;
    this.emit("close", { code, reason, wasClean: code === 1000 });
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

  it("uses Java-compatible startup and store-and-forward defaults", () => {
    const defaults = parseQwpNodeClientConfig(
      "ws::addr=localhost;sf_dir=/tmp/qwp-unified-test;",
    );

    expect(defaults.ingress.storeAndForward).toMatchObject({
      directory: "/tmp/qwp-unified-test",
      maxBytes: 10 * 1024 * 1024 * 1024,
      maxSegmentBytes: 4 * 1024 * 1024,
      durability: "memory",
      backpressurePolicy: "wait",
      appendDeadlineMs: 30_000,
      initialConnectMode: "off",
    });
    expect(defaults.ingress.senderId).toBe("default");
    expect(defaults.ingressSession?.initialConnectMode).toBe("off");
    expect(defaults.sender).toMatchObject({
      closeFlushTimeoutMs: 5_000,
      maxNameLength: 127,
    });
    expect(
      parseQwpNodeClientConfig(
        "ws::addr=localhost;close_flush_timeout_millis=-1;",
      ).sender?.closeFlushTimeoutMs,
    ).toBe(-1);

    const tuned = parseQwpNodeClientConfig(
      "ws::addr=localhost;sf_dir=/tmp/qwp-unified-test;reconnect_max_duration_millis=1234;",
    );
    expect(tuned.ingress.storeAndForward?.initialConnectMode).toBe("sync");
    expect(tuned.ingressSession?.initialConnectMode).toBe("sync");

    const tunedMemory = parseQwpNodeClientConfig(
      "ws::addr=localhost;reconnect_initial_backoff_millis=25;",
    );
    expect(tunedMemory.ingress.storeAndForward).toBeUndefined();
    expect(tunedMemory.ingressSession?.initialConnectMode).toBe("sync");
  });

  it("preserves failover=off as an explicit programmatic opt-out", () => {
    const options = parseQwpNodeClientConfig(
      "ws::addr=localhost;failover=off;",
    );

    expect(options.egressSession?.reconnect).toBe(false);
  });

  it("fails fast on the default persistent initial connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qwp-unified-off-"));
    let attempts = 0;
    const client = createQwpNodeClient(
      `ws::addr=offline.example;sf_dir=${directory};sender_pool_max=1;query_pool_min=0;`,
      {
        webSocket: {
          webSocketFactory: (_url, { onConnected }) => {
            attempts++;
            onConnected();
            return new RejectingWebSocket() as unknown as QwpWebSocketLike;
          },
        },
      },
    );
    try {
      await expect(client.connect()).rejects.toThrow();
      expect(attempts).toBe(1);
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("releases what it started when the helper's initial connect fails", async () => {
    // connectQwpNodeClient() never hands the client back on failure, so it
    // owns the teardown. It used to rethrow bare, leaving the orphan drainer
    // connect() had already started to adopt sibling replay slots and hold
    // their advisory locks for the life of the process -- unreachable to any
    // other process and to a retry in this one, with no handle to stop it.
    const directory = await mkdtemp(join(tmpdir(), "qwp-unified-leak-"));
    try {
      // A slot left behind by a crashed producer. The pooled facade always
      // recovers canonical `<sender_id>-<n>` siblings, whatever drain_orphans
      // says, so this is reachable on a plain restart-during-outage.
      const orphan = join(directory, "default-7");
      const seeded = new QwpNodeFileReplayStore({ directory: orphan });
      await seeded.load();
      await seeded.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
      await seeded.close();

      await expect(
        connectQwpNodeClient(
          `ws::addr=offline.example;sf_dir=${directory};sender_pool_max=1;query_pool_min=0;`,
          {
            webSocket: {
              webSocketFactory: (_url, { onConnected }) => {
                onConnected();
                return new RejectingWebSocket() as unknown as QwpWebSocketLike;
              },
            },
          },
        ),
      ).rejects.toThrow();

      // Past the point where a still-running drainer reaches the slot, so a
      // leak shows up as a lock nobody can take rather than as a race.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await readdir(orphan)).not.toContain(".lock.owner");
      const successor = new QwpNodeFileReplayStore({ directory: orphan });
      await expect(successor.load()).resolves.toEqual([
        { frameSequence: 0n, payload: Uint8Array.of(1) },
      ]);
      await successor.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cancels an in-flight query prewarm connection during close", async () => {
    let resolveSocket!: (socket: PendingWebSocket) => void;
    const socketCreated = new Promise<PendingWebSocket>((resolve) => {
      resolveSocket = resolve;
    });
    const client = createQwpNodeClient({
      ingress: { url: "ws://localhost:9000/write/v4" },
      egress: {
        url: "ws://localhost:9000/read/v1",
        authTimeoutMs: 30_000,
        webSocketFactory: (_url, { onConnected }) => {
          const socket = new PendingWebSocket();
          resolveSocket(socket);
          onConnected();
          return socket as unknown as QwpWebSocketLike;
        },
      },
      pool: {
        senderPoolMin: 0,
        senderPoolMax: 1,
        queryPoolMin: 1,
        queryPoolMax: 1,
        acquireTimeoutMs: 1_000,
      },
    });

    const connecting = client.connect();
    const socket = await socketCreated;
    expect(client.metrics.queries.creating).toBe(1);

    await client.close();

    expect(socket.closeCount).toBe(1);
    expect(socket.readyState).toBe(3);
    expect(client.metrics).toMatchObject({
      closing: true,
      closed: true,
      queries: { total: 0, creating: 0 },
    });
    await expect(connecting).rejects.toThrow();
  });

  it("starts lazy persistent ingress without prewarming egress", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qwp-unified-client-"));
    const attemptedPaths: string[] = [];
    let client: Awaited<ReturnType<typeof connectQwpNodeClient>> | undefined;
    try {
      client = await connectQwpNodeClient(
        `ws::addr=offline.example;sf_dir=${directory};sender_id=producer_1;lazy_connect=on;sender_pool_max=1;`,
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
      expect(await readdir(directory)).toContain("producer_1-0");
    } finally {
      await client?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("starts lazy memory-buffered ingress without sf_dir", async () => {
    const attemptedPaths: string[] = [];
    const client = await connectQwpNodeClient(
      "ws::addr=offline.example;lazy_connect=on;sender_pool_max=1;",
      {
        webSocket: {
          webSocketFactory: (url, { onConnected }) => {
            attemptedPaths.push(new URL(url).pathname);
            onConnected();
            return new RejectingWebSocket() as unknown as QwpWebSocketLike;
          },
        },
        sender: { closeFlushTimeoutMs: 0 },
      },
    );
    try {
      expect(attemptedPaths).toEqual(["/write/v4"]);
      expect(client.metrics.senders.total).toBe(1);
      expect(client.metrics.queries.total).toBe(0);
      const sender = await client.borrowSender();
      await sender.table("events").longColumn("value", 42n).atNow();
      await sender.flush();
      expect(sender.metrics.totalRowsPublished).toBe(1);
      await sender.close();
    } finally {
      await client.close();
    }
  });

  it("rejects lazy startup conflicts before constructing the client", async () => {
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
      createQwpNodeClient({
        ingress: {
          url: "ws://localhost:9000/write/v4",
          storeAndForward: {
            directory: "/tmp/qwp",
            initialConnectMode: "off",
          },
        },
        egress: { url: "ws://localhost:9000/read/v1" },
        ingressSession: { initialConnectMode: "sync" },
      }),
    ).toThrow(/initialConnectMode.*differs/);
    const memoryOptions = parseQwpNodeClientConfig(
      "ws::addr=localhost;lazy_connect=on;",
    );
    expect(memoryOptions.ingress.storeAndForward).toBeUndefined();
    expect(memoryOptions.ingressSession).toMatchObject({
      backgroundStoreAndForward: true,
      initialConnectMode: "async",
    });
    const client = createQwpNodeClient({
      ingress: { url: "ws://localhost:9000/write/v4" },
      egress: { url: "ws://localhost:9000/read/v1" },
      lazyConnect: true,
      pool: { senderPoolMin: 0 },
    });
    expect(client.metrics.senders.minimum).toBe(0);
    await client.close();
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
        "ws::addr=localhost;username=alice:admin;password=secret;",
      ),
    ).toThrow("QWP Basic authentication username cannot contain ':'");
    expect(() =>
      parseQwpNodeClientConfig(
        "ws::addr=localhost;failover=off;failover_backoff_initial_ms=1000;failover_backoff_max_ms=10;",
      ),
    ).toThrow(/maximum backoff/);
    expect(() =>
      parseQwpNodeClientConfig("ws::addr=localhost;tls_verify=unsafe_off;"),
    ).toThrow(/only supported by the wss schema/);
  });

  it("validates egress bounds against the egress defaults, not the ingress ones", () => {
    // validateReconnectBounds() filled the unset side from the ingress pair
    // (100/5000) for both sessions, while the egress connection uses 50/1000.
    // It therefore accepted strings the egress session then refused with a
    // RangeError at the first borrowQuery(), and refused legal ones outright.
    expect(() =>
      parseQwpNodeClientConfig(
        "ws::addr=localhost;failover_backoff_initial_ms=2000;",
      ),
    ).toThrow(/QWP egress failover maximum backoff/);
    // 75ms clears the real egress initial default of 50ms, so it is legal.
    expect(() =>
      parseQwpNodeClientConfig(
        "ws::addr=localhost;failover_backoff_max_ms=75;",
      ),
    ).not.toThrow();
    // The ingress pair is unchanged.
    expect(() =>
      parseQwpNodeClientConfig(
        "ws::addr=localhost;reconnect_initial_backoff_millis=6000;",
      ),
    ).toThrow(/QWP ingress reconnect maximum backoff/);
    // QwpEgressSession requires a positive drain bound, so accepting zero here
    // only moved the RangeError to the first query and named a field the
    // connect string never mentions.
    expect(() =>
      parseQwpNodeClientConfig("ws::addr=localhost;query_close_timeout_ms=0;"),
    ).toThrow(/query_close_timeout_ms/);
    expect(() =>
      parseQwpNodeClientConfig("ws::addr=localhost;query_close_timeout_ms=1;"),
    ).not.toThrow();
  });

  it("rejects a compression level that cannot reach the wire", () => {
    // compression defaults to raw, which sends no accept-encoding header, so a
    // level on its own parsed, validated its range, and then provably did
    // nothing.
    expect(() =>
      parseQwpNodeClientConfig("ws::addr=localhost;compression_level=9;"),
    ).toThrow(/compression_level requires compression/);
    expect(() =>
      parseQwpNodeClientConfig(
        "ws::addr=localhost;compression=raw;compression_level=9;",
      ),
    ).toThrow(
      /compression_level requires compression=zstd or compression=auto/,
    );
    const zstd = parseQwpNodeClientConfig(
      "ws::addr=localhost;compression=zstd;compression_level=9;",
    );
    expect(zstd.egress).toMatchObject({
      compression: "zstd",
      compressionLevel: 9,
    });
    const auto = parseQwpNodeClientConfig(
      "ws::addr=localhost;compression=auto;compression_level=9;",
    );
    expect(auto.egress).toMatchObject({
      compression: "auto",
      compressionLevel: 9,
    });
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

  it("ignores explicitly undefined values in a typed override", () => {
    // Typed overrides are spread over the parsed values, so an `undefined`
    // key erased whatever the connect string had set and silently reverted the
    // option to its built-in default. `exactOptionalPropertyTypes` is off, so
    // `{ autoFlushRows: config.rows }` with an unset `config.rows` is exactly
    // this shape and cannot mean anything else.
    const connectString =
      "ws::addr=localhost;auto_flush_rows=5000;auto_flush_interval=7000;" +
      "error_inbox_capacity=512;query_pool_max=6;";
    const baseline = parseQwpNodeClientConfig(connectString);
    expect(baseline.sender).toMatchObject({
      autoFlushRows: 5000,
      autoFlushIntervalMs: 7000,
    });

    const overridden = parseQwpNodeClientConfig(connectString, {
      sender: { autoFlushRows: undefined, autoFlushIntervalMs: undefined },
      ingressSession: { errorInboxCapacity: undefined },
      pool: { queryPoolMax: undefined },
    });
    expect(overridden.sender).toMatchObject({
      autoFlushRows: 5000,
      autoFlushIntervalMs: 7000,
    });
    expect(overridden.ingressSession?.errorInboxCapacity).toBe(512);
    expect(overridden.pool?.queryPoolMax).toBe(6);

    // A value that is actually supplied still wins.
    expect(
      parseQwpNodeClientConfig(connectString, {
        sender: { autoFlushRows: 10 },
      }).sender?.autoFlushRows,
    ).toBe(10);
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

  it("rejects duplicate and unknown active keys", () => {
    expect(() =>
      parseQwpNodeClientConfig(
        "ws::addr=db-a;addr=db-b;target=primary;target=replica;",
      ),
    ).toThrow(/Duplicate.*target/);
    expect(() =>
      parseQwpNodeClientConfig("ws::addr=localhost;made_up=1;"),
    ).toThrow(/unknown configuration key: made_up/);
  });

  it("accepts and validates the remaining Java QWP configuration keys", () => {
    const trustStore = "test/certs/ca/ca.crt";
    const options = parseQwpNodeClientConfig(
      `wss::addr=localhost;tls_roots=${trustStore};` +
        "connection_listener_inbox_capacity=7;error_inbox_capacity=32;" +
        "max_name_len=512;sender_id=producer_1;sf_max_segment_bytes=8m;" +
        "sf_max_total_bytes=64m;sf_append_deadline_millis=1234;",
    );
    expect(options.ingress.agent).toBeDefined();
    expect(options.sender?.maxNameLength).toBe(512);
    expect(options.ingress.senderId).toBe("producer_1");
    expect(options.ingressSession).toMatchObject({
      maxBatchSizeBytes: 8 * 1024 * 1024,
      memoryReplayMaxBytes: 64 * 1024 * 1024,
      memoryReplayAppendDeadlineMs: 1234,
      connectionListenerInboxCapacity: 7,
      errorInboxCapacity: 32,
    });

    expect(() =>
      parseQwpNodeClientConfig(
        `wss::addr=localhost;tls_roots=${trustStore};tls_roots_password=secret;`,
      ),
    ).toThrow(/tls_roots_password.*PEM-encoded CA certificates/);
    expect(() =>
      parseQwpNodeClientConfig(
        `wss::addr=localhost;tls_roots=${trustStore};tls_verify=unsafe_off;`,
      ),
    ).toThrow(/cannot be combined/);
    expect(() =>
      parseQwpNodeClientConfig("ws::addr=localhost;max_name_len=15;"),
    ).toThrow(/max_name_len/);
    expect(() =>
      parseQwpNodeClientConfig("ws::addr=localhost;sender_id=bad.name;"),
    ).toThrow(/sender_id/);
    expect(() =>
      parseQwpNodeClientConfig("ws::addr=localhost;error_inbox_capacity=15;"),
    ).toThrow(/error_inbox_capacity/);
  });

  it("routes ingress by target and zone, not only egress", () => {
    // Both keys were parsed, validated and then applied to the egress factory
    // alone. On the ingress side target degenerated to "accept any role" and
    // the health tracker ran zone-blind, so every endpoint ranked as same-zone
    // and configuration order alone decided where writes went. Through
    // Sender.fromConfig it was total: that path uses only options.ingress, so
    // a bogus target still threw while a valid one did nothing at all.
    const options = parseQwpNodeClientConfig(
      "ws::addr=db-a.example:9000,db-b.example:9000;target=primary;zone=eu-west-1a;",
    );

    expect(options.ingress).toMatchObject({
      target: "primary",
      zone: "eu-west-1a",
    });
    expect(options.egress).toMatchObject({
      target: "primary",
      zone: "eu-west-1a",
    });
  });

  it("keeps requestDurableAck on ingress when it is set as a shared override", () => {
    // Durable ACK is negotiated on /write/v4 only. The typed webSocket block
    // is spread into both sides, so this override also reached egress, whose
    // upgrade then demanded an x-qwp-durable-ack response header that
    // /read/v1 never sends -- every pooled query session failed to connect
    // with QwpDurableAckUnavailableError while ingress worked fine.
    const overridden = parseQwpNodeClientConfig("ws::addr=localhost:9000;", {
      webSocket: { requestDurableAck: true },
    });
    expect(overridden.ingress.requestDurableAck).toBe(true);
    expect(overridden.egress.requestDurableAck).toBeUndefined();

    // The connect-string key has always been ingress-only; the two agree now.
    const fromString = parseQwpNodeClientConfig(
      "ws::addr=localhost:9000;request_durable_ack=on;",
    );
    expect(fromString.ingress.requestDurableAck).toBe(true);
    expect(fromString.egress.requestDurableAck).toBeUndefined();

    // The keepalive is also a documented direct request for durable progress.
    const keepaliveOnly = parseQwpNodeClientConfig(
      "ws::addr=localhost:9000;durable_ack_keepalive_interval_millis=10;",
    );
    expect(keepaliveOnly.ingress.requestDurableAck).toBe(true);
    expect(keepaliveOnly.ingressSession.durableAckKeepaliveMs).toBe(10);
    expect(keepaliveOnly.egress.requestDurableAck).toBeUndefined();

    expect(() =>
      parseQwpNodeClientConfig(
        "ws::addr=localhost:9000;request_durable_ack=off;durable_ack_keepalive_interval_millis=10;",
      ),
    ).toThrow(
      "durableAckKeepaliveMs cannot be combined with requestDurableAck=false",
    );

    // Other shared webSocket overrides still reach both sides.
    const shared = parseQwpNodeClientConfig("ws::addr=localhost:9000;", {
      webSocket: { requestDurableAck: true, clientId: "probe" },
    });
    expect(shared.ingress.clientId).toBe("probe");
    expect(shared.egress.clientId).toBe("probe");
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

  it("keeps endpoint credentials out of the address rejection", async () => {
    // `addr` is host[:port], so userinfo in it is always rejected -- but the
    // rejection interpolated the whole entry, and a connect string is parsed
    // at startup, where that message is what configuration logging writes out.
    // The client already strips userinfo from endpoints reaching failover
    // errors, reconnect events and the browser bootstrap's own validation
    // errors; this is the connect-string half of the same rule.
    const secret = "sup3rs3cr3t";
    for (const [address, survives] of [
      [`admin:${secret}@localhost:9000`, "localhost:9000"],
      [`admin:${secret}@localhost`, "localhost"],
      // The rejected entry is the one named, not the healthy one beside it.
      [`localhost:9000,admin:${secret}@other:9000`, "other:9000"],
      [` admin:${secret}@localhost:9000`, "localhost:9000"],
    ] as const) {
      let thrown: unknown;
      try {
        parseQwpNodeClientConfig(`ws::addr=${address};`);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${address} was accepted`).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toMatch(/Invalid QWP cluster address/);
      expect(message, `leaked through ${address}`).not.toContain(secret);
      // The part that makes the error actionable survives.
      expect(message).toContain(survives);
    }

    // A Sender reaches the same parser, so the same message reaches its caller.
    await expect(
      Sender.fromConfig(`ws::addr=admin:${secret}@localhost:9000;`),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(secret),
      }),
    );
  });

  it("rejects a millisecond option above the timer ceiling", () => {
    // setTimeout clamps anything above 2^31-1 to 1 ms and warns, so an
    // over-large value did not merely fail to apply -- it inverted into an
    // immediate timeout. Every one of these reaches a raw timer.
    const timerKeys = [
      "connect_timeout",
      "auth_timeout_ms",
      "auto_flush_interval",
      "close_flush_timeout_millis",
      "durable_ack_keepalive_interval_millis",
      "query_close_timeout_ms",
      "acquire_timeout_ms",
      "idle_timeout_ms",
      "max_lifetime_ms",
      "housekeeper_interval_ms",
    ];
    for (const key of timerKeys) {
      expect(
        () =>
          parseQwpNodeClientConfig(`wss::addr=host:9000;${key}=2147483648;`),
        `${key} was accepted above the timer ceiling`,
      ).toThrow(/must be an integer between .* and 2147483647/);
    }
    // The ceiling itself still parses.
    expect(
      parseQwpNodeClientConfig(
        "wss::addr=host:9000;auth_timeout_ms=2147483647;",
      ).ingress.authTimeoutMs,
    ).toBe(2147483647);
    // A byte-count option is not a timer and keeps its own, larger range.
    expect(() =>
      parseQwpNodeClientConfig(
        "wss::addr=host:9000;sf_dir=/tmp/qwp;sender_id=p1;sf_max_total_bytes=4294967296;",
      ),
    ).not.toThrow();
  });
});
