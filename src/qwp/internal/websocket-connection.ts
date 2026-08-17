import { QwpProtocolError } from "../core";
import { QwpBinaryConnection, QwpConnectionCloseInfo } from "../transport";
import { QwpAsyncQueue } from "./async-queue";

interface QwpWebSocketMessageEvent {
  data: unknown;
}

interface QwpWebSocketCloseEvent {
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

export interface QwpWebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open",
    listener: (event: unknown) => void,
    options?: { once?: boolean },
  ): void;
  addEventListener(
    type: "message",
    listener: (event: QwpWebSocketMessageEvent) => void,
  ): void;
  addEventListener(
    type: "error",
    listener: (event: unknown) => void,
    options?: { once?: boolean },
  ): void;
  addEventListener(
    type: "close",
    listener: (event: QwpWebSocketCloseEvent) => void,
    options?: { once?: boolean },
  ): void;
}

const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSED = 3;

async function normalizeBinaryMessage(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    ).slice();
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  throw new QwpProtocolError("QWP WebSocket received a non-binary message");
}

/** Wraps a WHATWG-style WebSocket and resolves once its opening handshake succeeds. */
export function openQwpWebSocket(
  socket: QwpWebSocketLike,
  connectTimeoutMs = 15_000,
): Promise<QwpBinaryConnection> {
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) {
    return Promise.reject(
      new RangeError("connectTimeoutMs must be a positive finite number"),
    );
  }

  const messages = new QwpAsyncQueue<Uint8Array>();
  let resolveClosed!: (info: QwpConnectionCloseInfo) => void;
  const closed = new Promise<QwpConnectionCloseInfo>((resolve) => {
    resolveClosed = resolve;
  });
  let opened = false;
  let openingSettled = false;
  let messageTail: Promise<void> = Promise.resolve();

  return new Promise<QwpBinaryConnection>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (openingSettled) return;
      openingSettled = true;
      try {
        socket.close(1000, "QWP connection timeout");
      } catch {
        // Some implementations throw when close() races an opening handshake.
      }
      reject(new Error("QWP WebSocket connection timed out"));
    }, connectTimeoutMs);

    const failOpening = (error: Error): void => {
      if (openingSettled) return;
      openingSettled = true;
      clearTimeout(timeout);
      reject(error);
    };

    socket.binaryType = "arraybuffer";
    socket.addEventListener(
      "open",
      () => {
        if (openingSettled) return;
        openingSettled = true;
        opened = true;
        clearTimeout(timeout);
        resolve({
          messages,
          closed,
          async send(payload: Uint8Array): Promise<void> {
            if (socket.readyState !== WEBSOCKET_OPEN) {
              throw new Error("QWP WebSocket is not open");
            }
            socket.send(payload);
          },
          async close(code = 1000, reason = ""): Promise<void> {
            if (socket.readyState === WEBSOCKET_CLOSED) return;
            socket.close(code, reason);
            await closed;
          },
        });
      },
      { once: true },
    );

    socket.addEventListener("message", (event) => {
      messageTail = messageTail
        .then(async () =>
          messages.push(await normalizeBinaryMessage(event.data)),
        )
        .catch((error: unknown) => {
          messages.fail(error);
          try {
            socket.close(1002, "invalid QWP payload");
          } catch {
            // The error still reaches the message iterator when close() fails.
          }
        });
    });

    socket.addEventListener("error", () => {
      const error = new Error("QWP WebSocket transport error");
      if (!opened) {
        failOpening(error);
      } else {
        messages.fail(error);
      }
    });

    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timeout);
        const info = {
          code: event.code ?? 1006,
          reason: event.reason ?? "",
          wasClean: event.wasClean ?? false,
        };
        resolveClosed(info);
        if (!opened) {
          failOpening(
            new Error(
              `QWP WebSocket closed during handshake [code=${info.code}, reason=${info.reason}]`,
            ),
          );
          return;
        }
        void messageTail.finally(() => messages.end());
      },
      { once: true },
    );
  });
}
