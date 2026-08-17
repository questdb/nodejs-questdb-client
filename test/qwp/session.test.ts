import { describe, expect, it, vi } from "vitest";
import {
  connectQwpBrowserWebSocket,
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
  QWP_EGRESS_MESSAGE,
  QWP_STATUS,
  QWP_UPGRADE_ERROR_KIND,
  QwpBatchTooLargeError,
  QwpByteWriter,
  encodeQwpFrame,
  QwpIngressNackError,
  QwpIngressSession,
  QwpIngressSessionClosedError,
  QwpTableBuffer,
  QwpSendClosedError,
  QwpSendTimeoutError,
  QwpUpgradeError,
} from "../../src/qwp";

type Listener = (event: unknown) => void;

class FakeWebSocket {
  binaryType = "blob";
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  readonly closeCalls: { code?: number; reason?: string }[] = [];
  onSend?: (payload: Uint8Array) => void;
  private readonly listeners = new Map<string, Listener[]>();

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

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
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

function serverInfoFrame(): Uint8Array {
  const writer = new QwpByteWriter();
  writer
    .writeUint8(QWP_EGRESS_MESSAGE.SERVER_INFO)
    .writeUint8(0)
    .writeBigUint64(1n)
    .writeUint32(0)
    .writeBigInt64(123n)
    .writeUint16(0)
    .writeUint16(0);
  return encodeQwpFrame(writer.toUint8Array());
}

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
      statusCode: 503,
      statusMessage: "Service Unavailable",
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
      socket.message(new NeverSettlingBlob());
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
      const connecting = connectQwpBrowserWebSocket({
        url: "ws://localhost:9000/write/v4",
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

  it("rejects durable keepalive on a transport without PING support", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpBrowserWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: () => asQwpSocket(socket),
    });
    socket.open();
    const connection = await connecting;
    expect(
      () =>
        new QwpIngressSession(connection, {
          durableAckKeepaliveMs: 25,
        }),
    ).toThrow(/PING support/);
    expect(socket.closeCalls).toHaveLength(1);
    await connection.close();
  });

  it("rejects the matching frame on NACK without breaking later ACKs", async () => {
    const socket = new FakeWebSocket();
    const connecting = connectQwpBrowserWebSocket({
      url: "ws://localhost:9000/write/v4",
      webSocketFactory: () => asQwpSocket(socket),
    });
    socket.open();
    const session = new QwpIngressSession(await connecting);
    let sequence = 0n;
    socket.onSend = () => {
      const current = sequence++;
      socket.message(
        ingressResponse(
          current === 0n ? QWP_STATUS.WRITE_ERROR : QWP_STATUS.OK,
          current,
          "write failed",
        ),
      );
    };

    await expect(session.sendFrame(Uint8Array.of(1))).rejects.toMatchObject({
      name: "QwpIngressNackError",
      response: { sequence: 0n, errorMessage: "write failed" },
    } satisfies Partial<QwpIngressNackError>);
    await expect(session.sendFrame(Uint8Array.of(2))).resolves.toMatchObject({
      sequence: 1n,
      status: QWP_STATUS.OK,
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
