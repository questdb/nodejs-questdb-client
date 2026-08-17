/** Browser WebSocket adapter and browser-safe QWP protocol/session APIs. */
export * from "./index";

import {
  openQwpWebSocket,
  QwpWebSocketLike,
  validateQwpWebSocketTimeouts,
} from "./internal/websocket-connection";
import { createQwpFailoverConnectionFactory } from "./internal/failover";
import {
  addQwpDurableAckWebSocketProtocol,
  isQwpDurableAckWebSocketProtocol,
  QWP_VERSION,
} from "./core";
import {
  QwpBinaryConnection,
  QwpConnectionFactory,
  QwpDurableAckUnavailableError,
  QwpWebSocketConnectOptions,
} from "./transport";
import { QwpEgressSession, QwpEgressSessionOptions } from "./egress-session";
import { QwpIngressSession, QwpIngressSessionOptions } from "./ingress-session";
import { QwpSender, QwpSenderOptions } from "./sender";

export type { QwpWebSocketLike } from "./internal/websocket-connection";

export interface QwpBrowserWebSocketOptions extends QwpWebSocketConnectOptions {
  /**
   * Requests durable ingress ACKs through browser-visible WebSocket
   * subprotocol negotiation.
   */
  requestDurableAck?: boolean;
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
  return createQwpBrowserConnectionFactory(options)();
}

/** Creates a stateful browser endpoint walker suitable for session reconnects. */
export function createQwpBrowserConnectionFactory(
  options: QwpBrowserWebSocketOptions,
): QwpConnectionFactory {
  return createQwpFailoverConnectionFactory(
    options.url,
    options.failoverUrls,
    (endpoint) => connectQwpBrowserEndpoint(options, endpoint),
  );
}

function connectQwpBrowserEndpoint(
  options: QwpBrowserWebSocketOptions,
  endpoint: string | URL,
): Promise<QwpBinaryConnection> {
  validateQwpWebSocketTimeouts(options);
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
  const protocols = options.requestDurableAck
    ? addQwpDurableAckWebSocketProtocol(options.protocols)
    : options.protocols;
  const socket = factory(endpoint, protocols);
  return openQwpWebSocket(socket, {
    url: endpoint,
    connectTimeoutMs: options.connectTimeoutMs,
    sendTimeoutMs: options.sendTimeoutMs,
    closeTimeoutMs: options.closeTimeoutMs,
    completeHandshake: () => {
      const durableAckEnabled = isQwpDurableAckWebSocketProtocol(
        socket.protocol,
      );
      if (options.requestDurableAck && !durableAckEnabled) {
        throw new QwpDurableAckUnavailableError(endpoint);
      }
      return durableAckEnabled
        ? { qwpVersion: QWP_VERSION, durableAckEnabled: true }
        : { qwpVersion: QWP_VERSION };
    },
    opaqueErrors: true,
  });
}

/** Opens a browser WebSocket and starts an ingress ACK/NACK session. */
export async function connectQwpBrowserIngress(
  options: QwpBrowserWebSocketOptions,
  sessionOptions: QwpIngressSessionOptions = {},
): Promise<QwpIngressSession> {
  const effectiveSessionOptions: QwpIngressSessionOptions = {
    ...sessionOptions,
    durableAckKeepaliveMs: options.requestDurableAck
      ? (sessionOptions.durableAckKeepaliveMs ?? 200)
      : sessionOptions.durableAckKeepaliveMs,
  };
  return QwpIngressSession.connect(
    createQwpBrowserConnectionFactory(options),
    effectiveSessionOptions,
  );
}

/**
 * Creates a browser-safe fluent QWP sender without opening the WebSocket yet.
 * Call connect(), or let the first flush connect lazily.
 */
export function createQwpBrowserSender(
  options: QwpBrowserWebSocketOptions,
  senderOptions: QwpSenderOptions = {},
  sessionOptions: QwpIngressSessionOptions = {},
): QwpSender {
  return new QwpSender(
    () =>
      connectQwpBrowserIngress(
        {
          ...options,
          requestDurableAck:
            options.requestDurableAck ?? senderOptions.awaitDurableAck,
        },
        sessionOptions,
      ),
    senderOptions,
  );
}

/** Opens a browser QWP connection and returns a fluent sender. */
export async function connectQwpBrowserSender(
  options: QwpBrowserWebSocketOptions,
  senderOptions: QwpSenderOptions = {},
  sessionOptions: QwpIngressSessionOptions = {},
): Promise<QwpSender> {
  const sender = createQwpBrowserSender(options, senderOptions, sessionOptions);
  await sender.connect();
  return sender;
}

/** Opens a browser WebSocket and waits for the egress SERVER_INFO handshake. */
export async function connectQwpBrowserEgress(
  options: QwpBrowserWebSocketOptions,
  sessionOptions: QwpEgressSessionOptions = {},
): Promise<QwpEgressSession> {
  return QwpEgressSession.connect(
    createQwpBrowserConnectionFactory(options),
    sessionOptions,
  );
}
