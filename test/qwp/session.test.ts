import { describe, expect, it, vi } from "vitest";
import {
  connectQwpBrowserWebSocket,
  QwpWebSocketLike,
} from "../../src/qwp/browser";
import {
  connectQwpNodeWebSocket,
  QwpDurableAckUnavailableError,
  QwpVersionMismatchError,
} from "../../src/qwp/node";
import {
  QWP_STATUS,
  QWP_UPGRADE_ERROR_KIND,
  QwpBatchTooLargeError,
  QwpByteWriter,
  QwpIngressNackError,
  QwpIngressSession,
  QwpUpgradeError,
} from "../../src/qwp";

type Listener = (event: unknown) => void;

class FakeWebSocket {
  binaryType = "blob";
  readyState = 0;
  readonly sent: Uint8Array[] = [];
  readonly closeCalls: { code?: number; reason?: string }[] = [];
  onSend?: (payload: Uint8Array) => void;
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
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

describe("QWP WebSocket adapters", () => {
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
