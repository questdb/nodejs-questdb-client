/** Browser WebSocket adapter and browser-safe QWP protocol/session APIs. */
export * from "./index";

import {
  openQwpWebSocket,
  QwpWebSocketLike,
} from "./internal/websocket-connection";
import { QWP_VERSION } from "./core";
import { QwpBinaryConnection, QwpWebSocketConnectOptions } from "./transport";
import { QwpEgressSession, QwpEgressSessionOptions } from "./egress-session";
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
 * Browsers cannot set Authorization or X-QWP-* upgrade headers. QuestDB accepts
 * browser upgrades when Origin and Host have the same authority, so serve the
 * app from the QuestDB origin or route QWP through a same-origin reverse proxy.
 * When authentication is enabled, the deployment must provide a
 * browser-compatible authentication mechanism.
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
  return openQwpWebSocket(socket, options.connectTimeoutMs, () => ({
    qwpVersion: QWP_VERSION,
  }));
}

/** Opens a browser WebSocket and starts an ingress ACK/NACK session. */
export async function connectQwpBrowserIngress(
  options: QwpBrowserWebSocketOptions,
  sessionOptions: QwpIngressSessionOptions = {},
): Promise<QwpIngressSession> {
  return QwpIngressSession.connect(
    () => connectQwpBrowserWebSocket(options),
    sessionOptions,
  );
}

/** Opens a browser WebSocket and waits for the egress SERVER_INFO handshake. */
export async function connectQwpBrowserEgress(
  options: QwpBrowserWebSocketOptions,
  sessionOptions: QwpEgressSessionOptions = {},
): Promise<QwpEgressSession> {
  return QwpEgressSession.connect(
    () => connectQwpBrowserWebSocket(options),
    sessionOptions,
  );
}
