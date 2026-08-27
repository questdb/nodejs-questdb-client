import { describe, expect, it, vi } from "vitest";
import {
  bootstrapQwpBrowserSession,
  connectQwpBrowserClient,
  connectQwpBrowserEgress,
  connectQwpBrowserIngress,
  connectQwpBrowserWebSocket,
  createQwpBrowserClient,
  createQwpBrowserSender,
  QwpBrowserSessionBootstrapError,
  QwpWebSocketLike,
} from "../../src/qwp/browser";
import {
  connectQwpNodeEgress,
  connectQwpNodeWebSocket,
  QwpDurableAckUnavailableError,
  QwpVersionMismatchError,
} from "../../src/qwp/node";
import {
  QWP_COLUMN_TYPE,
  QWP_COMPRESSION_CODEC,
  QWP_EGRESS_CAPABILITY,
  QWP_EGRESS_MESSAGE,
  QWP_FLAG_DEFER_COMMIT,
  QWP_FLAG_DELTA_SYMBOL_DICTIONARY,
  QWP_INGRESS_PROGRESS_KIND,
  QWP_STATUS,
  QWP_SENDER_ERROR_CATEGORY,
  QWP_SENDER_ERROR_POLICY,
  QWP_UPGRADE_ERROR_KIND,
  QWP_UPGRADE_TIMEOUT_PHASE,
  QwpBatchTooLargeError,
  QwpByteReader,
  QwpByteWriter,
  decodeQwpFrame,
  decodeQwpIngressSymbolDictionaryDelta,
  encodeQwpDurableAckPollFrame,
  encodeQwpFrame,
  encodeQwpIngressFrame,
  QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL,
  QwpIngressAckTimeoutError,
  QwpIngressNackError,
  QwpIngressResponse,
  QwpIngressSession,
  QwpIngressSessionClosedError,
  type QwpSenderError,
  QwpTableBuffer,
  QwpSendClosedError,
  QwpSendTimeoutError,
  QwpUpgradeError,
  QwpSymbolDictionary,
  readQwpVarintNumber,
} from "../../src/qwp";
import { openQwpWebSocket } from "../../src/_qwp/_internal/websocket-connection";

type Listener = (event: unknown) => void;

class FakeWebSocket {
  binaryType = "blob";
  readyState = 0;
  protocol = "";
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  readonly closeCalls: { code?: number; reason?: string }[] = [];
  onSend?: (payload: Uint8Array) => void;
  protected readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
    if (listeners.length === 0) this.listeners.delete(type);
  }

  listenerCount(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.length;
    return count;
  }

  send(payload: Uint8Array): void {
    this.sent.push(payload.slice());
    this.onSend?.(payload);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", {
      code: code ?? 1000,
      reason: reason ?? "",
      wasClean: true,
    });
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(data: unknown): void {
    this.emit("message", { data });
  }

  error(): void {
    this.emit("error", {});
  }

  protected emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  protected listenerCountFor(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
}

/**
 * Records whether an `error` listener existed each time close() was called.
 *
 * Closing a socket that is still CONNECTING makes `ws` emit `error`, and it
 * does so on a later tick, so a synchronous throw here would only be swallowed
 * by closeSocket()'s own try/catch and prove nothing. `ws` is an EventEmitter
 * rather than an EventTarget, so that deferred `error` is rethrown into the
 * process when nothing is subscribed. The observable invariant this client has
 * to hold is therefore the ordering itself: never close a connecting socket
 * before its error listener is attached.
 */
class FakeNodeWebSocket extends FakeWebSocket {
  readonly errorListenerAtClose: boolean[] = [];

  close(code?: number, reason?: string): void {
    if (this.readyState !== 3) {
      this.errorListenerAtClose.push(this.listenerCountFor("error") > 0);
    }
    super.close(code, reason);
  }
}

class FakeStuckCloseWebSocket extends FakeWebSocket {
  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }
}

class FakeStuckCloseNodeWebSocket extends FakeStuckCloseWebSocket {
  terminateCalls = 0;

  terminate(): void {
    this.terminateCalls++;
    this.readyState = 3;
  }
}

class FakeBackpressuredWebSocket extends FakeWebSocket {
  send(payload: Uint8Array): void {
    this.bufferedAmount += payload.byteLength;
    super.send(payload);
  }

  drain(bytes = this.bufferedAmount): void {
    this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes);
  }
}

class FakeCallbackWebSocket extends FakeWebSocket {
  readonly sendCallbacks: ((error?: Error) => void)[] = [];

  sendWithCallback(
    payload: Uint8Array,
    callback: (error?: Error) => void,
  ): void {
    super.send(payload);
    this.sendCallbacks.push(callback);
  }

  completeSend(error?: Error): void {
    const callback = this.sendCallbacks.shift();
    if (!callback) throw new Error("no pending WebSocket send");
    callback(error);
  }
}

class FakePingWebSocket extends FakeWebSocket {
  pingCalls = 0;
  onPing?: () => void;

  ping(): void {
    this.pingCalls++;
    this.onPing?.();
  }
}

function asQwpSocket(socket: FakeWebSocket): QwpWebSocketLike {
  return socket as unknown as QwpWebSocketLike;
}

function ingressResponse(
  status: number,
  sequence: bigint,
  message?: string,
  tables: readonly [string, bigint][] = [],
): Uint8Array {
  const writer = new QwpByteWriter();
  writer.writeUint8(status).writeBigUint64(sequence);
  if (status === QWP_STATUS.OK) {
    writeIngressTables(writer, tables);
  } else {
    const encoded = new TextEncoder().encode(message ?? "rejected");
    writer.writeUint16(encoded.length).writeBytes(encoded);
  }
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
  for (const [name, sequenceTransaction] of tables) {
    const encoded = new TextEncoder().encode(name);
    writer
      .writeUint16(encoded.length)
      .writeBytes(encoded)
      .writeBigInt64(sequenceTransaction);
  }
}

function firstIngressTableRowCount(payload: Uint8Array): number {
  const frame = decodeQwpFrame(payload);
  const reader = new QwpByteReader(frame.payload);
  if ((frame.flags & QWP_FLAG_DELTA_SYMBOL_DICTIONARY) !== 0) {
    readQwpVarintNumber(reader, "dictionary start ID");
    const entries = readQwpVarintNumber(reader, "dictionary entry count");
    for (let index = 0; index < entries; index++) {
      const length = readQwpVarintNumber(reader, "dictionary entry length");
      reader.readBytes(length, "dictionary entry");
    }
  }
  const nameLength = readQwpVarintNumber(reader, "table name length");
  reader.readBytes(nameLength, "table name");
  return readQwpVarintNumber(reader, "row count");
}

function longTable(name: string, values: readonly bigint[]): QwpTableBuffer {
  const table = new QwpTableBuffer(name);
  for (const value of values) {
    table.getOrCreateColumn("value", QWP_COLUMN_TYPE.LONG)!.values.push(value);
    table.nextRow();
  }
  return table;
}

function symbolTable(name: string, values: readonly string[]): QwpTableBuffer {
  const table = new QwpTableBuffer(name);
  for (const value of values) {
    table
      .getOrCreateColumn("symbol", QWP_COLUMN_TYPE.SYMBOL)!
      .values.push(value);
    table.nextRow();
  }
  return table;
}

function serverInfoFrame(compression?: {
  codec: number;
  level: number;
}): Uint8Array {
  const writer = new QwpByteWriter();
  writer
    .writeUint8(QWP_EGRESS_MESSAGE.SERVER_INFO)
    .writeUint8(0)
    .writeBigUint64(1n)
    .writeUint32(compression ? QWP_EGRESS_CAPABILITY.COMPRESSION : 0)
    .writeBigInt64(123n)
    .writeUint16(0)
    .writeUint16(0);
  if (compression) {
    writer.writeUint8(compression.codec).writeUint8(compression.level);
  }
  return encodeQwpFrame(writer.toUint8Array());
}

function ingressServerInfo(maxBatchSizeBytes: number): Uint8Array {
  return new QwpByteWriter()
    .writeUint8(QWP_STATUS.SERVER_INFO)
    .writeUint32(maxBatchSizeBytes)
    .toUint8Array();
}

/**
 * `toMatchObject` matches nested objects partially, but `Partial<T>` only
 * relaxes the top level, so the nested response needs relaxing too.
 */
type QwpIngressNackMatch = Partial<Omit<QwpIngressNackError, "response">> & {
  response: Partial<QwpIngressResponse>;
};

describe("QWP WebSocket adapters", () => {
  it.each(["browser", "node"] as const)(
    "validates %s timeouts before creating a WebSocket",
    async (runtime) => {
      let factoryCalls = 0;
      const factory = (): QwpWebSocketLike => {
        factoryCalls++;
        return asQwpSocket(new FakeWebSocket());
      };
      const connecting =
        runtime === "browser"
          ? connectQwpBrowserWebSocket({
              url: "ws://localhost:9000/write/v4",
              closeTimeoutMs: 0,
              webSocketFactory: factory,
            })
          : connectQwpNodeWebSocket({
              url: "ws://localhost:9000/write/v4",
              closeTimeoutMs: 0,
              webSocketFactory: factory,
            });

      await expect(connecting).rejects.toThrow(
        "closeTimeoutMs must be a positive finite number",
      );
      expect(factoryCalls).toBe(0);
    },
  );

  it("bootstraps a browser qdb_session with Basic authentication", async () => {
    let requestedUrl: URL | undefined;
    let requestedInit: RequestInit | undefined;
    const result = await bootstrapQwpBrowserSession({
      url: "https://questdb.example/exec?tenant=blue",
      authentication: {
        type: "basic",
        username: "admin",
        password: "quest",
      },
      fetch: async (input, init) => {
        requestedUrl = new URL(input);
        requestedInit = init;
        return new Response('{"dataset":[[1]]}', {
          status: 200,
          statusText: "OK",
        });
      },
    });

    expect(result).toMatchObject({ status: 200 });
    expect(requestedUrl?.pathname).toBe("/exec");
    expect(requestedUrl?.searchParams.get("tenant")).toBe("blue");
    expect(requestedUrl?.searchParams.get("query")).toBe("select 1");
    expect(requestedUrl?.searchParams.get("session")).toBe("true");
    expect(requestedInit).toMatchObject({
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
        Authorization: "Basic YWRtaW46cXVlc3Q=",
        "Cache-Control": "no-store",
      },
    });
  });

  it("bootstraps REST/OIDC bearer auth and safely quotes a service account", async () => {
    let requestedUrl: URL | undefined;
    let requestedInit: RequestInit | undefined;
    const result = await bootstrapQwpBrowserSession({
      url: "https://questdb.example/exec",
      authentication: { type: "bearer", token: "access-token" },
      serviceAccount: "market'maker",
      fetch: async (input, init) => {
        requestedUrl = new URL(input);
        requestedInit = init;
        return new Response("{}", { status: 200 });
      },
    });

    expect(result).toMatchObject({
      status: 200,
      serviceAccount: "market'maker",
    });
    expect(requestedUrl?.searchParams.get("query")).toBe(
      "assume service account 'market''maker'",
    );
    expect(requestedInit).toMatchObject({
      credentials: "include",
      headers: { Authorization: "Bearer access-token" },
    });
  });

  it("classifies rejected browser session credentials without failing over", async () => {
    const requestedHosts: string[] = [];
    await expect(
      connectQwpBrowserWebSocket({
        url: "wss://primary.example/write/v4",
        failoverUrls: ["wss://secondary.example/write/v4"],
        sessionBootstrap: {
          authentication: { type: "bearer", token: "invalid" },
          fetch: async (input) => {
            requestedHosts.push(new URL(input).host);
            return new Response("invalid token", {
              status: 401,
              statusText: "Unauthorized",
            });
          },
        },
        webSocketFactory: () => {
          throw new Error("WebSocket must not open after failed login");
        },
      }),
    ).rejects.toMatchObject({
      name: "QwpBrowserSessionBootstrapError",
      kind: QWP_UPGRADE_ERROR_KIND.AUTHENTICATION,
      retryable: false,
      tryNextEndpoint: false,
      statusCode: 401,
      responseBody: "invalid token",
    } satisfies Partial<QwpBrowserSessionBootstrapError>);
    expect(requestedHosts).toEqual(["primary.example"]);
  });

  it("completes the browser session bootstrap before opening WebSocket", async () => {
    const socket = new FakeWebSocket();
    const events: string[] = [];
    const connecting = connectQwpBrowserWebSocket({
      url: "wss://questdb.example/proxy/write/v4",
      sessionBootstrap: {
        authentication: { type: "bearer", token: "rest-token" },
        fetch: async (input) => {
          events.push(`fetch:${new URL(input).toString()}`);
          return new Response("{}", { status: 200 });
        },
      },
      webSocketFactory: () => {
        events.push("websocket");
        queueMicrotask(() => socket.open());
        return asQwpSocket(socket);
      },
    });

    const connection = await connecting;
    expect(events).toHaveLength(2);
    expect(events[0]).toContain(
      "https://questdb.example/proxy/exec?query=select+1&session=true",
    );
    expect(events[1]).toBe("websocket");
    await connection.close();
  });

  it("includes a stalled browser bootstrap in the connection deadline", async () => {
    vi.useFakeTimers();
    try {
      let bootstrapSignal: AbortSignal | null | undefined;
      let webSocketFactoryCalls = 0;
      const connecting = connectQwpBrowserWebSocket({
        url: "wss://questdb.example/write/v4",
        connectTimeoutMs: 25,
        sessionBootstrap: {
          authentication: { type: "bearer", token: "rest-token" },
          fetch: async (_input, init) => {
            bootstrapSignal = init?.signal;
            return new Promise<Response>((_resolve, reject) => {
              bootstrapSignal?.addEventListener(
                "abort",
                () => reject(new Error("bootstrap aborted")),
                { once: true },
              );
            });
          },
        },
        webSocketFactory: () => {
          webSocketFactoryCalls++;
          return asQwpSocket(new FakeWebSocket());
        },
      });
      const rejected = expect(connecting).rejects.toMatchObject({
        name: "QwpUpgradeError",
        kind: QWP_UPGRADE_ERROR_KIND.TIMEOUT,
        retryable: true,
        tryNextEndpoint: true,
        message: "QWP WebSocket connection timed out after 25ms",
      } satisfies Partial<QwpUpgradeError>);

      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(bootstrapSignal?.aborted).toBe(true);
      expect(webSocketFactoryCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes browser ingress negotiation in the connection deadline", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeWebSocket();
      const connecting = connectQwpBrowserIngress(
        {
          url: "wss://questdb.example/write/v4",
          connectTimeoutMs: 25,
          ingressNegotiationTimeoutMs: 1_000,
          webSocketFactory: () => {
            queueMicrotask(() => socket.open());
            return asQwpSocket(socket);
          },
        },
        { reconnect: false },
      );
      const rejected = expect(connecting).rejects.toMatchObject({
        name: "QwpUpgradeError",
        kind: QWP_UPGRADE_ERROR_KIND.TIMEOUT,
        message: "QWP WebSocket connection timed out after 25ms",
      } satisfies Partial<QwpUpgradeError>);

      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(socket.closeCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses one browser cluster for authenticated ingress, egress, and failover", async () => {
    const webSocketUrls: URL[] = [];
    const bootstrapUrls: URL[] = [];
    const client = await connectQwpBrowserClient({
      cluster: {
        url: "wss://node-a.example/qdb?tenant=blue",
        failoverUrls: ["wss://node-b.example/qdb?tenant=blue"],
        sessionBootstrap: {
          authentication: { type: "bearer", token: "access-token" },
          fetch: async (input) => {
            bootstrapUrls.push(new URL(input));
            return new Response("{}", { status: 200 });
          },
        },
        webSocketFactory: (url) => {
          const requestUrl = new URL(url);
          webSocketUrls.push(requestUrl);
          if (requestUrl.hostname === "node-a.example") {
            throw new QwpUpgradeError("offline", {
              kind: QWP_UPGRADE_ERROR_KIND.TRANSPORT,
              retryable: true,
              tryNextEndpoint: true,
              url,
            });
          }
          const socket = new FakeWebSocket();
          queueMicrotask(() => {
            socket.open();
            socket.message(
              requestUrl.pathname.endsWith("/read/v1")
                ? serverInfoFrame()
                : ingressServerInfo(1_048_576),
            );
          });
          return asQwpSocket(socket);
        },
      },
      ingress: { ingressNegotiationTimeoutMs: 1_000 },
      egress: { target: "any", maxBatchRows: 512 },
    });
    try {
      expect(
        webSocketUrls.map((url) => `${url.hostname}${url.pathname}`).sort(),
      ).toEqual([
        "node-a.example/qdb/read/v1",
        "node-a.example/qdb/write/v4",
        "node-b.example/qdb/read/v1",
        "node-b.example/qdb/write/v4",
      ]);
      expect(
        webSocketUrls.every((url) => url.searchParams.get("tenant") === "blue"),
      ).toBe(true);
      expect(
        webSocketUrls
          .find((url) => url.pathname.endsWith("/read/v1"))
          ?.searchParams.get("qwp_max_batch_rows"),
      ).toBe("512");
      expect(
        bootstrapUrls.map((url) => `${url.hostname}${url.pathname}`).sort(),
      ).toEqual([
        "node-a.example/qdb/exec",
        "node-a.example/qdb/exec",
        "node-b.example/qdb/exec",
        "node-b.example/qdb/exec",
      ]);
    } finally {
      await client.close();
    }
  });

  it("rejects connection fields duplicated under unified browser overrides", () => {
    expect(() =>
      createQwpBrowserClient({
        cluster: { url: "wss://questdb.example" },
        ingress: { url: "wss://other.example/write/v4" },
      } as never),
    ).toThrow("ingress.url must be configured once under cluster.url");
    expect(() =>
      createQwpBrowserClient({
        cluster: { url: "wss://questdb.example" },
        egress: {
          sessionBootstrap: {
            authentication: { type: "bearer", token: "other-token" },
          },
        },
      } as never),
    ).toThrow(
      "egress.sessionBootstrap must be configured once under cluster.sessionBootstrap",
    );
  });

  it("validates unified browser cluster URLs before opening a socket", () => {
    expect(() =>
      createQwpBrowserClient({
        cluster: { url: "https://questdb.example" },
      }),
    ).toThrow("QWP browser cluster URL must use WS or WSS");
    expect(() =>
      createQwpBrowserClient({
        cluster: { url: "wss://questdb.example/#fragment" },
      }),
    ).toThrow("QWP browser cluster URL cannot contain a fragment");
  });

  it("buffers browser messages until a consumer is attached", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpBrowserWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: () => asQwpSocket(socket),
    });
    socket.open();
    const connection = await connecting;
    expect(socket.binaryType).toBe("arraybuffer");

    socket.message(Uint8Array.from([1, 2, 3]).buffer);
    const iterator = connection.messages[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      value: Uint8Array.from([1, 2, 3]),
      done: false,
    });
    await connection.close();
  });

  it("negotiates durable ACKs through a browser WebSocket subprotocol", async () => {
    const socket = new FakeWebSocket();
    socket.protocol = QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL;
    let capturedProtocols: string | string[] | undefined;
    const connecting = connectQwpBrowserWebSocket({
      url: "ws://localhost:9000/write/v4",
      protocols: ["application.v1"],
      requestDurableAck: true,
      webSocketFactory: (_url, protocols) => {
        capturedProtocols = protocols;
        return asQwpSocket(socket);
      },
    });
    socket.open();

    const connection = await connecting;
    expect(capturedProtocols).toEqual([
      "application.v1",
      QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL,
    ]);
    expect(connection.handshake).toEqual({
      qwpVersion: 1,
      durableAckEnabled: true,
    });
    await connection.close();
  });

  it("rejects browser durable ACK opt-in without subprotocol confirmation", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpBrowserWebSocket({
      url: "ws://localhost:9000/write/v4",
      requestDurableAck: true,
      webSocketFactory: () => asQwpSocket(socket),
    });
    socket.open();

    await expect(connecting).rejects.toMatchObject({
      name: "QwpDurableAckUnavailableError",
      kind: QWP_UPGRADE_ERROR_KIND.CAPABILITY_MISMATCH,
      retryable: false,
      tryNextEndpoint: true,
      url: "ws://localhost:9000/write/v4",
    } satisfies Partial<QwpDurableAckUnavailableError>);
    expect(socket.closeCalls).toHaveLength(1);
  });

  it("requests browser durable ACKs when the high-level sender awaits them", async () => {
    const socket = new FakeWebSocket();
    socket.protocol = QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL;
    let capturedProtocols: string | string[] | undefined;
    const sender = createQwpBrowserSender(
      {
        url: "ws://localhost:9000/write/v4",
        webSocketFactory: (_url, protocols) => {
          capturedProtocols = protocols;
          return asQwpSocket(socket);
        },
      },
      { awaitDurableAck: true },
    );
    const connecting = sender.connect();
    socket.open();

    await expect(connecting).resolves.toBe(true);
    expect(capturedProtocols).toBe(QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL);
    await sender.close();
  });

  it("walks browser failover endpoints when the upgrade error is opaque", async () => {
    // A browser never learns the HTTP response, so every refused, reset, or
    // non-101 upgrade arrives as a bare `error` event and is classified
    // `opaque` with tryNextEndpoint left undefined. The existing failover
    // coverage injects a factory throw carrying tryNextEndpoint: true, a shape
    // a real browser WebSocket cannot produce, so it cannot observe this.
    const attempted: string[] = [];
    const session = await connectQwpBrowserIngress({
      url: "ws://node-a.example/write/v4",
      failoverUrls: ["ws://node-b.example/write/v4"],
      webSocketFactory: (url) => {
        const requestUrl = new URL(url);
        attempted.push(requestUrl.hostname);
        const socket = new FakeWebSocket();
        queueMicrotask(() => {
          if (requestUrl.hostname === "node-a.example") {
            socket.error();
            socket.close(1006, "");
            return;
          }
          socket.open();
          socket.message(ingressServerInfo(128));
        });
        return asQwpSocket(socket);
      },
    });

    expect(attempted).toEqual(["node-a.example", "node-b.example"]);
    await session.close();
  });

  it("stops the browser failover sweep on an authentication rejection", async () => {
    // Only an explicit tryNextEndpoint: false short-circuits, so a 401 must
    // still fail fast instead of walking the rest of the cluster.
    const attempted: string[] = [];
    await expect(
      connectQwpBrowserIngress({
        url: "ws://node-a.example/write/v4",
        failoverUrls: ["ws://node-b.example/write/v4"],
        sessionBootstrap: {
          authentication: { type: "bearer", token: "token" },
          fetch: async () => new Response("nope", { status: 401 }),
        },
        webSocketFactory: (url) => {
          attempted.push(new URL(url).hostname);
          return asQwpSocket(new FakeWebSocket());
        },
      }),
    ).rejects.toBeInstanceOf(QwpBrowserSessionBootstrapError);
    expect(attempted).toEqual([]);
  });

  it("tears down a reconnect still negotiating when close() is called", async () => {
    // connectingCandidate is assigned only after the factory resolves, so a
    // close() issued while the peer has accepted the socket but not answered
    // the upgrade used to find nothing to cancel: the socket and its deadline
    // stayed alive for up to connectTimeoutMs after close() had resolved.
    const sockets: FakeWebSocket[] = [];
    const session = await connectQwpBrowserIngress(
      {
        url: "ws://stalls.example/write/v4",
        connectTimeoutMs: 30_000,
        webSocketFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          if (sockets.length === 1) {
            queueMicrotask(() => {
              socket.open();
              socket.message(ingressServerInfo(128));
            });
          }
          // Every replacement is left hanging mid-upgrade.
          return asQwpSocket(socket);
        },
      },
      // Reconnection is a session policy, not a socket option; passing it in
      // the first argument silently dropped it and left the default backoff.
      { reconnect: { initialBackoffMs: 0, maxBackoffMs: 0 } },
    );

    sockets[0].close(1006, "dropped");
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(1));
    const pending = sockets[sockets.length - 1];
    expect(pending.closeCalls).toEqual([]);

    await session.close();
    // Closed by close(), not left to the 30s connect deadline.
    expect(pending.closeCalls.length).toBeGreaterThan(0);
  });

  it("aborts a browser bootstrap still pending when its session closes", async () => {
    const socket = new FakeWebSocket();
    let bootstrapCalls = 0;
    let reconnectBootstrapSignal: AbortSignal | null | undefined;
    let rejectReconnectBootstrap: ((error: Error) => void) | undefined;
    const session = await connectQwpBrowserIngress(
      {
        url: "ws://stalls.example/write/v4",
        connectTimeoutMs: 30_000,
        sessionBootstrap: {
          authentication: { type: "bearer", token: "rest-token" },
          fetch: async (_input, init) => {
            bootstrapCalls++;
            if (bootstrapCalls === 1) {
              return new Response("{}", { status: 200 });
            }
            reconnectBootstrapSignal = init?.signal;
            return new Promise<Response>((_resolve, reject) => {
              rejectReconnectBootstrap = reject;
              reconnectBootstrapSignal?.addEventListener(
                "abort",
                () => reject(new Error("bootstrap aborted")),
                { once: true },
              );
            });
          },
        },
        webSocketFactory: () => {
          queueMicrotask(() => {
            socket.open();
            socket.message(ingressServerInfo(128));
          });
          return asQwpSocket(socket);
        },
      },
      { reconnect: { initialBackoffMs: 0, maxBackoffMs: 0 } },
    );

    socket.close(1006, "dropped");
    await vi.waitFor(() => expect(bootstrapCalls).toBe(2));
    await session.close();

    expect(reconnectBootstrapSignal?.aborted).toBe(true);
    expect(rejectReconnectBootstrap).toBeDefined();
  });

  it("attaches the socket error listener before an aborted signal closes it", async () => {
    // A failover sweep hands one AbortSignal to every endpoint in turn, so
    // after close() aborts it the next endpoint enters openQwpWebSocket with
    // the signal already aborted. Acting on it before the listeners were
    // attached closed a CONNECTING socket nothing was subscribed to, and `ws`
    // rethrew the resulting 'error' out of the process instead of rejecting.
    const socket = new FakeNodeWebSocket();
    const controller = new AbortController();
    controller.abort();

    await expect(
      openQwpWebSocket(asQwpSocket(socket), {
        url: "ws://aborted.example/write/v4",
        signal: controller.signal,
        // Never reached: the abort settles the opening before any upgrade.
        completeHandshake: () => ({ qwpVersion: 1, maxBatchSizeBytes: 128 }),
        connectTimeoutMs: 50,
        authTimeoutMs: 50,
        sendTimeoutMs: 50,
        closeTimeoutMs: 50,
      }),
    ).rejects.toBeInstanceOf(QwpSendClosedError);

    // The socket is still closed; only the ordering changed.
    expect(socket.closeCalls.length).toBeGreaterThan(0);
    expect(socket.errorListenerAtClose).not.toContain(false);
  });

  it("uses the browser-selected ingress batch cap automatically", async () => {
    const socket = new FakeWebSocket();
    let capturedUrl: string | URL | undefined;
    const connecting = connectQwpBrowserIngress({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: (url) => {
        capturedUrl = url;
        return asQwpSocket(socket);
      },
    });
    socket.open();
    socket.message(ingressServerInfo(128));

    const session = await connecting;
    expect(
      new URL(capturedUrl!).searchParams.get("qwp_browser_handshake"),
    ).toBe("v1");
    expect(session.handshake.maxBatchSizeBytes).toBe(128);
    expect(session.maxBatchSizeBytes).toBe(128);
    await session.close();
  });

  it("reconnects browser ingress by default and replays from memory", async () => {
    const sockets: FakeWebSocket[] = [];
    const session = await connectQwpBrowserIngress({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        queueMicrotask(() => {
          socket.open();
          socket.message(ingressServerInfo(128));
        });
        return asQwpSocket(socket);
      },
    });

    const pending = session.sendFrame(Uint8Array.of(1));
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    sockets[0].close(1006, "connection lost");

    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await vi.waitFor(() => expect(sockets[1].sent).toEqual(sockets[0].sent));
    sockets[1].message(ingressResponse(QWP_STATUS.OK, 0n));
    await expect(pending).resolves.toMatchObject({
      status: QWP_STATUS.OK,
      sequence: 0n,
    });
    expect(session.metrics.totalFramesReplayed).toBe(1);
    await session.close();
  });

  it("retries a rate-limited browser bootstrap during reconnect", async () => {
    const sockets: FakeWebSocket[] = [];
    const bootstrapStatuses: number[] = [];
    const session = await connectQwpBrowserIngress(
      {
        url: "ws://localhost:9000/write/v4",
        sessionBootstrap: {
          authentication: { type: "bearer", token: "access-token" },
          fetch: async () => {
            const status = bootstrapStatuses.length === 1 ? 429 : 200;
            bootstrapStatuses.push(status);
            return new Response(status === 429 ? "rate limited" : "{}", {
              status,
              statusText: status === 429 ? "Too Many Requests" : "OK",
            });
          },
        },
        webSocketFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          queueMicrotask(() => {
            socket.open();
            socket.message(ingressServerInfo(128));
          });
          return asQwpSocket(socket);
        },
      },
      {
        reconnect: {
          initialBackoffMs: 0,
          maxBackoffMs: 0,
          maxAttempts: 3,
        },
      },
    );

    const pending = session.sendFrame(Uint8Array.of(1));
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    sockets[0].close(1006, "connection lost");

    await vi.waitFor(() => expect(bootstrapStatuses).toEqual([200, 429, 200]));
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await vi.waitFor(() => expect(sockets[1].sent).toEqual(sockets[0].sent));
    sockets[1].message(ingressResponse(QWP_STATUS.OK, 0n));
    await expect(pending).resolves.toMatchObject({
      status: QWP_STATUS.OK,
      sequence: 0n,
    });
    expect(session.metrics.totalFramesReplayed).toBe(1);
    await session.close();
  });

  it("uses the local-publication flush boundary in browsers by default", async () => {
    const socket = new FakeWebSocket();
    const sender = createQwpBrowserSender(
      {
        url: "ws://localhost:9000/write/v4",
        webSocketFactory: () => asQwpSocket(socket),
      },
      { autoFlush: false, closeFlushTimeoutMs: 0 },
    );
    const connecting = sender.connect();
    socket.open();
    socket.message(ingressServerInfo(1_024));
    await connecting;

    await sender.table("events").longColumn("value", 42n).atNow();
    await expect(sender.flush()).resolves.toBe(true);
    expect(socket.sent).toHaveLength(1);
    expect(sender.publishedSequence).toBe(0n);
    expect(sender.acknowledgedSequence).toBe(-1n);
    await sender.close();
  });

  it("splits fluent browser rows under the negotiated server cap", async () => {
    const socket = new FakeWebSocket();
    const sender = createQwpBrowserSender(
      {
        url: "ws://localhost:9000/write/v4",
        webSocketFactory: () => asQwpSocket(socket),
      },
      { autoFlush: false, encode: { gorilla: false } },
    );
    const connecting = sender.connect();
    socket.open();
    socket.message(ingressServerInfo(128));
    await connecting;
    for (let value = 0; value < 50; value++) {
      await sender.table("events").longColumn("value", value).atNow();
    }
    socket.onSend = () => {
      const sequence = BigInt(socket.sent.length - 1);
      socket.message(ingressResponse(QWP_STATUS.OK, sequence));
    };

    await expect(sender.flush()).resolves.toBe(true);
    expect(socket.sent.length).toBeGreaterThan(1);
    expect(socket.sent.every((frame) => frame.byteLength <= 128)).toBe(true);
    await sender.close();
  });

  it("negotiates browser Zstd and exposes the effective selected level", async () => {
    const socket = new FakeWebSocket();
    let capturedUrl: string | URL | undefined;
    let capturedProtocols: string | string[] | undefined;
    const connecting = connectQwpBrowserEgress({
      url: "ws://localhost:9000/read/v1",
      compression: "zstd",
      compressionLevel: 7,
      maxBatchRows: 512,
      webSocketFactory: (url, protocols) => {
        capturedUrl = url;
        capturedProtocols = protocols;
        return asQwpSocket(socket);
      },
    });
    socket.open();
    socket.message(
      serverInfoFrame({ codec: QWP_COMPRESSION_CODEC.ZSTD, level: 3 }),
    );

    const session = await connecting;
    expect(capturedProtocols).toBeUndefined();
    expect(new URL(capturedUrl!).searchParams.get("qwp_accept_encoding")).toBe(
      "zstd;level=7,raw",
    );
    expect(new URL(capturedUrl!).searchParams.get("qwp_max_batch_rows")).toBe(
      "512",
    );
    expect(session.negotiatedCompression).toEqual({
      codec: "zstd",
      level: 3,
    });
    expect(session.negotiatedZstdLevel).toBe(3);
    await session.close();
  });

  it("automatically splits fluent browser sender rows under its configured cap", async () => {
    const socket = new FakeWebSocket();
    const sizingDictionary = new QwpSymbolDictionary();
    const cap = encodeQwpIngressFrame([longTable("events", [1n])], {
      gorilla: false,
      dictionary: sizingDictionary,
      confirmedMaxSymbolId: -1,
    }).byteLength;
    const sender = createQwpBrowserSender(
      {
        url: "ws://localhost:9000/write/v4",
        webSocketFactory: () => asQwpSocket(socket),
      },
      { autoFlush: false, encode: { gorilla: false } },
      { maxBatchSizeBytes: cap },
    );
    const connecting = sender.connect();
    socket.open();
    await connecting;
    for (const value of [1n, 2n, 3n]) {
      await sender.table("events").longColumn("value", value).atNow();
    }
    socket.onSend = () => {
      const sequence = BigInt(socket.sent.length - 1);
      socket.message(ingressResponse(QWP_STATUS.OK, sequence));
    };

    await expect(sender.flush()).resolves.toBe(true);
    expect(socket.sent).toHaveLength(3);
    expect(socket.sent.every((frame) => frame.byteLength <= cap)).toBe(true);
    expect(socket.sent.map(firstIngressTableRowCount)).toEqual([1, 1, 1]);
    await sender.close();
  });

  it("retains an over-cap batch at flush and discards it on close", async () => {
    const socket = new FakeWebSocket();
    const cap = 200;
    const sender = createQwpBrowserSender(
      {
        url: "ws://localhost:9000/write/v4",
        webSocketFactory: () => asQwpSocket(socket),
      },
      { autoFlush: false, encode: { gorilla: false } },
      { maxBatchSizeBytes: cap },
    );
    const connecting = sender.connect();
    socket.open();
    await connecting;
    socket.onSend = () => {
      const sequence = BigInt(socket.sent.length - 1);
      socket.message(ingressResponse(QWP_STATUS.OK, sequence));
    };

    // The splitter bisects a batch down to single rows; one row above the cap
    // is unsplittable and always re-encodes to the same oversized frame.
    await sender.table("events").stringColumn("v", "x".repeat(500)).atNow();

    // A cap rejection retains the batch and invites a retry, matching the Java
    // client, whose split throw "RETAINS the batch by design".
    await expect(sender.flush()).rejects.toBeInstanceOf(QwpBatchTooLargeError);
    expect(sender.metrics.pendingRows).toBe(1);
    await expect(sender.flush()).rejects.toBeInstanceOf(QwpBatchTooLargeError);
    expect(sender.metrics.pendingRows).toBe(1);

    // close() is the way out: it discards the batch the cap will never accept,
    // surfaces the error, and still completes shutdown. Java does the same via
    // resetTableBuffersAfterFlush().
    await expect(sender.close()).rejects.toBeInstanceOf(QwpBatchTooLargeError);
    expect(sender.metrics.pendingRows).toBe(0);
    expect(socket.sent).toHaveLength(0);
  });

  it("pipelines transactional browser auto-flush until an explicit commit ACK", async () => {
    const socket = new FakeWebSocket();
    const sender = createQwpBrowserSender(
      {
        url: "ws://localhost:9000/write/v4",
        webSocketFactory: () => asQwpSocket(socket),
      },
      {
        autoFlushRows: 1,
        autoFlushIntervalMs: 0,
        transactional: true,
      },
      { ackTimeoutMs: 10 },
    );
    socket.onSend = () => {
      if (socket.sent.length === 2) {
        socket.message(
          ingressResponse(QWP_STATUS.OK, 1n, undefined, [["events", 1n]]),
        );
      }
    };
    const connecting = sender.connect();
    socket.open();
    await connecting;

    const autoFlush = sender.table("events").longColumn("value", 42n).atNow();
    await expect(autoFlush).resolves.toBeUndefined();
    expect(socket.sent).toHaveLength(1);
    expect(decodeQwpFrame(socket.sent[0]).flags & QWP_FLAG_DEFER_COMMIT).toBe(
      QWP_FLAG_DEFER_COMMIT,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    await expect(sender.flush()).resolves.toBe(true);
    expect(socket.sent).toHaveLength(2);
    expect(decodeQwpFrame(socket.sent[1]).flags & QWP_FLAG_DEFER_COMMIT).toBe(
      0,
    );
    expect(sender.metrics).toMatchObject({
      totalRowsStaged: 1,
      totalRowsPublished: 1,
      totalFlushes: 2,
      totalTransactionsCommitted: 1,
      ingress: {
        publishedSequence: 1n,
        acknowledgedSequence: 1n,
        totalFramesPublished: 2,
        totalFramesSent: 2,
        totalAcks: 1,
      },
    });
    await sender.close();
  });

  it("adds Node-only QWP upgrade headers", async () => {
    const socket = new FakeWebSocket();
    let capturedHeaders: Record<string, string> | undefined;
    const connecting = connectQwpNodeWebSocket({
      url: "ws://localhost:9000/write/v4",
      authorization: "Basic token",
      clientId: "typescript/test",
      requestDurableAck: true,
      webSocketFactory: (_url, options) => {
        capturedHeaders = options.headers;
        options.onUpgrade({
          "x-qwp-version": "1",
          "x-qwp-max-batch-size": "4096",
          "x-qwp-content-encoding": "raw",
          "x-qwp-durable-ack": "enabled",
          "x-questdb-role": "primary",
        });
        return asQwpSocket(socket);
      },
    });
    socket.open();
    const connection = await connecting;
    expect(capturedHeaders).toMatchObject({
      "X-QWP-Max-Version": "1",
      "X-QWP-Client-Id": "typescript/test",
      "X-QWP-Request-Durable-Ack": "true",
      Authorization: "Basic token",
    });
    expect(connection.handshake).toEqual({
      qwpVersion: 1,
      maxBatchSizeBytes: 4096,
      contentEncoding: "raw",
      negotiatedCompression: { codec: "raw", level: 0 },
      durableAckEnabled: true,
      serverRole: "primary",
    });
    const session = new QwpIngressSession(connection, {
      maxBatchSizeBytes: 8192,
    });
    expect(session.maxBatchSizeBytes).toBe(4096);
    await expect(
      session.sendFrame(new Uint8Array(4097)),
    ).rejects.toBeInstanceOf(QwpBatchTooLargeError);
    socket.onSend = () => {
      const sequence = BigInt(socket.sent.length - 1);
      socket.message(ingressResponse(QWP_STATUS.OK, sequence));
    };
    const table = new QwpTableBuffer("events");
    for (const suffix of ["a", "b"]) {
      table
        .getOrCreateColumn("payload", QWP_COLUMN_TYPE.VARCHAR)!
        .values.push(suffix.repeat(3_000));
      table.nextRow();
    }
    await session.sendTables([table]);
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent.every((frame) => frame.byteLength <= 4096)).toBe(true);
    await session.close();
  });

  it.each(["zstd", "auto"] as const)(
    "negotiates %s compression for Node egress",
    async (compression) => {
      const socket = new FakeWebSocket();
      let capturedHeaders: Record<string, string> | undefined;
      const connecting = connectQwpNodeEgress({
        url: "ws://localhost:9000/read/v1",
        compression,
        compressionLevel: 5,
        maxBatchRows: 512,
        webSocketFactory: (_url, options) => {
          capturedHeaders = options.headers;
          options.onUpgrade({
            "x-qwp-content-encoding": "zstd;level=5",
          });
          return asQwpSocket(socket);
        },
      });
      socket.open();
      socket.message(serverInfoFrame());

      const session = await connecting;
      expect(capturedHeaders).toMatchObject({
        "X-QWP-Accept-Encoding": "zstd;level=5,raw",
        "X-QWP-Max-Batch-Rows": "512",
      });
      expect(session.handshake.contentEncoding).toBe("zstd;level=5");
      expect(session.negotiatedCompression).toEqual({
        codec: "zstd",
        level: 5,
      });
      expect(session.negotiatedZstdLevel).toBe(5);
      await session.close();
    },
  );

  it("keeps raw egress compatible with custom low-level headers", async () => {
    const socket = new FakeWebSocket();
    let capturedHeaders: Record<string, string> | undefined;
    const connecting = connectQwpNodeEgress({
      url: "ws://localhost:9000/read/v1",
      headers: { "x-qwp-accept-encoding": "custom" },
      webSocketFactory: (_url, options) => {
        capturedHeaders = options.headers;
        options.onUpgrade({});
        return asQwpSocket(socket);
      },
    });
    socket.open();
    socket.message(serverInfoFrame());

    const session = await connecting;
    expect(capturedHeaders?.["x-qwp-accept-encoding"]).toBe("custom");
    expect(session.negotiatedCompression).toEqual({
      codec: "raw",
      level: 0,
    });
    expect(session.negotiatedZstdLevel).toBe(0);
    await session.close();
  });

  it.each([
    { compression: "zstd" as const, compressionLevel: 0 },
    { compression: "zstd" as const, compressionLevel: 23 },
    { compression: "invalid" as "zstd", compressionLevel: 1 },
  ])("rejects invalid egress compression options", async (options) => {
    let factoryCalls = 0;
    await expect(
      connectQwpNodeEgress({
        url: "ws://localhost:9000/read/v1",
        ...options,
        webSocketFactory: () => {
          factoryCalls++;
          return asQwpSocket(new FakeWebSocket());
        },
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(factoryCalls).toBe(0);
  });

  it.each([0, 1_048_577, 1.5])(
    "rejects invalid egress maxBatchRows %s before opening a socket",
    async (maxBatchRows) => {
      let factoryCalls = 0;
      await expect(
        connectQwpNodeEgress({
          url: "ws://localhost:9000/read/v1",
          maxBatchRows,
          webSocketFactory: () => {
            factoryCalls++;
            return asQwpSocket(new FakeWebSocket());
          },
        }),
      ).rejects.toThrow(
        "maxBatchRows must be an integer between 1 and 1048576",
      );
      expect(factoryCalls).toBe(0);

      await expect(
        connectQwpBrowserEgress({
          url: "ws://localhost:9000/read/v1",
          maxBatchRows,
          webSocketFactory: () => {
            factoryCalls++;
            return asQwpSocket(new FakeWebSocket());
          },
        }),
      ).rejects.toThrow(
        "maxBatchRows must be an integer between 1 and 1048576",
      );
      expect(factoryCalls).toBe(0);
    },
  );

  it("uses the legacy handshake defaults when optional headers are absent", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpNodeWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: (_url, options) => {
        options.onUpgrade({
          "x-qwp-version": "not-a-number",
          "x-qwp-max-batch-size": "not-a-number",
        });
        return asQwpSocket(socket);
      },
    });
    socket.open();

    const connection = await connecting;
    expect(connection.handshake).toEqual({
      qwpVersion: 1,
      maxBatchSizeBytes: undefined,
      contentEncoding: undefined,
      negotiatedCompression: { codec: "raw", level: 0 },
      durableAckEnabled: false,
      serverRole: undefined,
    });
    await connection.close();
  });

  it("rejects an unsupported server QWP version", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpNodeWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: (_url, options) => {
        options.onUpgrade({ "x-qwp-version": "2" });
        return asQwpSocket(socket);
      },
    });
    socket.open();

    await expect(connecting).rejects.toMatchObject({
      name: "QwpVersionMismatchError",
      serverVersion: 2,
      clientMaxVersion: 1,
      kind: QWP_UPGRADE_ERROR_KIND.VERSION_MISMATCH,
      retryable: true,
      tryNextEndpoint: true,
      url: "ws://localhost:9000/write/v4",
    } satisfies Partial<QwpVersionMismatchError>);
    expect(socket.closeCalls).toHaveLength(1);
  });

  it("rejects durable ACK opt-in when the server omits confirmation", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpNodeWebSocket({
      url: "ws://localhost:9000/write/v4",
      requestDurableAck: true,
      webSocketFactory: (_url, options) => {
        options.onUpgrade({});
        return asQwpSocket(socket);
      },
    });
    socket.open();

    await expect(connecting).rejects.toMatchObject({
      name: "QwpDurableAckUnavailableError",
      kind: QWP_UPGRADE_ERROR_KIND.CAPABILITY_MISMATCH,
      retryable: false,
      tryNextEndpoint: true,
    } satisfies Partial<QwpDurableAckUnavailableError>);
    expect(socket.closeCalls).toHaveLength(1);
  });

  it.each([
    {
      statusCode: 401,
      statusMessage: "Unauthorized",
      headers: {},
      kind: QWP_UPGRADE_ERROR_KIND.AUTHENTICATION,
      retryable: false,
      tryNextEndpoint: false,
    },
    {
      statusCode: 421,
      statusMessage: "Misdirected Request",
      headers: {
        "x-questdb-role": "REPLICA",
        "x-questdb-zone": "eu-west-1",
      },
      kind: QWP_UPGRADE_ERROR_KIND.ROLE_REJECTED,
      retryable: true,
      tryNextEndpoint: true,
    },
    {
      // A rolling restart behind a proxy answers 503 for a few seconds. The
      // reconnect loop must keep sweeping instead of latching terminal.
      statusCode: 503,
      statusMessage: "Service Unavailable",
      headers: {},
      kind: QWP_UPGRADE_ERROR_KIND.HTTP_REJECTED,
      retryable: true,
      tryNextEndpoint: true,
    },
    {
      statusCode: 502,
      statusMessage: "Bad Gateway",
      headers: {},
      kind: QWP_UPGRADE_ERROR_KIND.HTTP_REJECTED,
      retryable: true,
      tryNextEndpoint: true,
    },
    {
      statusCode: 429,
      statusMessage: "Too Many Requests",
      headers: {},
      kind: QWP_UPGRADE_ERROR_KIND.HTTP_REJECTED,
      retryable: true,
      tryNextEndpoint: true,
    },
    {
      // A 4xx that is not 401/403/421/429 is a client-side mistake, so
      // byte-identical replay cannot fix it and the sweep must not retry it.
      statusCode: 404,
      statusMessage: "Not Found",
      headers: {},
      kind: QWP_UPGRADE_ERROR_KIND.HTTP_REJECTED,
      retryable: false,
      tryNextEndpoint: true,
    },
  ])(
    "classifies an HTTP $statusCode upgrade rejection",
    async ({
      statusCode,
      statusMessage,
      headers,
      kind,
      retryable,
      tryNextEndpoint,
    }) => {
      const socket = new FakeWebSocket();
      const connecting = connectQwpNodeWebSocket({
        url: "ws://localhost:9000/write/v4",
        webSocketFactory: (_url, options) => {
          options.onUpgradeRejected({ statusCode, statusMessage, headers });
          return asQwpSocket(socket);
        },
      });

      const error = await connecting.catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        name: "QwpUpgradeError",
        kind,
        retryable,
        tryNextEndpoint,
        statusCode,
        statusMessage,
        url: "ws://localhost:9000/write/v4",
      } satisfies Partial<QwpUpgradeError>);
      if (statusCode === 421) {
        expect(error).toMatchObject({
          serverRole: "REPLICA",
          serverZone: "eu-west-1",
          isTopologicalRoleReject: true,
          isTransientRoleReject: false,
        } satisfies Partial<QwpUpgradeError>);
      }
    },
  );

  it("reports browser upgrade failures as opaque", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpBrowserWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: () => asQwpSocket(socket),
    });
    socket.error();

    await expect(connecting).rejects.toMatchObject({
      name: "QwpUpgradeError",
      kind: QWP_UPGRADE_ERROR_KIND.OPAQUE,
      retryable: undefined,
      tryNextEndpoint: undefined,
      statusCode: undefined,
      serverRole: undefined,
    } satisfies Partial<QwpUpgradeError>);
    await vi.waitFor(() => expect(socket.listenerCount()).toBe(0));
    expect(socket.closeCalls).toHaveLength(1);
  });

  it("classifies Node opening errors as retriable transport failures", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpNodeWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: () => asQwpSocket(socket),
    });
    socket.error();

    await expect(connecting).rejects.toMatchObject({
      name: "QwpUpgradeError",
      kind: QWP_UPGRADE_ERROR_KIND.TRANSPORT,
      retryable: true,
      tryNextEndpoint: true,
      statusCode: undefined,
    } satisfies Partial<QwpUpgradeError>);
  });

  it("rejects a connection that does not open before its deadline", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeWebSocket();
      const connecting = connectQwpBrowserWebSocket({
        url: "ws://localhost:9000/write/v4",
        connectTimeoutMs: 25,
        webSocketFactory: () => asQwpSocket(socket),
      });
      const rejected = expect(connecting).rejects.toMatchObject({
        name: "QwpUpgradeError",
        kind: QWP_UPGRADE_ERROR_KIND.TIMEOUT,
        retryable: true,
        tryNextEndpoint: true,
      } satisfies Partial<QwpUpgradeError>);
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(socket.closeCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("separately bounds Node transport connection and authenticated upgrade", async () => {
    vi.useFakeTimers();
    try {
      const connectSocket = new FakeWebSocket();
      const connecting = connectQwpNodeWebSocket({
        url: "ws://localhost:9000/write/v4",
        connectTimeoutMs: 25,
        authTimeoutMs: 100,
        webSocketFactory: () => asQwpSocket(connectSocket),
      });
      const connectRejected = expect(connecting).rejects.toMatchObject({
        name: "QwpUpgradeError",
        kind: QWP_UPGRADE_ERROR_KIND.TIMEOUT,
        timeoutPhase: QWP_UPGRADE_TIMEOUT_PHASE.CONNECT,
        message: "QWP TCP/TLS connection timed out after 25ms",
      } satisfies Partial<QwpUpgradeError>);
      await vi.advanceTimersByTimeAsync(25);
      await connectRejected;

      const upgradeSocket = new FakeWebSocket();
      let markUpgradeTransportConnected!: () => void;
      const upgrading = connectQwpNodeWebSocket({
        url: "ws://localhost:9000/write/v4",
        connectTimeoutMs: 100,
        authTimeoutMs: 25,
        webSocketFactory: (_url, options) => {
          markUpgradeTransportConnected = options.onConnected;
          return asQwpSocket(upgradeSocket);
        },
      });
      const upgradeRejected = expect(upgrading).rejects.toMatchObject({
        name: "QwpUpgradeError",
        kind: QWP_UPGRADE_ERROR_KIND.TIMEOUT,
        timeoutPhase: QWP_UPGRADE_TIMEOUT_PHASE.AUTHENTICATION,
        message: "QWP authentication/WebSocket upgrade timed out after 25ms",
      } satisfies Partial<QwpUpgradeError>);
      markUpgradeTransportConnected();
      await vi.advanceTimersByTimeAsync(25);
      await upgradeRejected;

      const phasedSocket = new FakeWebSocket();
      let markPhasedTransportConnected!: () => void;
      const phased = connectQwpNodeWebSocket({
        url: "ws://localhost:9000/write/v4",
        connectTimeoutMs: 25,
        authTimeoutMs: 25,
        webSocketFactory: (_url, options) => {
          markPhasedTransportConnected = options.onConnected;
          options.onUpgrade({});
          return asQwpSocket(phasedSocket);
        },
      });
      await vi.advanceTimersByTimeAsync(20);
      markPhasedTransportConnected();
      await vi.advanceTimersByTimeAsync(20);
      phasedSocket.open();
      const phasedConnection = await phased;
      expect(phasedConnection).toMatchObject({
        handshake: { qwpVersion: 1 },
      });
      await phasedConnection.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("validates the Node authentication/upgrade timeout before opening", async () => {
    let factoryCalls = 0;
    await expect(
      connectQwpNodeWebSocket({
        url: "ws://localhost:9000/write/v4",
        authTimeoutMs: 0,
        webSocketFactory: () => {
          factoryCalls++;
          return asQwpSocket(new FakeWebSocket());
        },
      }),
    ).rejects.toThrow("authTimeoutMs must be a positive finite number");
    expect(factoryCalls).toBe(0);
  });

  it("bounds browser close when the peer never emits a close event", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeStuckCloseWebSocket();
      const connecting = connectQwpBrowserWebSocket({
        url: "ws://localhost:9000/write/v4",
        closeTimeoutMs: 25,
        webSocketFactory: () => asQwpSocket(socket),
      });
      socket.open();
      const connection = await connecting;

      const closing = connection.close(1000, "client shutdown");
      await vi.advanceTimersByTimeAsync(25);
      await expect(closing).resolves.toBeUndefined();
      await expect(connection.closed).resolves.toEqual({
        code: 1006,
        reason: "QWP WebSocket close timed out after 25ms",
        wasClean: false,
      });
      expect(socket.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds cleanup when a browser Blob conversion never settles", async () => {
    vi.useFakeTimers();
    try {
      class NeverSettlingBlob extends Blob {
        arrayBuffer(): Promise<ArrayBuffer> {
          return new Promise(() => undefined);
        }
      }
      const socket = new FakeWebSocket();
      const connecting = connectQwpBrowserWebSocket({
        url: "ws://localhost:9000/write/v4",
        closeTimeoutMs: 25,
        webSocketFactory: () => asQwpSocket(socket),
      });
      socket.open();
      const connection = await connecting;
      const next = connection.messages[Symbol.asyncIterator]().next();
      socket.message(new NeverSettlingBlob([]));
      await vi.advanceTimersByTimeAsync(0);

      const closing = connection.close();
      await vi.advanceTimersByTimeAsync(25);
      await expect(closing).resolves.toBeUndefined();
      await expect(next).resolves.toEqual({ value: undefined, done: true });
      expect(socket.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates a stuck Node WebSocket after the close deadline", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeStuckCloseNodeWebSocket();
      const connecting = connectQwpNodeWebSocket({
        url: "ws://localhost:9000/write/v4",
        closeTimeoutMs: 25,
        webSocketFactory: (_url, options) => {
          options.onUpgrade({});
          return asQwpSocket(socket);
        },
      });
      socket.open();
      const connection = await connecting;

      const closing = connection.close();
      await vi.advanceTimersByTimeAsync(25);
      await closing;
      expect(socket.terminateCalls).toBe(1);
      expect(socket.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes browser sends until buffered bytes drain", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeBackpressuredWebSocket();
      const connecting = connectQwpBrowserWebSocket({
        url: "ws://localhost:9000/write/v4",
        sendTimeoutMs: 100,
        webSocketFactory: () => asQwpSocket(socket),
      });
      socket.open();
      const connection = await connecting;

      const first = connection.send(Uint8Array.of(1));
      const second = connection.send(Uint8Array.of(2));
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.sent).toEqual([Uint8Array.of(1)]);

      socket.drain();
      await vi.advanceTimersByTimeAsync(4);
      await expect(first).resolves.toBeUndefined();
      expect(socket.sent).toEqual([Uint8Array.of(1), Uint8Array.of(2)]);

      socket.drain();
      await vi.advanceTimersByTimeAsync(4);
      await expect(second).resolves.toBeUndefined();
      await connection.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a browser send that remains buffered", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeBackpressuredWebSocket();
      const connecting = connectQwpBrowserWebSocket({
        url: "ws://localhost:9000/write/v4",
        sendTimeoutMs: 25,
        webSocketFactory: () => asQwpSocket(socket),
      });
      socket.open();
      const connection = await connecting;

      const sending = connection.send(Uint8Array.of(1, 2, 3));
      const caught = sending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(25);
      const error = await caught;
      expect(error).toMatchObject({
        name: "QwpSendTimeoutError",
        timeoutMs: 25,
        bufferedAmountBytes: 3,
      } satisfies Partial<QwpSendTimeoutError>);
      expect(socket.closeCalls).toContainEqual({
        code: 1011,
        reason: "QWP send failed",
      });
      await expect(connection.send(Uint8Array.of(4))).rejects.toBe(error);
      expect(socket.sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a buffered send when the WebSocket closes", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeBackpressuredWebSocket();
      const connecting = connectQwpBrowserWebSocket({
        url: "ws://localhost:9000/write/v4",
        sendTimeoutMs: 100,
        webSocketFactory: () => asQwpSocket(socket),
      });
      socket.open();
      const connection = await connecting;

      const caught = connection
        .send(Uint8Array.of(1))
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      socket.close(1001, "server shutdown");
      await expect(caught).resolves.toMatchObject({
        name: "QwpSendClosedError",
        closeInfo: {
          code: 1001,
          reason: "server shutdown",
          wasClean: true,
        },
      } satisfies Partial<QwpSendClosedError>);
    } finally {
      vi.useRealTimers();
    }
  });

  it("close interrupts a backpressured send and clears its timers", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeBackpressuredWebSocket();
      const connecting = connectQwpBrowserWebSocket({
        url: "ws://localhost:9000/write/v4",
        sendTimeoutMs: 60_000,
        webSocketFactory: () => asQwpSocket(socket),
      });
      socket.open();
      const connection = await connecting;
      const sending = connection
        .send(Uint8Array.of(1))
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);

      await expect(connection.close()).resolves.toBeUndefined();
      await expect(sending).resolves.toBeInstanceOf(QwpSendClosedError);
      expect(vi.getTimerCount()).toBe(0);
      expect(socket.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles and cleans up after a post-upgrade transport error", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpBrowserWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: () => asQwpSocket(socket),
    });
    socket.open();
    const connection = await connecting;
    const next = connection.messages[Symbol.asyncIterator]().next();

    socket.error();
    await expect(next).rejects.toThrow("QWP WebSocket transport error");
    await expect(connection.closed).resolves.toMatchObject({ code: 1011 });
    await connection.close();
    expect(socket.listenerCount()).toBe(0);
  });

  it("awaits Node send callbacks and preserves send order", async () => {
    const socket = new FakeCallbackWebSocket();
    const connecting = connectQwpNodeWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: (_url, options) => {
        options.onUpgrade({});
        return asQwpSocket(socket);
      },
    });
    socket.open();
    const connection = await connecting;

    const first = connection.send(Uint8Array.of(1));
    const second = connection.send(Uint8Array.of(2));
    await vi.waitFor(() => expect(socket.sent).toEqual([Uint8Array.of(1)]));
    socket.completeSend();
    await expect(first).resolves.toBeUndefined();
    await vi.waitFor(() =>
      expect(socket.sent).toEqual([Uint8Array.of(1), Uint8Array.of(2)]),
    );
    socket.completeSend();
    await expect(second).resolves.toBeUndefined();
    await connection.close();
  });

  it("rejects text frames and closes with a protocol error", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpBrowserWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: () => asQwpSocket(socket),
    });
    socket.open();
    const connection = await connecting;
    const next = connection.messages[Symbol.asyncIterator]().next();
    const rejected = expect(next).rejects.toThrow(/non-binary/i);
    socket.message("not binary");
    await rejected;
    expect(socket.closeCalls).toContainEqual({
      code: 1002,
      reason: "invalid QWP payload",
    });
  });
});

describe("QwpIngressSession", () => {
  it("returns the highest split-frame sequence from the browser sender", async () => {
    const socket = new FakeWebSocket();
    const cap = encodeQwpIngressFrame([longTable("events", [1n])], {
      gorilla: false,
    }).byteLength;
    const sender = createQwpBrowserSender(
      {
        url: "ws://localhost:9000/write/v4",
        webSocketFactory: () => asQwpSocket(socket),
      },
      {
        autoFlush: false,
        encode: { symbolDictionary: "full", gorilla: false },
      },
      { maxBatchSizeBytes: cap },
    );
    const connecting = sender.connect();
    socket.open();
    await connecting;
    for (const value of [1n, 2n, 3n, 4n]) {
      await sender.table("events").longColumn("value", value).atNow();
    }

    await expect(sender.flushAndGetSequence()).resolves.toBe(3n);
    expect(sender.publishedSequence).toBe(3n);
    expect(socket.sent.map(firstIngressTableRowCount)).toEqual([1, 1, 1, 1]);
    const acknowledged = sender.waitForAcknowledged(3n, 1_000);
    socket.message(
      ingressResponse(QWP_STATUS.OK, 3n, undefined, [["events", 4n]]),
    );
    await expect(acknowledged).resolves.toBeUndefined();
    expect(sender.acknowledgedSequence).toBe(3n);
    await sender.close();
  });

  it("publishes frame sequences and resolves cumulative ACK waits independently", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpBrowserWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: () => asQwpSocket(socket),
    });
    socket.open();
    const session = new QwpIngressSession(await connecting);

    await session.publishFrame(Uint8Array.of(1));
    expect(session.publishedFrameSequence).toBe(0n);
    await session.publishFrame(Uint8Array.of(2));
    expect(session.publishedFrameSequence).toBe(1n);
    expect(session.acknowledgedFrameSequence).toBe(-1n);

    const first = session.waitForAcknowledged(0n, 1_000);
    const second = session.waitForAcknowledged(1n, 1_000);
    socket.message(ingressResponse(QWP_STATUS.OK, 1n));
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(session.acknowledgedFrameSequence).toBe(1n);
    await expect(session.waitForAcknowledged(-1n)).resolves.toBeUndefined();
    await session.close();
  });

  it("times out an independent ACK watermark wait without closing the session", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeWebSocket();
      const connecting = connectQwpBrowserWebSocket({
        url: "ws://localhost:9000/write/v4",
        webSocketFactory: () => asQwpSocket(socket),
      });
      socket.open();
      const session = new QwpIngressSession(await connecting);
      await session.publishFrame(Uint8Array.of(1));
      const sequence = session.publishedFrameSequence;
      const waiting = session.waitForAcknowledged(sequence, 25);
      const timedOut = expect(waiting).rejects.toEqual(
        expect.objectContaining({
          name: "QwpIngressAckTimeoutError",
          targetSequence: 0n,
          acknowledgedSequence: -1n,
          timeoutMs: 25,
        } satisfies Partial<QwpIngressAckTimeoutError>),
      );

      await vi.advanceTimersByTimeAsync(25);
      await timedOut;
      expect(session.metrics.lastError).toBeInstanceOf(
        QwpIngressAckTimeoutError,
      );
      await expect(
        session.publishFrame(Uint8Array.of(2)),
      ).resolves.toBeUndefined();
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the durable watermark when durable ACKs are negotiated", async () => {
    const socket = new FakeWebSocket();
    socket.protocol = QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL;
    const connecting = connectQwpBrowserIngress(
      {
        url: "ws://localhost:9000/write/v4",
        requestDurableAck: true,
        webSocketFactory: () => asQwpSocket(socket),
      },
      { durableAckKeepaliveMs: 0 },
    );
    socket.open();
    const session = await connecting;
    socket.onSend = () => {
      socket.message(
        ingressResponse(QWP_STATUS.OK, 0n, undefined, [["trades", 42n]]),
      );
    };

    await session.publishFrame(Uint8Array.of(1));
    const sequence = session.publishedFrameSequence;
    await vi.waitFor(() =>
      expect(session.metrics.acknowledgedSequence).toBe(0n),
    );
    expect(session.acknowledgedFrameSequence).toBe(-1n);
    let settled = false;
    const waiting = session.waitForAcknowledged(sequence, 1_000).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.message(durableResponse([["trades", 42n]]));
    await waiting;
    expect(session.acknowledgedFrameSequence).toBe(0n);
    await session.close();
  });

  it("fails a fixed session and its ACK waiters after a publication-only NACK", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpBrowserWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: () => asQwpSocket(socket),
    });
    socket.open();
    const session = new QwpIngressSession(await connecting);
    await session.publishFrame(Uint8Array.of(1));
    await session.publishFrame(Uint8Array.of(2));
    const acknowledged = session.waitForAcknowledged(1n, 1_000);
    socket.message(ingressResponse(QWP_STATUS.WRITE_ERROR, 0n, "write failed"));

    await expect(acknowledged).rejects.toMatchObject({
      name: "QwpIngressNackError",
      response: { sequence: 0n, errorMessage: "write failed" },
    } satisfies QwpIngressNackMatch);
    expect(() => session.publishFrame(Uint8Array.of(3))).toThrow(
      "write failed",
    );
    expect(socket.closeCalls).toContainEqual({
      code: 1002,
      reason: "QWP ingress pipeline rejected",
    });
    await session.close();
  });

  it("validates session timeouts before invoking its connection factory", async () => {
    let factoryCalls = 0;
    await expect(
      QwpIngressSession.connect(
        async () => {
          factoryCalls++;
          throw new Error("must not connect");
        },
        { ackTimeoutMs: Number.NaN },
      ),
    ).rejects.toThrow("ackTimeoutMs must be a positive finite number");
    expect(factoryCalls).toBe(0);
  });

  it("rejects browser durable keepalives without requesting negotiation", async () => {
    let factoryCalls = 0;
    await expect(
      connectQwpBrowserIngress(
        {
          url: "ws://localhost:9000/write/v4",
          webSocketFactory: () => {
            factoryCalls++;
            return asQwpSocket(new FakeWebSocket());
          },
        },
        { durableAckKeepaliveMs: 5 },
      ),
    ).rejects.toThrow("durableAckKeepaliveMs requires requestDurableAck=true");
    expect(factoryCalls).toBe(0);
  });

  it("close aborts a send blocked by browser backpressure", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeBackpressuredWebSocket();
      const connecting = connectQwpBrowserWebSocket({
        url: "ws://localhost:9000/write/v4",
        sendTimeoutMs: 60_000,
        webSocketFactory: () => asQwpSocket(socket),
      });
      socket.open();
      const session = new QwpIngressSession(await connecting, {
        ackTimeoutMs: 60_000,
      });
      const sending = session
        .sendFrame(Uint8Array.of(1))
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);

      await expect(session.close()).resolves.toBeUndefined();
      await expect(sending).resolves.toBeInstanceOf(
        QwpIngressSessionClosedError,
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an oversized batch locally without consuming its sequence", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpBrowserWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: () => asQwpSocket(socket),
    });
    socket.open();
    const session = new QwpIngressSession(await connecting, {
      maxBatchSizeBytes: 3,
    });
    expect(session.maxBatchSizeBytes).toBe(3);

    await expect(session.sendFrame(Uint8Array.of(1, 2, 3, 4))).rejects.toEqual(
      expect.objectContaining({
        name: "QwpBatchTooLargeError",
        batchSizeBytes: 4,
        maxBatchSizeBytes: 3,
      } satisfies Partial<QwpBatchTooLargeError>),
    );
    expect(socket.sent).toHaveLength(0);

    socket.onSend = () => {
      socket.message(ingressResponse(QWP_STATUS.OK, 0n));
    };
    await expect(
      session.sendFrame(Uint8Array.of(1, 2, 3)),
    ).resolves.toMatchObject({ sequence: 0n });
    await session.close();
  });

  it("splits an oversized ingress flush at row boundaries under the negotiated cap", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpBrowserWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: () => asQwpSocket(socket),
    });
    socket.open();
    const rows = longTable("events", [10n, 20n, 30n, 40n]);
    const cap = encodeQwpIngressFrame([rows.sliceRows(0, 1)], {
      gorilla: false,
    }).byteLength;
    const session = new QwpIngressSession(await connecting, {
      maxBatchSizeBytes: cap,
    });
    socket.onSend = () => {
      const sequence = BigInt(socket.sent.length - 1);
      socket.message(
        ingressResponse(QWP_STATUS.OK, sequence, undefined, [
          ["events", sequence + 1n],
        ]),
      );
    };

    await expect(
      session.sendTables([rows], { gorilla: false }),
    ).resolves.toMatchObject({
      sequence: 3n,
      tables: [{ name: "events", sequenceTransaction: 4n }],
    });
    expect(socket.sent).toHaveLength(4);
    expect(socket.sent.every((frame) => frame.byteLength <= cap)).toBe(true);
    expect(socket.sent.map(firstIngressTableRowCount)).toEqual([1, 1, 1, 1]);
    expect(
      socket.sent.map(
        (frame) => decodeQwpFrame(frame).flags & QWP_FLAG_DEFER_COMMIT,
      ),
    ).toEqual([
      QWP_FLAG_DEFER_COMMIT,
      QWP_FLAG_DEFER_COMMIT,
      QWP_FLAG_DEFER_COMMIT,
      0,
    ]);

    await session.sendTables([longTable("events", [50n, 60n])], {
      gorilla: false,
      deferCommit: true,
    });
    expect(
      socket.sent
        .slice(4)
        .map((frame) => decodeQwpFrame(frame).flags & QWP_FLAG_DEFER_COMMIT),
    ).toEqual([QWP_FLAG_DEFER_COMMIT, QWP_FLAG_DEFER_COMMIT]);
    await session.close();
  });

  it("advances automatic symbol deltas across split ingress frames", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpBrowserWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: () => asQwpSocket(socket),
    });
    socket.open();
    const symbols = ["symbol-0000", "symbol-1111", "symbol-2222"];
    const rows = symbolTable("trades", symbols);
    const sizingDictionary = new QwpSymbolDictionary();
    const cap = encodeQwpIngressFrame([rows.sliceRows(0, 1)], {
      dictionary: sizingDictionary,
      confirmedMaxSymbolId: -1,
    }).byteLength;
    const session = new QwpIngressSession(await connecting, {
      maxBatchSizeBytes: cap,
    });
    socket.onSend = () => {
      const sequence = BigInt(socket.sent.length - 1);
      socket.message(
        ingressResponse(QWP_STATUS.OK, sequence, undefined, [
          ["trades", sequence + 1n],
        ]),
      );
    };

    await session.sendTablesDelta([rows]);
    expect(socket.sent).toHaveLength(3);
    expect(socket.sent.every((frame) => frame.byteLength <= cap)).toBe(true);
    expect(
      socket.sent.map(
        (frame) =>
          decodeQwpFrame(frame).flags & QWP_FLAG_DELTA_SYMBOL_DICTIONARY,
      ),
    ).toEqual([
      QWP_FLAG_DELTA_SYMBOL_DICTIONARY,
      QWP_FLAG_DELTA_SYMBOL_DICTIONARY,
      QWP_FLAG_DELTA_SYMBOL_DICTIONARY,
    ]);
    expect(
      socket.sent.map((frame) => decodeQwpIngressSymbolDictionaryDelta(frame)),
    ).toEqual([
      { startId: 0, entries: [symbols[0]] },
      { startId: 1, entries: [symbols[1]] },
      { startId: 2, entries: [symbols[2]] },
    ]);

    await expect(
      session.sendTablesDelta([symbolTable("trades", ["x".repeat(cap)])]),
    ).rejects.toBeInstanceOf(QwpBatchTooLargeError);
    expect(socket.sent).toHaveLength(3);

    await session.sendTablesDelta([symbolTable("trades", [symbols[0]])]);
    expect(decodeQwpIngressSymbolDictionaryDelta(socket.sent[3])).toEqual({
      startId: 3,
      entries: [],
    });
    await session.sendTablesDelta([symbolTable("trades", ["symbol-3333"])]);
    expect(decodeQwpIngressSymbolDictionaryDelta(socket.sent[4])).toEqual({
      startId: 3,
      entries: ["symbol-3333"],
    });
    await session.close();
  });

  it("rejects an unsplittable ingress row before consuming a sequence", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpBrowserWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: () => asQwpSocket(socket),
    });
    socket.open();
    const small = longTable("events", [1n]);
    const cap = encodeQwpIngressFrame([small]).byteLength;
    const session = new QwpIngressSession(await connecting, {
      maxBatchSizeBytes: cap,
    });
    const oversized = new QwpTableBuffer("events");
    oversized
      .getOrCreateColumn("payload", QWP_COLUMN_TYPE.VARCHAR)!
      .values.push("x".repeat(cap));
    oversized.nextRow();

    await expect(session.sendTables([oversized])).rejects.toMatchObject({
      name: "QwpBatchTooLargeError",
      maxBatchSizeBytes: cap,
    } satisfies Partial<QwpBatchTooLargeError>);
    expect(socket.sent).toHaveLength(0);

    socket.onSend = () => {
      socket.message(ingressResponse(QWP_STATUS.OK, 0n));
    };
    await expect(session.sendTables([small])).resolves.toMatchObject({
      sequence: 0n,
    });
    await session.close();
  });

  it("registers ACK waiters before sending and preserves call order", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpBrowserWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: () => asQwpSocket(socket),
    });
    socket.open();
    const connection = await connecting;
    const session = new QwpIngressSession(connection);
    let sequence = 0n;
    socket.onSend = () => {
      socket.message(ingressResponse(QWP_STATUS.OK, sequence++));
    };

    const first = session.sendFrame(Uint8Array.of(1));
    const second = session.sendFrame(Uint8Array.of(2));
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { status: QWP_STATUS.OK, sequence: 0n },
      { status: QWP_STATUS.OK, sequence: 1n },
    ]);
    expect(socket.sent).toEqual([Uint8Array.of(1), Uint8Array.of(2)]);
    await session.close();
  });

  it("reports immutable ingress metrics, progress, and protected error callbacks", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpBrowserWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: () => asQwpSocket(socket),
    });
    socket.open();
    const progress: string[] = [];
    const errors: { terminal: boolean; message: string }[] = [];
    const senderErrors: QwpSenderError[] = [];
    const session = new QwpIngressSession(await connecting, {
      durableAckKeepaliveMs: 0,
      onProgress: (event) => progress.push(event.kind),
      onError: (event) => {
        errors.push({
          terminal: event.terminal,
          message: event.error.message,
        });
        throw new Error("observer failure must be contained");
      },
      onSenderError: (error) => senderErrors.push(error),
    });
    socket.onSend = () => {
      const sequence = BigInt(socket.sent.length - 1);
      socket.message(
        sequence === 0n
          ? ingressResponse(QWP_STATUS.OK, sequence, undefined, [
              ["events", 7n],
            ])
          : ingressResponse(QWP_STATUS.WRITE_ERROR, sequence, "write failed"),
      );
    };

    await expect(session.sendFrame(Uint8Array.of(1))).resolves.toMatchObject({
      sequence: 0n,
    });
    socket.message(durableResponse([["events", 7n]]));
    await vi.waitFor(() =>
      expect(progress).toContain(
        QWP_INGRESS_PROGRESS_KIND.DURABLE_ACKNOWLEDGED,
      ),
    );
    await expect(session.sendFrame(Uint8Array.of(2))).rejects.toMatchObject({
      name: "QwpIngressNackError",
    });

    await vi.waitFor(() => expect(progress).toHaveLength(4));
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    await vi.waitFor(() => expect(senderErrors).toHaveLength(1));
    expect(progress).toEqual([
      QWP_INGRESS_PROGRESS_KIND.PUBLISHED,
      QWP_INGRESS_PROGRESS_KIND.ACKNOWLEDGED,
      QWP_INGRESS_PROGRESS_KIND.DURABLE_ACKNOWLEDGED,
      QWP_INGRESS_PROGRESS_KIND.PUBLISHED,
    ]);
    expect(errors).toEqual([{ terminal: true, message: "write failed" }]);
    expect(senderErrors[0]).toMatchObject({
      category: QWP_SENDER_ERROR_CATEGORY.WRITE_ERROR,
      appliedPolicy: QWP_SENDER_ERROR_POLICY.TERMINAL,
      serverStatusByte: QWP_STATUS.WRITE_ERROR,
      serverMessage: "write failed",
      messageSequence: 1n,
      fromFsn: 1n,
      toFsn: 1n,
    });
    expect(session.metrics).toMatchObject({
      publishedSequence: 1n,
      acknowledgedSequence: 0n,
      pendingResponses: 0,
      pendingResponseBytes: 0,
      pendingDurableTables: 0,
      totalFramesPublished: 2,
      totalBytesPublished: 2,
      totalFramesSent: 2,
      totalBytesSent: 2,
      totalFramesReplayed: 0,
      totalAcks: 1,
      totalNacks: 1,
      totalDurableAcks: 1,
      totalErrors: 1,
      lastError: expect.objectContaining({ name: "QwpIngressNackError" }),
    });
    expect(Object.isFrozen(session.metrics)).toBe(true);
    expect(() => session.publishFrame(Uint8Array.of(3))).toThrow(
      "write failed",
    );
    expect(socket.closeCalls).toContainEqual({
      code: 1002,
      reason: "QWP ingress pipeline rejected",
    });
    await session.close();
  });

  it("starts the ingress ACK deadline after send backpressure clears", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeBackpressuredWebSocket();
      const connecting = connectQwpBrowserWebSocket({
        url: "ws://localhost:9000/write/v4",
        sendTimeoutMs: 100,
        webSocketFactory: () => asQwpSocket(socket),
      });
      socket.open();
      const session = new QwpIngressSession(await connecting, {
        ackTimeoutMs: 25,
      });
      let settled = false;
      const outcome = session.sendFrame(Uint8Array.of(1)).catch((error) => {
        settled = true;
        return error;
      });

      await vi.advanceTimersByTimeAsync(25);
      expect(settled).toBe(false);
      socket.drain();
      await vi.advanceTimersByTimeAsync(4);
      await vi.advanceTimersByTimeAsync(23);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await expect(outcome).resolves.toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/timed out.*sequence=0/i),
        }),
      );
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves every covered waiter from a cumulative ACK", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpBrowserWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: () => asQwpSocket(socket),
    });
    socket.open();
    const session = new QwpIngressSession(await connecting);
    socket.onSend = () => {
      if (socket.sent.length === 8) {
        socket.message(ingressResponse(QWP_STATUS.OK, 7n));
      }
    };

    const sends = Array.from({ length: 8 }, (_, index) =>
      session.sendFrame(Uint8Array.of(index)),
    );
    await expect(Promise.all(sends)).resolves.toEqual(
      Array.from({ length: 8 }, () =>
        expect.objectContaining({ status: QWP_STATUS.OK, sequence: 7n }),
      ),
    );
    await session.close();
  });

  it("pings an idle durable session until its table targets are covered", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakePingWebSocket();
      socket.protocol = QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL;
      const connecting = connectQwpBrowserWebSocket({
        url: "ws://localhost:9000/write/v4",
        requestDurableAck: true,
        webSocketFactory: () => asQwpSocket(socket),
      });
      socket.open();
      const session = new QwpIngressSession(await connecting, {
        ackTimeoutMs: 100,
        durableAckKeepaliveMs: 25,
      });
      socket.onSend = () => {
        socket.message(
          ingressResponse(QWP_STATUS.OK, 0n, undefined, [["trades", 42n]]),
        );
      };
      socket.onPing = () => {
        socket.message(
          durableResponse([["trades", socket.pingCalls === 1 ? 41n : 42n]]),
        );
      };

      const ack = await session.sendFrame(Uint8Array.of(1));
      const durable = session.waitForDurable(ack);
      await vi.advanceTimersByTimeAsync(25);
      expect(socket.pingCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(25);
      await expect(durable).resolves.toBeUndefined();
      expect(socket.pingCalls).toBe(2);

      await vi.advanceTimersByTimeAsync(100);
      expect(socket.pingCalls).toBe(2);
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not poll when durable ACK was not negotiated", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeWebSocket();
      const connecting = connectQwpBrowserWebSocket({
        url: "ws://localhost:9000/write/v4",
        webSocketFactory: () => asQwpSocket(socket),
      });
      socket.open();
      const session = new QwpIngressSession(await connecting, {
        durableAckKeepaliveMs: 5,
      });
      socket.onSend = () => {
        socket.message(
          ingressResponse(QWP_STATUS.OK, 0n, undefined, [["trades", 42n]]),
        );
      };

      const ack = await session.sendFrame(Uint8Array.of(1));
      await vi.advanceTimersByTimeAsync(20);
      expect(socket.sent).toHaveLength(1);
      expect(session.metrics.pendingDurableTables).toBe(0);
      await expect(session.waitForDurable(ack)).rejects.toThrow(
        "durable ACK was not negotiated",
      );
      await expect(session.pollDurableAck()).rejects.toThrow(
        "durable ACK was not negotiated",
      );
      expect(socket.sent).toHaveLength(1);
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls durable progress with table-less QWP frames in browsers", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeWebSocket();
      socket.protocol = QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL;
      const connecting = connectQwpBrowserIngress(
        {
          url: "ws://localhost:9000/write/v4",
          requestDurableAck: true,
          ingressNegotiationTimeoutMs: 0,
          webSocketFactory: () => asQwpSocket(socket),
        },
        {
          ackTimeoutMs: 100,
          durableAckKeepaliveMs: 25,
        },
      );
      socket.open();
      const session = await connecting;
      socket.onSend = () => {
        if (socket.sent.length === 1) {
          socket.message(
            ingressResponse(QWP_STATUS.OK, 0n, undefined, [["trades", 42n]]),
          );
          return;
        }
        socket.message(durableResponse([["trades", 42n]]));
        socket.message(ingressResponse(QWP_STATUS.OK, 1n));
      };

      const ack = await session.sendFrame(Uint8Array.of(1));
      const durable = session.waitForDurable(ack);
      await vi.advanceTimersByTimeAsync(25);
      await expect(durable).resolves.toBeUndefined();
      expect(socket.sent).toHaveLength(2);
      expect(socket.sent[1]).toEqual(encodeQwpDurableAckPollFrame());

      await vi.advanceTimersByTimeAsync(100);
      expect(socket.sent).toHaveLength(2);
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not ACK-timeout a browser durable poll behind a deferred frame", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeWebSocket();
      socket.protocol = QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL;
      const connecting = connectQwpBrowserIngress(
        {
          url: "ws://localhost:9000/write/v4",
          requestDurableAck: true,
          ingressNegotiationTimeoutMs: 0,
          webSocketFactory: () => asQwpSocket(socket),
        },
        {
          ackTimeoutMs: 20,
          durableAckKeepaliveMs: 5,
        },
      );
      socket.open();
      const session = await connecting;
      socket.onSend = () => {
        if (socket.sent.length === 1) {
          socket.message(
            ingressResponse(QWP_STATUS.OK, 0n, undefined, [["trades", 42n]]),
          );
        } else if (socket.sent.length === 3) {
          // The tandem server reports durable progress for the poll but does
          // not cumulatively OK it while sequence 1 remains deferred.
          socket.message(durableResponse([["trades", 42n]]));
        } else if (socket.sent.length === 4) {
          socket.message(
            ingressResponse(QWP_STATUS.OK, 3n, undefined, [["trades", 43n]]),
          );
        }
      };

      const committed = await session.sendFrame(
        encodeQwpIngressFrame([longTable("trades", [1n])]),
      );
      const durable = session.waitForDurable(committed);
      const deferred = session.sendFrameWithPublication(
        encodeQwpIngressFrame([longTable("trades", [2n])], {
          deferCommit: true,
        }),
      );
      await deferred.publication;
      let deferredState: "pending" | "resolved" | "rejected" = "pending";
      void deferred.acknowledgement.then(
        () => {
          deferredState = "resolved";
        },
        () => {
          deferredState = "rejected";
        },
      );

      await vi.advanceTimersByTimeAsync(5);
      await expect(durable).resolves.toBeUndefined();
      expect(socket.sent[2]).toEqual(encodeQwpDurableAckPollFrame());

      await vi.advanceTimersByTimeAsync(40);
      expect(deferredState).toBe("pending");
      expect(session.metrics.lastError).toBeUndefined();

      const commit = session.sendFrame(encodeQwpIngressFrame([]));
      await expect(commit).resolves.toMatchObject({ sequence: 3n });
      await expect(deferred.acknowledgement).resolves.toMatchObject({
        sequence: 3n,
      });
      expect(session.metrics.pendingResponses).toBe(0);
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still terminates a browser session when a durable poll is NACKed", async () => {
    const socket = new FakeWebSocket();
    socket.protocol = QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL;
    const connecting = connectQwpBrowserIngress(
      {
        url: "ws://localhost:9000/write/v4",
        requestDurableAck: true,
        ingressNegotiationTimeoutMs: 0,
        webSocketFactory: () => asQwpSocket(socket),
      },
      {
        onError: () => undefined,
        onSenderError: () => undefined,
      },
    );
    socket.open();
    const session = await connecting;
    socket.onSend = () => {
      socket.message(
        ingressResponse(QWP_STATUS.PARSE_ERROR, 0n, "invalid durable poll"),
      );
    };

    await expect(session.pollDurableAck()).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(() => session.publishFrame(Uint8Array.of(1))).toThrow(
        "invalid durable poll",
      );
    });
    await session.close();
  });

  it("fails all pipelined frames and closes a fixed session after a NACK", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpBrowserWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: () => asQwpSocket(socket),
    });
    socket.open();
    const session = new QwpIngressSession(await connecting);
    let sent = 0;
    socket.onSend = () => {
      sent++;
      if (sent === 2) {
        socket.message(
          ingressResponse(QWP_STATUS.WRITE_ERROR, 0n, "write failed"),
        );
      }
    };

    const first = session.sendFrame(Uint8Array.of(1));
    const second = session.sendFrame(Uint8Array.of(2));
    await expect(first).rejects.toMatchObject({
      name: "QwpIngressNackError",
      response: { sequence: 0n, errorMessage: "write failed" },
    } satisfies QwpIngressNackMatch);
    await expect(second).rejects.toMatchObject({
      name: "QwpIngressNackError",
      response: { sequence: 0n, errorMessage: "write failed" },
    } satisfies QwpIngressNackMatch);
    expect(socket.sent).toEqual([Uint8Array.of(1), Uint8Array.of(2)]);
    expect(() => session.sendFrame(Uint8Array.of(3))).toThrow("write failed");
    expect(socket.closeCalls).toContainEqual({
      code: 1002,
      reason: "QWP ingress pipeline rejected",
    });
    await session.close();
  });

  it("fails a direct delta session after a dictionary gap", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpBrowserWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: () => asQwpSocket(socket),
    });
    socket.open();
    const session = new QwpIngressSession(await connecting);
    socket.onSend = () => {
      socket.message(
        ingressResponse(QWP_STATUS.DICTIONARY_GAP, 0n, "missing prefix"),
      );
    };
    const table = new QwpTableBuffer("trades");
    table
      .getOrCreateColumn("symbol", QWP_COLUMN_TYPE.SYMBOL)!
      .values.push("ETH-USD");
    table.nextRow();

    await expect(session.sendTablesDelta([table])).rejects.toMatchObject({
      name: "QwpIngressNackError",
      response: { status: QWP_STATUS.DICTIONARY_GAP },
    });
    expect(() => session.sendFrame(Uint8Array.of(2))).toThrow(/missing prefix/);
    expect(socket.closeCalls).toContainEqual({
      code: 1002,
      reason: "QWP symbol dictionary gap",
    });
    await session.close();
  });

  it("times out an ACK without losing session closeability", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeWebSocket();
      const connecting = connectQwpBrowserWebSocket({
        url: "ws://localhost:9000/write/v4",
        webSocketFactory: () => asQwpSocket(socket),
      });
      socket.open();
      const session = new QwpIngressSession(await connecting, {
        ackTimeoutMs: 25,
      });
      const response = session.sendFrame(Uint8Array.of(1));
      const rejected = expect(response).rejects.toThrow(
        /timed out.*sequence=0/i,
      );
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
