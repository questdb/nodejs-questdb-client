/** Node.js WebSocket adapter and shared QWP protocol/session APIs. */
export * from "./index";

import type { Agent } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { basename, dirname, join } from "node:path";
import WebSocket from "ws";
import { log } from "../logging";
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
import { validateQwpMaxBatchRows } from "./internal/egress-limits";
import { resolveQwpNodeClientConfig } from "../qwp-node/client-config";
import {
  QWP_INITIAL_CONNECT_MODE,
  QWP_UPGRADE_ERROR_KIND,
  QwpBinaryConnection,
  QwpConnectionFactory,
  QwpDurableAckUnavailableError,
  QwpEgressRoutingOptions,
  QwpHandshakeMetadata,
  QwpInitialConnectMode,
  QwpUnrecoverableReplayDictionaryError,
  QwpUpgradeError,
  QwpWebSocketConnectOptions,
} from "./transport";
import { QwpEgressSession, QwpEgressSessionOptions } from "./egress-session";
import { QwpIngressSession, QwpIngressSessionOptions } from "./ingress-session";
import { QwpSender, QwpSenderOptions } from "./sender";
import { QwpClient, QwpClientPoolOptions } from "./client";
import {
  quarantineQwpNodeReplayStore,
  QwpNodeFileReplayStore,
  QwpReplayStoreCorruptionError,
  QwpReplayStoreQuarantinedError,
} from "../qwp-node/file-replay-store";
import type { QwpNodeFileReplayStoreOptions } from "../qwp-node/file-replay-store";
import {
  QwpNodeOrphanDrainer,
  type QwpNodeOrphanDrainEvent,
} from "../qwp-node/orphan-drainer";

export {
  QWP_SF_BACKPRESSURE_POLICY,
  QWP_SF_DURABILITY,
  QwpNodeFileReplayStore,
  QwpReplayStoreAppendTimeoutError,
  QwpReplayStoreCheckpointError,
  QwpReplayStoreCorruptionError,
  QwpReplayStoreError,
  QwpReplayStoreFullError,
  QwpReplayStoreLockedError,
  QwpReplayStoreQuarantinedError,
  QwpReplayStoreSegmentTooLargeError,
} from "../qwp-node/file-replay-store";
export type {
  QwpNodeFileReplayStoreMetrics,
  QwpNodeFileReplayStoreOptions,
  QwpSfBackpressurePolicy,
  QwpSfDurability,
} from "../qwp-node/file-replay-store";
export {
  QWP_ORPHAN_DRAIN_EVENT_KIND,
  QWP_ORPHAN_FAILED_SENTINEL,
  QwpNodeOrphanDrainer,
  retryQwpNodeOrphanSlot,
  scanQwpNodeOrphanSlots,
} from "../qwp-node/orphan-drainer";
export type {
  QwpNodeOrphanDrainEvent,
  QwpNodeOrphanDrainEventKind,
  QwpNodeOrphanDrainerMetrics,
  QwpNodeOrphanDrainerOptions,
} from "../qwp-node/orphan-drainer";

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
  /**
   * Time allowed after TCP/TLS connection for HTTP authentication and the
   * WebSocket upgrade. Defaults to 15s.
   */
  authTimeoutMs?: number;
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
      /** Must be called when the underlying TCP/TLS transport is connected. */
      onConnected: () => void;
      onUpgrade: (headers: IncomingHttpHeaders) => void;
      onUpgradeRejected: (rejection: QwpNodeUpgradeRejection) => void;
    },
  ) => QwpWebSocketLike;
}

export interface QwpNodeIngressOptions extends QwpNodeWebSocketOptions {
  /**
   * Upgrades the default in-memory ingress replay to persistent Node
   * store-and-forward. Use a directory owned exclusively by this session.
   */
  storeAndForward?: QwpNodeStoreAndForwardOptions;
  /**
   * Slot name below storeAndForward.directory. Unified configurations default
   * to `default`; pooled clients derive `<senderId>-<slot>` names.
   */
  senderId?: string;
}

/** Notification that an unreplayable foreground slot was preserved aside. */
export interface QwpNodeReplayRecoveryEvent {
  readonly timestampMs: number;
  readonly directory: string;
  readonly quarantineDirectory: string;
  readonly error: QwpReplayStoreQuarantinedError;
}

/** Node store-and-forward controls layered on the crash-safe replay journal. */
export interface QwpNodeStoreAndForwardOptions
  extends QwpNodeFileReplayStoreOptions {
  /**
   * Initial server connection policy. Defaults to `off`; an explicitly tuned
   * reconnect policy promotes it to `sync`, matching the Java client.
   */
  initialConnectMode?: QwpInitialConnectMode;
  /**
   * Minimum time an orphan slot's symbol catch-up cap gap must persist before
   * it is quarantined. The gap must also be observed 16 times. Defaults to
   * five minutes; zero uses the observation threshold alone.
   */
  catchUpCapGapMinEscalationWindowMs?: number;
  /**
   * Adopts sibling replay slots left by terminated producers. Standalone
   * senders default this to false; pooled clients always recover their own
   * out-of-range `sender-N` slots after a pool-size reduction.
   */
  drainOrphans?: boolean;
  /** Maximum sibling slots drained concurrently. Defaults to 4. */
  maxBackgroundDrainers?: number;
  /** Rescan cadence; zero scans only at startup. Defaults to 30 seconds. */
  orphanScanIntervalMs?: number;
  /** Receives isolated scanner and drainer lifecycle notifications. */
  onOrphanDrainEvent?: (event: QwpNodeOrphanDrainEvent) => void;
  /**
   * Receives a data-loss notification when corrupt foreground replay bytes are
   * preserved under an `.unreplayable-N` pathname and a fresh slot is opened.
   */
  onRecoveryQuarantine?: (event: QwpNodeReplayRecoveryEvent) => void;
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
  /** Requests a server-side RESULT_BATCH row cap. */
  maxBatchRows?: number;
}

/** Node configuration for a combined pooled QWP ingress/egress client. */
export interface QwpNodeClientOptions {
  ingress: QwpNodeIngressOptions;
  egress: QwpNodeEgressOptions;
  sender?: QwpSenderOptions;
  ingressSession?: QwpIngressSessionOptions;
  egressSession?: QwpEgressSessionOptions;
  pool?: QwpClientPoolOptions;
  /**
   * Coordinates a non-blocking startup: ingress connects in the background,
   * using memory replay when store-and-forward is absent, and the egress pool
   * remains cold until the first query. Conflicts with a positive queryPoolMin
   * or a non-async initialConnectMode.
   */
  lazyConnect?: boolean;
}

/**
 * Programmatic hooks layered over a unified ws/wss cluster string. Values in
 * this object take precedence after the complete string has been validated.
 */
export interface QwpNodeClientConfigOptions {
  /** Shared transport overrides applied to both ingress and egress. */
  webSocket?: Partial<Omit<QwpNodeWebSocketOptions, "url" | "failoverUrls">>;
  /** Optional persistent ingress configuration; may supply/override sf_dir. */
  storeAndForward?: QwpNodeStoreAndForwardOptions;
  /** Egress-only routing and compression overrides. */
  egress?: Partial<
    Pick<
      QwpNodeEgressOptions,
      "target" | "zone" | "compression" | "compressionLevel" | "maxBatchRows"
    >
  >;
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
  const maxBatchRows = validateQwpMaxBatchRows(options.maxBatchRows);
  const transport = { ...options };
  delete transport.compression;
  delete transport.compressionLevel;
  delete transport.maxBatchRows;
  delete transport.target;
  delete transport.zone;
  const preference = compression ?? "raw";
  const acceptEncoding = encodeQwpAcceptEncoding(preference, compressionLevel);

  // Keep the low-level headers escape hatch backwards compatible unless the
  // typed compression option was explicitly selected.
  if (compression === undefined && maxBatchRows === undefined) return transport;

  const headers = { ...transport.headers };
  if (compression !== undefined) {
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "x-qwp-accept-encoding") delete headers[name];
    }
    if (acceptEncoding) headers["X-QWP-Accept-Encoding"] = acceptEncoding;
  }
  if (maxBatchRows !== undefined) {
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "x-qwp-max-batch-rows") delete headers[name];
    }
    headers["X-QWP-Max-Batch-Rows"] = String(maxBatchRows);
  }
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
        onConnected: () => void;
        onUpgrade: (headers: IncomingHttpHeaders) => void;
        onUpgradeRejected: (rejection: QwpNodeUpgradeRejection) => void;
      },
    ) => {
      const wsOptions: WebSocket.ClientOptions = {
        agent: init.agent,
        headers: init.headers,
        perMessageDeflate: false,
        finishRequest: (request) => {
          request.once("socket", (socket) => {
            if (!socket.connecting) {
              init.onConnected();
              return;
            }
            const protocol = new URL(url).protocol;
            socket.once(
              protocol === "wss:" || protocol === "https:"
                ? "secureConnect"
                : "connect",
              init.onConnected,
            );
          });
          request.end();
        },
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
  let resolveConnected!: () => void;
  const transportConnected = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });
  let rejectOpening!: (error: QwpUpgradeError) => void;
  const openingFailure = new Promise<never>((_resolve, reject) => {
    rejectOpening = reject;
  });
  const socket = factory(endpoint, {
    protocols: options.protocols,
    agent: options.agent,
    headers,
    onConnected: resolveConnected,
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
    authTimeoutMs: options.authTimeoutMs,
    transportConnected,
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
  return connectQwpNodeIngressInternal(options, sessionOptions, true);
}

async function connectQwpNodeIngressInternal(
  options: QwpNodeIngressOptions,
  sessionOptions: QwpIngressSessionOptions,
  startOrphanDrainer: boolean,
): Promise<QwpIngressSession> {
  const storeAndForward = resolveNodeStoreAndForwardOptions(options);
  if (storeAndForward && sessionOptions.replayStore) {
    throw new RangeError(
      "storeAndForward and a custom replayStore cannot both be configured",
    );
  }
  let replayStore = storeAndForward
    ? new QwpNodeFileReplayStore(storeAndForward)
    : sessionOptions.replayStore;
  const reconnect = storeAndForward
    ? (sessionOptions.reconnect ?? {})
    : sessionOptions.reconnect;
  const initialConnectMode = storeAndForward
    ? validateInitialConnectMode(
        storeAndForward.initialConnectMode ??
          (sessionOptions.reconnect === undefined
            ? QWP_INITIAL_CONNECT_MODE.OFF
            : QWP_INITIAL_CONNECT_MODE.SYNC),
      )
    : sessionOptions.initialConnectMode;
  const backgroundReplay =
    storeAndForward !== undefined ||
    sessionOptions.backgroundStoreAndForward === true ||
    initialConnectMode === QWP_INITIAL_CONNECT_MODE.ASYNC;
  const storeBatchCap =
    storeAndForward?.maxSegmentBytes ??
    (storeAndForward ? 4 * 1024 * 1024 : undefined);
  const effectiveSessionOptions: QwpIngressSessionOptions = {
    ...sessionOptions,
    reconnect,
    replayStore,
    backgroundStoreAndForward: backgroundReplay,
    initialConnectMode,
    maxBatchSizeBytes: minimumDefined(
      sessionOptions.maxBatchSizeBytes,
      storeBatchCap,
    ),
    catchUpCapGapMinEscalationWindowMs:
      storeAndForward?.catchUpCapGapMinEscalationWindowMs,
    durableAckKeepaliveMs: options.requestDurableAck
      ? (sessionOptions.durableAckKeepaliveMs ?? 200)
      : sessionOptions.durableAckKeepaliveMs,
  };
  const orphanDrainer =
    startOrphanDrainer && storeAndForward?.drainOrphans === true
      ? createStandaloneOrphanDrainer(
          { ...options, senderId: undefined, storeAndForward },
          sessionOptions,
        )
      : undefined;
  const connectionFactory = createQwpNodeConnectionFactory(options);
  let session: QwpIngressSession;
  try {
    session = await QwpIngressSession.connect(
      connectionFactory,
      effectiveSessionOptions,
    );
  } catch (error) {
    if (
      !storeAndForward ||
      sessionOptions.orphanStoreAndForward === true ||
      !isQuarantinableReplayRecoveryError(error)
    ) {
      throw error;
    }
    const recoveryError = await quarantineQwpNodeReplayStore(
      storeAndForward.directory,
      error,
    );
    emitReplayRecoveryQuarantine(storeAndForward, recoveryError);
    replayStore = new QwpNodeFileReplayStore(storeAndForward);
    session = await QwpIngressSession.connect(connectionFactory, {
      ...effectiveSessionOptions,
      replayStore,
    });
  }
  if (orphanDrainer) {
    session.registerCloseHook(() => orphanDrainer.close());
    orphanDrainer.start();
  }
  return session;
}

function isQuarantinableReplayRecoveryError(error: unknown): boolean {
  return (
    error instanceof QwpReplayStoreCorruptionError ||
    error instanceof QwpUnrecoverableReplayDictionaryError
  );
}

function emitReplayRecoveryQuarantine(
  options: QwpNodeStoreAndForwardOptions,
  error: QwpReplayStoreQuarantinedError,
): void {
  const event: QwpNodeReplayRecoveryEvent = {
    timestampMs: Date.now(),
    directory: error.directory,
    quarantineDirectory: error.quarantineDirectory,
    error,
  };
  if (!options.onRecoveryQuarantine) {
    log("error", error);
    return;
  }
  try {
    options.onRecoveryQuarantine(event);
  } catch {
    // Recovery already succeeded. A notification callback must not brick the
    // fresh producer slot; fall back to the default logger instead.
    log("error", error);
  }
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
      (options.storeAndForward ||
      sessionOptions.backgroundStoreAndForward === true ||
      sessionOptions.initialConnectMode === QWP_INITIAL_CONNECT_MODE.ASYNC
        ? senderOptions.awaitDurableAck === true
        : true),
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

/** Resolves and validates one ws/wss configuration string for both QWP sides. */
export function parseQwpNodeClientConfig(
  configurationString: string,
  extraOptions: QwpNodeClientConfigOptions = {},
): QwpNodeClientOptions {
  return normalizeQwpNodeClientOptions(
    resolveQwpNodeClientConfig(configurationString, extraOptions),
  );
}

/** Creates a lazy Node QWP client with bounded sender and query pools. */
export function createQwpNodeClient(options: QwpNodeClientOptions): QwpClient;
export function createQwpNodeClient(
  configurationString: string,
  extraOptions?: QwpNodeClientConfigOptions,
): QwpClient;
export function createQwpNodeClient(
  optionsOrConfiguration: QwpNodeClientOptions | string,
  extraOptions: QwpNodeClientConfigOptions = {},
): QwpClient {
  const options = resolveNodeClientOptions(
    optionsOrConfiguration,
    extraOptions,
  );
  const orphanDrainer = createPooledOrphanDrainer(options);
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
      start: () => orphanDrainer?.start(),
      close: () => orphanDrainer?.close(),
    },
    pooledNodeClientOptions(options),
  );
}

/** Creates and prewarms a combined Node QWP ingress/egress client. */
export function connectQwpNodeClient(
  options: QwpNodeClientOptions,
): Promise<QwpClient>;
export async function connectQwpNodeClient(
  configurationString: string,
  extraOptions?: QwpNodeClientConfigOptions,
): Promise<QwpClient>;
export async function connectQwpNodeClient(
  optionsOrConfiguration: QwpNodeClientOptions | string,
  extraOptions: QwpNodeClientConfigOptions = {},
): Promise<QwpClient> {
  const client = createQwpNodeClient(
    resolveNodeClientOptions(optionsOrConfiguration, extraOptions),
  );
  await client.connect();
  return client;
}

function resolveNodeClientOptions(
  optionsOrConfiguration: QwpNodeClientOptions | string,
  extraOptions: QwpNodeClientConfigOptions,
): QwpNodeClientOptions {
  return typeof optionsOrConfiguration === "string"
    ? parseQwpNodeClientConfig(optionsOrConfiguration, extraOptions)
    : normalizeQwpNodeClientOptions(optionsOrConfiguration);
}

function normalizeQwpNodeClientOptions(
  options: QwpNodeClientOptions,
): QwpNodeClientOptions {
  const storeAndForward = options.ingress.storeAndForward;
  const storeInitialConnectMode = storeAndForward?.initialConnectMode;
  const sessionInitialConnectMode = options.ingressSession?.initialConnectMode;
  if (
    storeInitialConnectMode !== undefined &&
    sessionInitialConnectMode !== undefined &&
    storeInitialConnectMode !== sessionInitialConnectMode
  ) {
    throw new RangeError(
      `conflicting configuration: storeAndForward.initialConnectMode='${storeInitialConnectMode}' differs from ingressSession.initialConnectMode='${sessionInitialConnectMode}'`,
    );
  }
  if (!options.lazyConnect) return options;
  for (const configuredInitialConnectMode of [
    storeInitialConnectMode,
    sessionInitialConnectMode,
  ]) {
    if (
      configuredInitialConnectMode === undefined ||
      configuredInitialConnectMode === QWP_INITIAL_CONNECT_MODE.ASYNC
    ) {
      continue;
    }
    throw new RangeError(
      `conflicting configuration: lazyConnect requires initialConnectMode='async', got '${configuredInitialConnectMode}'`,
    );
  }
  if ((options.pool?.queryPoolMin ?? 0) > 0) {
    throw new RangeError(
      `conflicting configuration: lazyConnect requires queryPoolMin=0, got ${options.pool?.queryPoolMin}`,
    );
  }
  return {
    ...options,
    ingress: {
      ...options.ingress,
      storeAndForward: storeAndForward
        ? {
            ...storeAndForward,
            initialConnectMode: QWP_INITIAL_CONNECT_MODE.ASYNC,
          }
        : undefined,
    },
    sender: {
      ...options.sender,
      awaitServerAck: options.sender?.awaitServerAck ?? false,
    },
    ingressSession: {
      ...options.ingressSession,
      backgroundStoreAndForward: true,
      initialConnectMode: QWP_INITIAL_CONNECT_MODE.ASYNC,
    },
    pool: { ...options.pool, queryPoolMin: 0 },
  };
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
    senderId: undefined,
    storeAndForward: {
      ...options.storeAndForward,
      directory: join(
        rootDirectory,
        `${validateQwpSenderId(options.senderId ?? "sender")}-${slot}`,
      ),
      // The client-level drainer owns sibling adoption. Per-sender scanners
      // would contend with other managed pool slots during prewarm/borrows.
      drainOrphans: false,
    },
  };
}

function createStandaloneOrphanDrainer(
  options: QwpNodeIngressOptions,
  sessionOptions: QwpIngressSessionOptions,
): QwpNodeOrphanDrainer {
  const storeAndForward = options.storeAndForward!;
  const ownDirectory = storeAndForward.directory.trim();
  return createNodeOrphanDrainer(
    options,
    sessionOptions,
    dirname(ownDirectory),
    (slotName) => slotName === basename(ownDirectory),
  );
}

function createPooledOrphanDrainer(
  options: QwpNodeClientOptions,
): QwpNodeOrphanDrainer | undefined {
  const storeAndForward = options.ingress.storeAndForward;
  if (!storeAndForward) return undefined;
  const rootDirectory = storeAndForward.directory.trim();
  if (!rootDirectory) {
    throw new RangeError("storeAndForward directory must not be empty");
  }
  const managedSlotCount = options.pool?.senderPoolMax ?? 4;
  const senderId = validateQwpSenderId(options.ingress.senderId ?? "sender");
  return createNodeOrphanDrainer(
    options.ingress,
    options.ingressSession ?? {},
    rootDirectory,
    (slotName) => {
      const managedIndex = parseCanonicalSenderSlot(slotName, senderId);
      if (managedIndex !== undefined && managedIndex < managedSlotCount) {
        return true;
      }
      // Same-base slots outside the new pool range are always recovered. A
      // caller must opt in before unrelated/legacy sibling names are adopted.
      return (
        managedIndex === undefined && storeAndForward.drainOrphans !== true
      );
    },
  );
}

function createNodeOrphanDrainer(
  options: QwpNodeIngressOptions,
  sessionOptions: QwpIngressSessionOptions,
  rootDirectory: string,
  excludeSlot: (slotName: string) => boolean,
): QwpNodeOrphanDrainer {
  const storeAndForward = options.storeAndForward!;
  return new QwpNodeOrphanDrainer({
    rootDirectory,
    excludeSlot,
    maxConcurrent: storeAndForward.maxBackgroundDrainers,
    scanIntervalMs: storeAndForward.orphanScanIntervalMs,
    durableAckPollIntervalMs: options.requestDurableAck
      ? (sessionOptions.durableAckKeepaliveMs ?? 200)
      : 0,
    onEvent: storeAndForward.onOrphanDrainEvent,
    createSession: (directory) =>
      connectQwpNodeIngressInternal(
        {
          ...options,
          senderId: undefined,
          storeAndForward: {
            ...storeAndForward,
            directory,
            drainOrphans: false,
            // Orphan adoption is always non-blocking. Terminal endpoint-policy
            // failures and cap-gap quarantine are selected below.
            initialConnectMode: QWP_INITIAL_CONNECT_MODE.ASYNC,
          },
        },
        orphanIngressSessionOptions(sessionOptions),
        false,
      ),
  });
}

function orphanIngressSessionOptions(
  options: QwpIngressSessionOptions,
): QwpIngressSessionOptions {
  return {
    ...options,
    // No foreground caller remains to retry orphan bytes, so transport
    // outages stay retryable for the drainer's lifetime. Authentication,
    // protocol, and poison-frame failures remain terminal and quarantined.
    reconnect: {
      ...options.reconnect,
      maxAttempts: 0,
      maxDurationMs: 0,
    },
    replayStore: undefined,
    backgroundStoreAndForward: undefined,
    initialConnectMode: undefined,
    orphanStoreAndForward: true,
    onResponse: undefined,
    onDurableAck: undefined,
    onProgress: undefined,
    onError: undefined,
  };
}

function parseCanonicalSenderSlot(
  name: string,
  senderId = "sender",
): number | undefined {
  const escapedSenderId = senderId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escapedSenderId}-(0|[1-9]\\d*)$`).exec(name);
  if (!match) return undefined;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? index : undefined;
}

function resolveNodeStoreAndForwardOptions(
  options: QwpNodeIngressOptions,
): QwpNodeStoreAndForwardOptions | undefined {
  const storeAndForward = options.storeAndForward;
  if (!storeAndForward || options.senderId === undefined)
    return storeAndForward;
  const rootDirectory = storeAndForward.directory.trim();
  if (!rootDirectory) {
    throw new RangeError("storeAndForward directory must not be empty");
  }
  return {
    ...storeAndForward,
    directory: join(rootDirectory, validateQwpSenderId(options.senderId)),
  };
}

function validateQwpSenderId(value: string): string {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new RangeError(
      "senderId must contain only letters, digits, underscores, and hyphens",
    );
  }
  return value;
}

function minimumDefined(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function validateInitialConnectMode(
  value: QwpInitialConnectMode,
): QwpInitialConnectMode {
  if (
    value !== QWP_INITIAL_CONNECT_MODE.OFF &&
    value !== QWP_INITIAL_CONNECT_MODE.SYNC &&
    value !== QWP_INITIAL_CONNECT_MODE.ASYNC
  ) {
    throw new RangeError(
      "store-and-forward initialConnectMode must be 'off', 'sync', or 'async'",
    );
  }
  return value;
}
