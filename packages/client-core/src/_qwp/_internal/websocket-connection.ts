import { QwpProtocolError } from "../_core";
import {
  QWP_UPGRADE_ERROR_KIND,
  QWP_UPGRADE_TIMEOUT_PHASE,
  QwpBinaryConnection,
  QwpConnectionCloseInfo,
  QwpHandshakeMetadata,
  QwpSendClosedError,
  QwpSendError,
  QwpSendTimeoutError,
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
  /** WebSocket subprotocol selected by the server, or an empty string. */
  readonly protocol?: string;
  /** Number of application bytes queued by WHATWG-compatible WebSockets. */
  readonly bufferedAmount?: number;
  send(data: Uint8Array): void;
  /** Node adapter hook for the `ws.send(data, callback)` completion signal. */
  sendWithCallback?(data: Uint8Array, callback: (error?: Error) => void): void;
  /** Node WebSocket implementations may expose control-frame PING. */
  ping?(): void;
  /** Node WebSocket implementations may support immediate termination. */
  terminate?(): void;
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
  /** Optional cleanup hook implemented by browser WebSocket and Node `ws`. */
  removeEventListener?(type: "open", listener: (event: unknown) => void): void;
  removeEventListener?(
    type: "message",
    listener: (event: QwpWebSocketMessageEvent) => void,
  ): void;
  removeEventListener?(type: "error", listener: (event: unknown) => void): void;
  removeEventListener?(
    type: "close",
    listener: (event: QwpWebSocketCloseEvent) => void,
  ): void;
}

export interface QwpWebSocketOpenOptions {
  url: string | URL;
  connectTimeoutMs?: number;
  /** Node-only HTTP authentication and WebSocket upgrade deadline. */
  authTimeoutMs?: number;
  /** Resolves after the Node TCP/TLS transport has connected. */
  transportConnected?: Promise<void>;
  sendTimeoutMs?: number;
  closeTimeoutMs?: number;
  completeHandshake: () => QwpHandshakeMetadata;
  /** Node adapters use this to surface non-101 HTTP responses from `ws`. */
  openingFailure?: Promise<never>;
  /** Browsers hide the HTTP response behind a generic WebSocket error event. */
  opaqueErrors?: boolean;
  /**
   * Tears the pending upgrade down immediately. Without it a close() issued
   * while the peer has accepted the TCP connection but not answered the
   * upgrade leaves the socket and its deadline alive until that deadline
   * fires, which keeps the Node event loop open long after close() resolved.
   */
  signal?: AbortSignal;
}

const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSED = 3;
const BUFFERED_AMOUNT_POLL_MS = 4;
const DEFAULT_TIMEOUT_MS = 15_000;

export function validateQwpWebSocketTimeouts(options: {
  connectTimeoutMs?: number;
  authTimeoutMs?: number;
  sendTimeoutMs?: number;
  closeTimeoutMs?: number;
}): void {
  for (const [name, value] of [
    ["connectTimeoutMs", options.connectTimeoutMs],
    ["authTimeoutMs", options.authTimeoutMs],
    ["sendTimeoutMs", options.sendTimeoutMs],
    ["closeTimeoutMs", options.closeTimeoutMs],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new RangeError(`${name} must be a positive finite number`);
    }
  }
}

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
/** Absorbs a socket `error` raised before the real listeners are attached. */
const ignoreSocketError = (): void => undefined;

export function openQwpWebSocket(
  socket: QwpWebSocketLike,
  options: QwpWebSocketOpenOptions,
): Promise<QwpBinaryConnection> {
  try {
    validateQwpWebSocketTimeouts(options);
  } catch (error) {
    try {
      // Tearing down a CONNECTING socket makes `ws` emit `error`, and nothing
      // has subscribed to this one yet. Absorb it rather than let an
      // EventEmitter with no listener rethrow it into the process.
      socket.addEventListener("error", ignoreSocketError);
      if (socket.terminate) socket.terminate();
      else if (socket.readyState !== WEBSOCKET_CLOSED) socket.close();
    } catch {
      // Configuration validation remains authoritative.
    }
    return Promise.reject(error);
  }
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Opening a connection is two deadlines: connectTimeoutMs covers the TCP/TLS
  // transport, and authTimeoutMs takes over for the upgrade and authentication
  // exchange the moment transportConnected resolves. A caller who narrows only
  // the first is bounding how long establishing one connection may take, and
  // the upgrade is part of that -- inheriting keeps an explicit 200 ms from
  // being exceeded 75x by a default nobody chose, which is what a peer that
  // accepts TCP and never answers the upgrade used to cost. Setting
  // authTimeoutMs restores an independent budget for the slower phase.
  const authTimeoutMs =
    options.authTimeoutMs ?? options.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const messages = new QwpAsyncQueue<Uint8Array>();
  let resolveClosed!: (info: QwpConnectionCloseInfo) => void;
  const closed = new Promise<QwpConnectionCloseInfo>((resolve) => {
    resolveClosed = resolve;
  });
  let opened = false;
  let openingSettled = false;
  let messageTail: Promise<void> = Promise.resolve();
  let sendTail: Promise<void> = Promise.resolve();
  let terminalSendError: QwpSendError | undefined;
  let rejectActiveSend: ((error: QwpSendError) => void) | undefined;
  let closeSettled = false;
  let closeTask: Promise<void> | undefined;
  let cleanupTask: Promise<void> = Promise.resolve();
  let removeSocketListeners = (): void => undefined;

  const failSends = (error: QwpSendError): QwpSendError => {
    terminalSendError ??= error;
    rejectActiveSend?.(terminalSendError);
    return terminalSendError;
  };

  const settleClosed = (info: QwpConnectionCloseInfo): void => {
    if (closeSettled) return;
    closeSettled = true;
    resolveClosed(info);
    if (opened) failSends(new QwpSendClosedError(info));
    removeSocketListeners();
    cleanupTask = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        messageTail.then(
          () => false,
          () => false,
        ),
        new Promise<true>((resolve) => {
          timer = setTimeout(() => resolve(true), closeTimeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (timedOut) messageTail = Promise.resolve();
      messages.end();
    })();
  };

  const closeSocket = (code = 1000, reason = ""): Promise<void> => {
    if (closeTask) return closeTask;
    closeTask = (async () => {
      const requestedInfo: QwpConnectionCloseInfo = {
        code,
        reason,
        wasClean: code === 1000,
      };
      if (opened) failSends(new QwpSendClosedError(requestedInfo));
      if (socket.readyState === WEBSOCKET_CLOSED) {
        settleClosed(requestedInfo);
      } else {
        try {
          socket.close(code, reason);
        } catch {
          try {
            socket.terminate?.();
          } catch {
            // The synthetic close below still releases local resources.
          }
          settleClosed({
            code: 1006,
            reason: "QWP WebSocket close failed",
            wasClean: false,
          });
        }
      }
      if (!closeSettled) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([
          closed.then(() => false),
          new Promise<true>((resolve) => {
            timer = setTimeout(() => resolve(true), closeTimeoutMs);
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (timedOut && !closeSettled) {
          try {
            socket.terminate?.();
          } catch {
            // Local state must still settle when forced termination throws.
          }
          settleClosed({
            code: 1006,
            reason: `QWP WebSocket close timed out after ${closeTimeoutMs}ms`,
            wasClean: false,
          });
        }
      }
      await cleanupTask;
    })();
    return closeTask;
  };

  const abortAfterSendFailure = (): void => {
    void closeSocket(1011, "QWP send failed");
  };

  const sendWithBackpressure = (payload: Uint8Array): Promise<void> => {
    if (terminalSendError) return Promise.reject(terminalSendError);
    if (socket.readyState !== WEBSOCKET_OPEN) {
      return Promise.reject(failSends(new QwpSendClosedError()));
    }

    return new Promise<void>((resolveSend, rejectSend) => {
      let settled = false;
      let drainPoll: ReturnType<typeof setTimeout> | undefined;

      const settle = (error?: QwpSendError): void => {
        if (settled) return;
        settled = true;
        if (drainPoll) clearTimeout(drainPoll);
        clearTimeout(sendTimeout);
        if (rejectActiveSend === rejectPending) rejectActiveSend = undefined;
        if (error) rejectSend(error);
        else resolveSend();
      };
      const rejectPending = (error: QwpSendError): void => settle(error);
      const failSend = (error: QwpSendError): void => {
        settle(failSends(error));
        abortAfterSendFailure();
      };

      rejectActiveSend = rejectPending;
      const sendTimeout = setTimeout(() => {
        const bufferedAmount = socket.bufferedAmount;
        failSend(
          new QwpSendTimeoutError(
            sendTimeoutMs,
            typeof bufferedAmount === "number" ? bufferedAmount : undefined,
          ),
        );
      }, sendTimeoutMs);

      if (socket.sendWithCallback) {
        try {
          socket.sendWithCallback(payload, (error) => {
            if (error) {
              failSend(
                new QwpSendError(
                  "QWP WebSocket send failed; delivery outcome is unknown",
                  error,
                ),
              );
            } else {
              settle();
            }
          });
        } catch (error) {
          failSend(
            new QwpSendError(
              "QWP WebSocket send failed before it could be queued",
              error,
            ),
          );
        }
        return;
      }

      const initialBufferedAmount = socket.bufferedAmount;
      try {
        socket.send(payload);
      } catch (error) {
        failSend(
          new QwpSendError(
            "QWP WebSocket send failed before it could be queued",
            error,
          ),
        );
        return;
      }

      if (typeof initialBufferedAmount !== "number") {
        // Backwards compatibility for custom adapters without a drain signal.
        settle();
        return;
      }

      const waitForDrain = (): void => {
        if (socket.readyState !== WEBSOCKET_OPEN) {
          settle(failSends(new QwpSendClosedError()));
          return;
        }
        if (
          typeof socket.bufferedAmount !== "number" ||
          socket.bufferedAmount <= initialBufferedAmount
        ) {
          settle();
          return;
        }
        drainPoll = setTimeout(waitForDrain, BUFFERED_AMOUNT_POLL_MS);
      };
      waitForDrain();
    });
  };

  return new Promise<QwpBinaryConnection>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const armOpeningTimeout = (
      timeoutMs: number,
      phase?: "connect" | "authentication",
    ): void => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        const message =
          phase === QWP_UPGRADE_TIMEOUT_PHASE.CONNECT
            ? `QWP TCP/TLS connection timed out after ${timeoutMs}ms`
            : phase === QWP_UPGRADE_TIMEOUT_PHASE.AUTHENTICATION
              ? `QWP authentication/WebSocket upgrade timed out after ${timeoutMs}ms`
              : `QWP WebSocket connection timed out after ${timeoutMs}ms`;
        failOpening(
          new QwpUpgradeError(message, {
            kind: QWP_UPGRADE_ERROR_KIND.TIMEOUT,
            retryable: true,
            tryNextEndpoint: true,
            url: options.url,
            timeoutPhase: phase,
          }),
          1000,
          "QWP connection timeout",
        );
      }, timeoutMs);
    };

    const failOpening = (
      error: Error,
      closeCode = 1000,
      closeReason = "QWP upgrade failed",
    ): void => {
      if (openingSettled) return;
      openingSettled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortOpening);
      void closeSocket(closeCode, closeReason);
      reject(error);
    };

    const abortOpening = (): void => {
      failOpening(
        new QwpSendClosedError(),
        1000,
        "QWP connection closed while connecting",
      );
    };
    // Aborting closes the socket, and closing a CONNECTING `ws` socket makes it
    // emit `error` on the next tick. This executor attaches the socket's
    // listeners last, so acting on an already-aborted signal here would leave
    // that event unhandled and terminate the process. A failover sweep hands
    // the same signal to every remaining endpoint after close() aborts it, so
    // this is the ordinary shape for a multi-address client, not a rare race.
    // Record the abort and apply it once the listeners are in place.
    let abortedBeforeListening = false;
    if (options.signal) {
      if (options.signal.aborted) {
        abortedBeforeListening = true;
      } else {
        options.signal.addEventListener("abort", abortOpening, { once: true });
      }
    }

    armOpeningTimeout(
      connectTimeoutMs,
      options.transportConnected
        ? QWP_UPGRADE_TIMEOUT_PHASE.CONNECT
        : undefined,
    );
    void options.transportConnected?.then(
      () => {
        if (openingSettled) return;
        armOpeningTimeout(
          authTimeoutMs,
          QWP_UPGRADE_TIMEOUT_PHASE.AUTHENTICATION,
        );
      },
      (error: unknown) => {
        failOpening(
          new QwpUpgradeError(
            "QWP TCP/TLS transport failed while establishing a connection",
            {
              kind: QWP_UPGRADE_ERROR_KIND.TRANSPORT,
              retryable: true,
              tryNextEndpoint: true,
              url: options.url,
              cause: error,
            },
          ),
        );
      },
    );

    const onOpen = (): void => {
      if (openingSettled) return;
      let handshake: QwpHandshakeMetadata;
      try {
        handshake = Object.freeze({ ...options.completeHandshake() });
      } catch (error) {
        failOpening(
          error instanceof Error
            ? error
            : new Error("QWP WebSocket upgrade validation failed"),
          1000,
          "QWP upgrade validation failed",
        );
        return;
      }
      openingSettled = true;
      opened = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortOpening);
      const connection: QwpBinaryConnection = {
        messages,
        closed,
        handshake,
        endpoint: options.url,
        send(payload: Uint8Array): Promise<void> {
          const sending = sendTail.then(() => sendWithBackpressure(payload));
          sendTail = sending.catch(() => undefined);
          return sending;
        },
        async close(code = 1000, reason = ""): Promise<void> {
          await closeSocket(code, reason);
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
    };

    const onMessage = (event: QwpWebSocketMessageEvent): void => {
      if (openingSettled && !opened) return;
      messageTail = messageTail
        .then(async () =>
          messages.push(await normalizeBinaryMessage(event.data)),
        )
        .catch((error: unknown) => {
          messages.fail(error);
          void closeSocket(1002, "invalid QWP payload");
        });
    };

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

    const onError = (event: unknown): void => {
      if (opened) {
        const eventError = (event as { error?: unknown }).error;
        failSends(
          new QwpSendError(
            "QWP WebSocket transport error while sending",
            eventError ?? event,
          ),
        );
        messages.fail(new Error("QWP WebSocket transport error"));
        abortAfterSendFailure();
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
    };

    const onClose = (event: QwpWebSocketCloseEvent): void => {
      clearTimeout(timeout);
      const info = {
        code: event.code ?? 1006,
        reason: event.reason ?? "",
        wasClean: event.wasClean ?? false,
      };
      settleClosed(info);
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
    };

    removeSocketListeners = (): void => {
      try {
        socket.removeEventListener?.("open", onOpen);
        socket.removeEventListener?.("message", onMessage);
        socket.removeEventListener?.("error", onError);
        socket.removeEventListener?.("close", onClose);
      } catch {
        // Transport cleanup must not make connection close reject.
      }
    };
    try {
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose, { once: true });
    } catch (error) {
      failOpening(
        error instanceof Error
          ? error
          : new Error("failed to configure QWP WebSocket listeners"),
      );
    }
    // Safe now: `onError` is attached, so the close this triggers has a
    // subscriber. A failed attachment above already settled the opening, and
    // failOpening() is idempotent, so this is a no-op in that case.
    if (abortedBeforeListening) abortOpening();
  });
}
