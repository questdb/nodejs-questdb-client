import { QwpProtocolError } from "../core";
import {
  QWP_UPGRADE_ERROR_KIND,
  QwpBinaryConnection,
  QwpConnectionCloseInfo,
  QwpHandshakeMetadata,
  QwpUpgradeError,
} from "../transport";
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
  /** Node WebSocket implementations may expose control-frame PING. */
  ping?(): void;
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

export interface QwpWebSocketOpenOptions {
  url: string | URL;
  connectTimeoutMs?: number;
  completeHandshake: () => QwpHandshakeMetadata;
  /** Node adapters use this to surface non-101 HTTP responses from `ws`. */
  openingFailure?: Promise<never>;
  /** Browsers hide the HTTP response behind a generic WebSocket error event. */
  opaqueErrors?: boolean;
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
  options: QwpWebSocketOpenOptions,
): Promise<QwpBinaryConnection> {
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
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
      reject(
        new QwpUpgradeError("QWP WebSocket connection timed out", {
          kind: QWP_UPGRADE_ERROR_KIND.TIMEOUT,
          retryable: true,
          tryNextEndpoint: true,
          url: options.url,
        }),
      );
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
        let handshake: QwpHandshakeMetadata;
        try {
          handshake = Object.freeze({ ...options.completeHandshake() });
        } catch (error) {
          openingSettled = true;
          clearTimeout(timeout);
          try {
            socket.close(1000, "QWP upgrade validation failed");
          } catch {
            // The validation error is more useful than a close race.
          }
          reject(
            error instanceof Error
              ? error
              : new Error("QWP WebSocket upgrade validation failed"),
          );
          return;
        }
        openingSettled = true;
        opened = true;
        clearTimeout(timeout);
        const connection: QwpBinaryConnection = {
          messages,
          closed,
          handshake,
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
        };
        if (socket.ping) {
          connection.ping = async (): Promise<void> => {
            if (socket.readyState !== WEBSOCKET_OPEN) {
              throw new Error("QWP WebSocket is not open");
            }
            socket.ping!();
          };
        }
        resolve(connection);
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

    options.openingFailure?.catch((error: unknown) => {
      failOpening(
        error instanceof Error
          ? error
          : new QwpUpgradeError("QWP WebSocket upgrade failed", {
              kind: QWP_UPGRADE_ERROR_KIND.TRANSPORT,
              retryable: true,
              tryNextEndpoint: true,
              url: options.url,
              cause: error,
            }),
      );
    });

    socket.addEventListener("error", (event) => {
      if (opened) {
        messages.fail(new Error("QWP WebSocket transport error"));
        return;
      }
      const opaque = options.opaqueErrors === true;
      const eventError = (event as { error?: unknown }).error;
      const error = new QwpUpgradeError(
        opaque
          ? "QWP WebSocket upgrade failed; the browser did not expose the HTTP response"
          : "QWP WebSocket transport error during upgrade",
        {
          kind: opaque
            ? QWP_UPGRADE_ERROR_KIND.OPAQUE
            : QWP_UPGRADE_ERROR_KIND.TRANSPORT,
          retryable: opaque ? undefined : true,
          tryNextEndpoint: opaque ? undefined : true,
          url: options.url,
          cause: eventError ?? event,
        },
      );
      failOpening(error);
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
            new QwpUpgradeError(
              `QWP WebSocket closed during handshake [code=${info.code}, reason=${info.reason}]`,
              {
                kind: options.opaqueErrors
                  ? QWP_UPGRADE_ERROR_KIND.OPAQUE
                  : QWP_UPGRADE_ERROR_KIND.TRANSPORT,
                retryable: options.opaqueErrors ? undefined : true,
                tryNextEndpoint: options.opaqueErrors ? undefined : true,
                url: options.url,
                closeCode: info.code,
              },
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
