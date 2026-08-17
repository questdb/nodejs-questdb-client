import { describe, expect, it, vi } from "vitest";
import {
  connectQwpBrowserWebSocket,
  QwpWebSocketLike,
} from "../../src/qwp/browser";
import { connectQwpNodeWebSocket } from "../../src/qwp/node";
import {
  QWP_STATUS,
  QwpByteWriter,
  QwpIngressNackError,
  QwpIngressSession,
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

function asQwpSocket(socket: FakeWebSocket): QwpWebSocketLike {
  return socket as unknown as QwpWebSocketLike;
}

function ingressResponse(
  status: number,
  sequence: bigint,
  message?: string,
): Uint8Array {
  const writer = new QwpByteWriter();
  writer.writeUint8(status).writeBigUint64(sequence);
  if (status === QWP_STATUS.OK) {
    writer.writeUint16(0);
  } else {
    const encoded = new TextEncoder().encode(message ?? "rejected");
    writer.writeUint16(encoded.length).writeBytes(encoded);
  }
  return writer.toUint8Array();
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
    await connection.close();
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
      const rejected = expect(connecting).rejects.toThrow(/timed out/i);
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
