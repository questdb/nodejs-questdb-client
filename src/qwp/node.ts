/** Node.js WebSocket adapter and shared QWP protocol/session APIs. */
export * from "./index";

import type { Agent } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import WebSocket from "ws";
import { QWP_VERSION } from "./core";
import {
  openQwpWebSocket,
  QwpWebSocketLike,
} from "./internal/websocket-connection";
import {
  QwpBinaryConnection,
  QwpHandshakeMetadata,
  QwpWebSocketConnectOptions,
} from "./transport";
import { QwpEgressSession, QwpEgressSessionOptions } from "./egress-session";
import { QwpIngressSession, QwpIngressSessionOptions } from "./ingress-session";

export type { QwpWebSocketLike } from "./internal/websocket-connection";

export class QwpDurableAckUnavailableError extends Error {
  constructor(readonly url: string | URL) {
    super(
      `QWP durable ACK was requested, but the server did not advertise support [url=${url}]`,
    );
    this.name = "QwpDurableAckUnavailableError";
  }
}

export class QwpVersionMismatchError extends Error {
  constructor(
    readonly serverVersion: number,
    readonly clientMaxVersion: number,
  ) {
    super(
      `QWP server advertised unsupported version ${serverVersion} [client max=${clientMaxVersion}]`,
    );
    this.name = "QwpVersionMismatchError";
  }
}

function headerValue(
  headers: IncomingHttpHeaders | undefined,
  name: string,
): string | undefined {
  const value = headers?.[name];
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
}

function parseQwpVersion(headers: IncomingHttpHeaders | undefined): number {
  const value = headerValue(headers, "x-qwp-version");
  if (!value || !/^\d+$/.test(value)) return QWP_VERSION;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : QWP_VERSION;
}

function parseMaxBatchSize(
  headers: IncomingHttpHeaders | undefined,
): number | undefined {
  const value = headerValue(headers, "x-qwp-max-batch-size");
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 0x7fffffff
    ? parsed
    : undefined;
}

export interface QwpNodeWebSocketOptions extends QwpWebSocketConnectOptions {
  headers?: Record<string, string>;
  /** Optional HTTP(S) agent used for the WebSocket upgrade. */
  agent?: Agent;
  authorization?: string;
  clientId?: string;
  maxVersion?: number;
  requestDurableAck?: boolean;
  /** Test hook; defaults to the Node-only `ws` implementation. */
  webSocketFactory?: (
    url: string | URL,
    options: {
      protocols?: string | string[];
      agent?: Agent;
      headers: Record<string, string>;
      onUpgrade: (headers: IncomingHttpHeaders) => void;
    },
  ) => QwpWebSocketLike;
}

/** Opens a Node QWP WebSocket with the upgrade headers required by QuestDB. */
export function connectQwpNodeWebSocket(
  options: QwpNodeWebSocketOptions,
): Promise<QwpBinaryConnection> {
  const clientMaxVersion = options.maxVersion ?? QWP_VERSION;
  if (
    !Number.isSafeInteger(clientMaxVersion) ||
    clientMaxVersion < 1 ||
    clientMaxVersion > QWP_VERSION
  ) {
    return Promise.reject(
      new RangeError(
        `maxVersion must be an integer between 1 and ${QWP_VERSION}`,
      ),
    );
  }
  const headers: Record<string, string> = {
    "X-QWP-Max-Version": String(clientMaxVersion),
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
        agent?: Agent;
        headers: Record<string, string>;
        onUpgrade: (headers: IncomingHttpHeaders) => void;
      },
    ) => {
      const wsOptions: WebSocket.ClientOptions = {
        agent: init.agent,
        headers: init.headers,
        perMessageDeflate: false,
      };
      const socket = init.protocols
        ? new WebSocket(url, init.protocols, wsOptions)
        : new WebSocket(url, wsOptions);
      socket.once("upgrade", (response) => init.onUpgrade(response.headers));
      return socket as unknown as QwpWebSocketLike;
    });

  let upgradeHeaders: IncomingHttpHeaders | undefined;
  const socket = factory(options.url, {
    protocols: options.protocols,
    agent: options.agent,
    headers,
    onUpgrade: (receivedHeaders) => {
      upgradeHeaders = receivedHeaders;
    },
  });
  return openQwpWebSocket(socket, options.connectTimeoutMs, () => {
    const qwpVersion = parseQwpVersion(upgradeHeaders);
    if (qwpVersion < 1 || qwpVersion > clientMaxVersion) {
      throw new QwpVersionMismatchError(qwpVersion, clientMaxVersion);
    }
    const durableAckEnabled =
      headerValue(upgradeHeaders, "x-qwp-durable-ack")?.toLowerCase() ===
      "enabled";
    if (options.requestDurableAck && !durableAckEnabled) {
      throw new QwpDurableAckUnavailableError(options.url);
    }
    const handshake: QwpHandshakeMetadata = {
      qwpVersion,
      maxBatchSizeBytes: parseMaxBatchSize(upgradeHeaders),
      contentEncoding: headerValue(upgradeHeaders, "x-qwp-content-encoding"),
      durableAckEnabled,
      serverRole: headerValue(upgradeHeaders, "x-questdb-role"),
    };
    return handshake;
  });
}

/** Opens a Node WebSocket and starts an ingress ACK/NACK session. */
export async function connectQwpNodeIngress(
  options: QwpNodeWebSocketOptions,
  sessionOptions: QwpIngressSessionOptions = {},
): Promise<QwpIngressSession> {
  const effectiveSessionOptions = options.requestDurableAck
    ? {
        ...sessionOptions,
        durableAckKeepaliveMs: sessionOptions.durableAckKeepaliveMs ?? 200,
      }
    : sessionOptions;
  return QwpIngressSession.connect(
    () => connectQwpNodeWebSocket(options),
    effectiveSessionOptions,
  );
}

/** Opens a Node WebSocket and waits for the egress SERVER_INFO handshake. */
export async function connectQwpNodeEgress(
  options: QwpNodeWebSocketOptions,
  sessionOptions: QwpEgressSessionOptions = {},
): Promise<QwpEgressSession> {
  return QwpEgressSession.connect(
    () => connectQwpNodeWebSocket(options),
    sessionOptions,
  );
}
