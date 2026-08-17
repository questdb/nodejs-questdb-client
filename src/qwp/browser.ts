/** Browser WebSocket adapter and browser-safe QWP protocol/session APIs. */
export * from "./index";

import {
  openQwpWebSocket,
  QwpWebSocketLike,
} from "./internal/websocket-connection";
import { QwpBinaryConnection, QwpWebSocketConnectOptions } from "./transport";
import { QwpIngressSession, QwpIngressSessionOptions } from "./ingress-session";

export type { QwpWebSocketLike } from "./internal/websocket-connection";

export interface QwpBrowserWebSocketOptions extends QwpWebSocketConnectOptions {
  /** Test or framework hook; defaults to the browser's global WebSocket. */
  webSocketFactory?: (
    url: string | URL,
    protocols?: string | string[],
  ) => QwpWebSocketLike;
}

/**
 * Opens a QWP-capable browser WebSocket.
 *
 * Browsers cannot set Authorization or X-QWP-* upgrade headers. The server or
 * gateway must therefore support the browser QWP handshake (Origin policy and
 * browser-compatible authentication/version negotiation).
 */
export function connectQwpBrowserWebSocket(
  options: QwpBrowserWebSocketOptions,
): Promise<QwpBinaryConnection> {
  const factory =
    options.webSocketFactory ??
    ((url: string | URL, protocols?: string | string[]) => {
      const WebSocketConstructor = (
        globalThis as unknown as {
          WebSocket?: new (
            url: string | URL,
            protocols?: string | string[],
          ) => QwpWebSocketLike;
        }
      ).WebSocket;
      if (!WebSocketConstructor) {
        throw new Error("WebSocket is not available in this browser runtime");
      }
      return new WebSocketConstructor(url, protocols);
    });
  const socket = factory(options.url, options.protocols);
  return openQwpWebSocket(socket, options.connectTimeoutMs);
}

/** Opens a browser WebSocket and starts an ingress ACK/NACK session. */
export async function connectQwpBrowserIngress(
  options: QwpBrowserWebSocketOptions,
  sessionOptions: QwpIngressSessionOptions = {},
): Promise<QwpIngressSession> {
  return new QwpIngressSession(
    await connectQwpBrowserWebSocket(options),
    sessionOptions,
  );
}
