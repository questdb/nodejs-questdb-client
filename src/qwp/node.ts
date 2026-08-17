/** Node.js WebSocket adapter and shared QWP protocol/session APIs. */
export * from "./index";

import { Dispatcher, WebSocket } from "undici";
import {
  openQwpWebSocket,
  QwpWebSocketLike,
} from "./internal/websocket-connection";
import { QwpBinaryConnection, QwpWebSocketConnectOptions } from "./transport";
import { QwpIngressSession, QwpIngressSessionOptions } from "./ingress-session";

export type { QwpWebSocketLike } from "./internal/websocket-connection";

export interface QwpNodeWebSocketOptions extends QwpWebSocketConnectOptions {
  headers?: Record<string, string>;
  dispatcher?: Dispatcher;
  authorization?: string;
  clientId?: string;
  maxVersion?: number;
  requestDurableAck?: boolean;
  /** Test hook; defaults to Undici's WebSocket implementation. */
  webSocketFactory?: (
    url: string | URL,
    options: {
      protocols?: string | string[];
      dispatcher?: Dispatcher;
      headers: Record<string, string>;
    },
  ) => QwpWebSocketLike;
}

/** Opens a Node QWP WebSocket with the upgrade headers required by QuestDB. */
export function connectQwpNodeWebSocket(
  options: QwpNodeWebSocketOptions,
): Promise<QwpBinaryConnection> {
  const headers: Record<string, string> = {
    "X-QWP-Max-Version": String(options.maxVersion ?? 1),
    "X-QWP-Client-Id": options.clientId ?? "typescript/1.0.0",
    ...options.headers,
  };
  if (options.authorization) headers.Authorization = options.authorization;
  if (options.requestDurableAck) {
    headers["X-QWP-Request-Durable-Ack"] = "true";
  }

  const factory =
    options.webSocketFactory ??
    ((
      url: string | URL,
      init: {
        protocols?: string | string[];
        dispatcher?: Dispatcher;
        headers: Record<string, string>;
      },
    ) =>
      new WebSocket(url, {
        protocols: init.protocols,
        dispatcher: init.dispatcher,
        headers: init.headers,
      }) as unknown as QwpWebSocketLike);

  const socket = factory(options.url, {
    protocols: options.protocols,
    dispatcher: options.dispatcher,
    headers,
  });
  return openQwpWebSocket(socket, options.connectTimeoutMs);
}

/** Opens a Node WebSocket and starts an ingress ACK/NACK session. */
export async function connectQwpNodeIngress(
  options: QwpNodeWebSocketOptions,
  sessionOptions: QwpIngressSessionOptions = {},
): Promise<QwpIngressSession> {
  return new QwpIngressSession(
    await connectQwpNodeWebSocket(options),
    sessionOptions,
  );
}
