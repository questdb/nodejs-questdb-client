/** Node.js WebSocket adapter and shared QWP protocol/session APIs. */
export * from "./index";

import type { Agent } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import WebSocket from "ws";
import {
  decodeQwpContentEncoding,
  encodeQwpAcceptEncoding,
  QWP_VERSION,
  type QwpEgressCompression,
} from "./core";
import {
  openQwpWebSocket,
  QwpWebSocketLike,
  validateQwpWebSocketTimeouts,
} from "./internal/websocket-connection";
import { createQwpFailoverConnectionFactory } from "./internal/failover";
import { createQwpEgressFailoverConnectionFactory } from "./internal/egress-routing";
import {
  QWP_UPGRADE_ERROR_KIND,
  QwpBinaryConnection,
  QwpConnectionFactory,
  QwpDurableAckUnavailableError,
  QwpEgressRoutingOptions,
  QwpHandshakeMetadata,
  QwpUpgradeError,
  QwpWebSocketConnectOptions,
} from "./transport";
import { QwpEgressSession, QwpEgressSessionOptions } from "./egress-session";
import { QwpIngressSession, QwpIngressSessionOptions } from "./ingress-session";
import { QwpSender, QwpSenderOptions } from "./sender";
import { QwpClient, QwpClientPoolOptions } from "./client";
import { QwpNodeFileReplayStore } from "../qwp-node/file-replay-store";
import type { QwpNodeFileReplayStoreOptions } from "../qwp-node/file-replay-store";

export {
  QwpNodeFileReplayStore,
  QwpReplayStoreError,
  QwpReplayStoreFullError,
  QwpReplayStoreLockedError,
} from "../qwp-node/file-replay-store";
export type { QwpNodeFileReplayStoreOptions } from "../qwp-node/file-replay-store";

export type { QwpWebSocketLike } from "./internal/websocket-connection";

export class QwpVersionMismatchError extends QwpUpgradeError {
  constructor(
    readonly serverVersion: number,
    readonly clientMaxVersion: number,
    url?: string | URL,
  ) {
    super(
      `QWP server advertised unsupported version ${serverVersion} [client max=${clientMaxVersion}]`,
      {
        kind: QWP_UPGRADE_ERROR_KIND.VERSION_MISMATCH,
        retryable: true,
        tryNextEndpoint: true,
        url,
      },
    );
    this.name = "QwpVersionMismatchError";
  }
}

export interface QwpNodeUpgradeRejection {
  statusCode: number;
  statusMessage?: string;
  headers: IncomingHttpHeaders;
}

function classifyUpgradeRejection(
  url: string | URL,
  rejection: QwpNodeUpgradeRejection,
): QwpUpgradeError {
  const { statusCode, statusMessage, headers } = rejection;
  const serverRole = headerValue(headers, "x-questdb-role");
  const serverZone = headerValue(headers, "x-questdb-zone");
  const kind =
    statusCode === 401 || statusCode === 403
      ? QWP_UPGRADE_ERROR_KIND.AUTHENTICATION
      : statusCode === 421
        ? QWP_UPGRADE_ERROR_KIND.ROLE_REJECTED
        : QWP_UPGRADE_ERROR_KIND.HTTP_REJECTED;
  const suffix = statusMessage ? ` ${statusMessage}` : "";
  return new QwpUpgradeError(
    `QWP WebSocket upgrade rejected with HTTP ${statusCode}${suffix}`,
    {
      kind,
      retryable: statusCode === 421,
      tryNextEndpoint: statusCode !== 401 && statusCode !== 403,
      url,
      statusCode,
      statusMessage,
      serverRole,
      serverZone,
    },
  );
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
      onUpgradeRejected: (rejection: QwpNodeUpgradeRejection) => void;
    },
  ) => QwpWebSocketLike;
}

export interface QwpNodeIngressOptions extends QwpNodeWebSocketOptions {
  /**
   * Enables persistent Node store-and-forward and ingress reconnection. Use a
   * directory owned exclusively by this ingress session.
   */
  storeAndForward?: QwpNodeFileReplayStoreOptions;
}

export interface QwpNodeEgressOptions
  extends QwpNodeWebSocketOptions,
    QwpEgressRoutingOptions {
  /**
   * Requests Zstd-compressed result batches. The default is `raw`, which
   * preserves compatibility with servers that predate QWP compression.
   * `auto` currently advertises the same ordered preference as `zstd`.
   */
  compression?: QwpEgressCompression;
  /** Zstd level hint sent to the server. Must be between 1 and 22. */
  compressionLevel?: number;
}

/** Node configuration for a combined pooled QWP ingress/egress client. */
export interface QwpNodeClientOptions {
  ingress: QwpNodeIngressOptions;
  egress: QwpNodeEgressOptions;
  sender?: QwpSenderOptions;
  ingressSession?: QwpIngressSessionOptions;
  egressSession?: QwpEgressSessionOptions;
  pool?: QwpClientPoolOptions;
}

function egressTransportOptions(
  options: QwpNodeEgressOptions,
): QwpNodeWebSocketOptions {
  const compression = options.compression;
  const compressionLevel = options.compressionLevel ?? 1;
  const transport = { ...options };
  delete transport.compression;
  delete transport.compressionLevel;
  delete transport.target;
  delete transport.zone;
  const preference = compression ?? "raw";
  const acceptEncoding = encodeQwpAcceptEncoding(preference, compressionLevel);

  // Keep the low-level headers escape hatch backwards compatible unless the
  // typed compression option was explicitly selected.
  if (compression === undefined) return transport;

  const headers = { ...transport.headers };
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "x-qwp-accept-encoding") delete headers[name];
  }
  if (acceptEncoding) headers["X-QWP-Accept-Encoding"] = acceptEncoding;
  return { ...transport, headers };
}

/** Opens a Node QWP WebSocket with the upgrade headers required by QuestDB. */
export function connectQwpNodeWebSocket(
  options: QwpNodeWebSocketOptions,
): Promise<QwpBinaryConnection> {
  return createQwpNodeConnectionFactory(options)();
}

/** Creates a stateful Node endpoint walker suitable for session reconnects. */
export function createQwpNodeConnectionFactory(
  options: QwpNodeWebSocketOptions,
): QwpConnectionFactory {
  return createQwpFailoverConnectionFactory(
    options.url,
    options.failoverUrls,
    (endpoint) => connectQwpNodeEndpoint(options, endpoint),
  );
}

function connectQwpNodeEndpoint(
  options: QwpNodeWebSocketOptions,
  endpoint: string | URL,
): Promise<QwpBinaryConnection> {
  validateQwpWebSocketTimeouts(options);
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
        onUpgradeRejected: (rejection: QwpNodeUpgradeRejection) => void;
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
      socket.once("unexpected-response", (_request, response) => {
        init.onUpgradeRejected({
          statusCode: response.statusCode ?? 0,
          statusMessage: response.statusMessage,
          headers: response.headers,
        });
        response.resume();
      });
      const qwpSocket = socket as unknown as QwpWebSocketLike;
      qwpSocket.sendWithCallback = (data, callback) => {
        socket.send(data, callback);
      };
      return qwpSocket;
    });

  let upgradeHeaders: IncomingHttpHeaders | undefined;
  let rejectOpening!: (error: QwpUpgradeError) => void;
  const openingFailure = new Promise<never>((_resolve, reject) => {
    rejectOpening = reject;
  });
  const socket = factory(endpoint, {
    protocols: options.protocols,
    agent: options.agent,
    headers,
    onUpgrade: (receivedHeaders) => {
      upgradeHeaders = receivedHeaders;
    },
    onUpgradeRejected: (rejection) => {
      rejectOpening(classifyUpgradeRejection(endpoint, rejection));
    },
  });
  return openQwpWebSocket(socket, {
    url: endpoint,
    connectTimeoutMs: options.connectTimeoutMs,
    sendTimeoutMs: options.sendTimeoutMs,
    closeTimeoutMs: options.closeTimeoutMs,
    openingFailure,
    completeHandshake: () => {
      const qwpVersion = parseQwpVersion(upgradeHeaders);
      if (qwpVersion < 1 || qwpVersion > clientMaxVersion) {
        throw new QwpVersionMismatchError(
          qwpVersion,
          clientMaxVersion,
          endpoint,
        );
      }
      const durableAckEnabled =
        headerValue(upgradeHeaders, "x-qwp-durable-ack")?.toLowerCase() ===
        "enabled";
      if (options.requestDurableAck && !durableAckEnabled) {
        throw new QwpDurableAckUnavailableError(endpoint);
      }
      const contentEncoding = headerValue(
        upgradeHeaders,
        "x-qwp-content-encoding",
      );
      const handshake: QwpHandshakeMetadata = {
        qwpVersion,
        maxBatchSizeBytes: parseMaxBatchSize(upgradeHeaders),
        contentEncoding,
        negotiatedCompression: decodeQwpContentEncoding(contentEncoding),
        durableAckEnabled,
        serverRole: headerValue(upgradeHeaders, "x-questdb-role"),
        serverZone: headerValue(upgradeHeaders, "x-questdb-zone"),
      };
      return handshake;
    },
  });
}

/** Opens a Node WebSocket and starts an ingress ACK/NACK session. */
export async function connectQwpNodeIngress(
  options: QwpNodeIngressOptions,
  sessionOptions: QwpIngressSessionOptions = {},
): Promise<QwpIngressSession> {
  if (options.storeAndForward && sessionOptions.replayStore) {
    throw new RangeError(
      "storeAndForward and a custom replayStore cannot both be configured",
    );
  }
  if (
    sessionOptions.reconnect &&
    !options.storeAndForward &&
    !sessionOptions.replayStore
  ) {
    throw new RangeError(
      "Node QWP ingress reconnection requires a persistent storeAndForward directory",
    );
  }
  const replayStore = options.storeAndForward
    ? new QwpNodeFileReplayStore(options.storeAndForward)
    : sessionOptions.replayStore;
  const reconnect = options.storeAndForward
    ? {
        maxAttempts: 0,
        maxDurationMs: 0,
        ...sessionOptions.reconnect,
      }
    : sessionOptions.reconnect;
  const effectiveSessionOptions: QwpIngressSessionOptions = {
    ...sessionOptions,
    reconnect,
    replayStore,
    backgroundStoreAndForward: options.storeAndForward !== undefined,
    durableAckKeepaliveMs: options.requestDurableAck
      ? (sessionOptions.durableAckKeepaliveMs ?? 200)
      : sessionOptions.durableAckKeepaliveMs,
  };
  return QwpIngressSession.connect(
    createQwpNodeConnectionFactory(options),
    effectiveSessionOptions,
  );
}

/**
 * Creates a fluent Node QWP sender without opening the WebSocket yet.
 * Call connect(), or let the first flush connect lazily.
 */
export function createQwpNodeSender(
  options: QwpNodeIngressOptions,
  senderOptions: QwpSenderOptions = {},
  sessionOptions: QwpIngressSessionOptions = {},
): QwpSender {
  const effectiveSenderOptions: QwpSenderOptions = {
    ...senderOptions,
    awaitServerAck:
      senderOptions.awaitServerAck ??
      (options.storeAndForward ? senderOptions.awaitDurableAck === true : true),
  };
  return new QwpSender(
    () =>
      connectQwpNodeIngress(
        {
          ...options,
          requestDurableAck:
            options.requestDurableAck ?? effectiveSenderOptions.awaitDurableAck,
        },
        sessionOptions,
      ),
    effectiveSenderOptions,
  );
}

/** Opens a Node QWP connection and returns a fluent sender. */
export async function connectQwpNodeSender(
  options: QwpNodeIngressOptions,
  senderOptions: QwpSenderOptions = {},
  sessionOptions: QwpIngressSessionOptions = {},
): Promise<QwpSender> {
  const sender = createQwpNodeSender(options, senderOptions, sessionOptions);
  await sender.connect();
  return sender;
}

/** Opens a Node WebSocket and waits for the egress SERVER_INFO handshake. */
export async function connectQwpNodeEgress(
  options: QwpNodeEgressOptions,
  sessionOptions: QwpEgressSessionOptions = {},
): Promise<QwpEgressSession> {
  const transport = egressTransportOptions(options);
  return QwpEgressSession.connect(
    createQwpEgressFailoverConnectionFactory(
      transport.url,
      transport.failoverUrls,
      (endpoint) => connectQwpNodeEndpoint(transport, endpoint),
      { target: options.target, zone: options.zone },
      sessionOptions.serverInfoTimeoutMs ?? 15_000,
    ),
    sessionOptions,
  );
}

/** Creates a lazy Node QWP client with bounded sender and query pools. */
export function createQwpNodeClient(options: QwpNodeClientOptions): QwpClient {
  return new QwpClient(
    {
      createSender: async (slot) => {
        const ingress = pooledNodeIngressOptions(options.ingress, slot);
        const sender = createQwpNodeSender(
          ingress,
          options.sender,
          options.ingressSession,
        );
        try {
          await sender.connect();
          return sender;
        } catch (error) {
          await sender.close().catch(() => undefined);
          throw error;
        }
      },
      createQuerySession: () =>
        connectQwpNodeEgress(options.egress, options.egressSession),
    },
    pooledNodeClientOptions(options),
  );
}

/** Creates and prewarms a combined Node QWP ingress/egress client. */
export async function connectQwpNodeClient(
  options: QwpNodeClientOptions,
): Promise<QwpClient> {
  const client = createQwpNodeClient(options);
  await client.connect();
  return client;
}

function pooledNodeClientOptions(
  options: QwpNodeClientOptions,
): QwpClientPoolOptions | undefined {
  if (!options.ingress.storeAndForward) return options.pool;
  const senderPoolMax = options.pool?.senderPoolMax ?? 4;
  return {
    ...options.pool,
    senderPoolMin: senderPoolMax,
    senderPoolMax,
  };
}

function pooledNodeIngressOptions(
  options: QwpNodeIngressOptions,
  slot: number,
): QwpNodeIngressOptions {
  if (!options.storeAndForward) return options;
  const rootDirectory = options.storeAndForward.directory.trim();
  if (!rootDirectory) {
    throw new RangeError("storeAndForward directory must not be empty");
  }
  return {
    ...options,
    storeAndForward: {
      ...options.storeAndForward,
      directory: join(rootDirectory, `sender-${slot}`),
    },
  };
}
