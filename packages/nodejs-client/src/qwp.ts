/**
 * Node.js WebSocket, UDP and store-and-forward adapter over the shared QWP
 * protocol/session APIs. The package root (index.ts) re-exports its public
 * names; connectQwpNodeIngress() is exported for the senders and tests, and
 * connectQwpNodeWebSocket() for tests only.
 */
export * from "../../client-core/src/qwp";

import type { Agent } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import WebSocket from "ws";
import { log } from "./logging";
import { validateQwpWebSocketAgent } from "./qwp-node/websocket-agent";
import { orphanIngressSessionOptions } from "./qwp-node/orphan-session-options";
import {
  decodeQwpContentEncoding,
  encodeQwpAcceptEncoding,
  QWP_VERSION,
  type QwpEgressCompression,
} from "../../client-core/src/_qwp/_core";
import {
  openQwpWebSocket,
  QwpWebSocketConnectOptions,
  QwpWebSocketLike,
  qwpNonRetryable,
  validateQwpWebSocketTimeouts,
} from "../../client-core/src/_qwp/_internal/websocket-connection";
import {
  assertUniformQwpEndpointScheme,
  createQwpFailoverConnectionFactory,
  createQwpFailoverHealthTracker,
  QwpFailoverHealthTracker,
} from "../../client-core/src/_qwp/_internal/failover";
import { createQwpEgressFailoverConnectionFactory } from "../../client-core/src/_qwp/_internal/egress-routing";
import { validateQwpMaxBatchRows } from "../../client-core/src/_qwp/_internal/egress-limits";
import { selectsQwpSyncInitialConnect } from "../../client-core/src/_qwp/_internal/reconnecting-ingress-connection";
import { safelyInvoke } from "../../client-core/src/_qwp/_internal/safe-callback";
import {
  assertNoQwpIngressRouting,
  normalizeQwpNodeClientOptions,
  QWP_DEFAULT_SENDER_ID,
  resolveQwpNodeClientConfig,
  resolveQwpNodeClientSides,
} from "./qwp-node/client-config";
import {
  QWP_INITIAL_CONNECT_MODE,
  QWP_UPGRADE_ERROR_KIND,
  QwpDurableAckUnavailableError,
  QwpHandshakeMetadata,
  QwpRoutingOptions,
  QwpSendClosedError,
  QwpUnrecoverableReplayDictionaryError,
  QwpUpgradeError,
} from "../../client-core/src/_qwp/transport";
import type {
  QwpBinaryConnection,
  QwpConnectionFactory,
} from "../../client-core/src/_qwp/_internal/binary-connection";
import {
  connectQwpEgressSession,
  QWP_DEFAULT_EGRESS_SERVER_INFO_TIMEOUT_MS,
  type QwpEgressSession,
  type QwpEgressSessionOptions,
} from "../../client-core/src/_qwp/egress-session";
import {
  QwpIngressSession,
  QwpIngressSessionOptions,
  resolveQwpDurableAckKeepaliveMs,
  type QwpIngressSessionInternalOptions,
} from "../../client-core/src/_qwp/ingress-session";
import {
  createQwpDataLossSenderError,
  defaultQwpSenderErrorHandler,
  type QwpSenderError,
} from "../../client-core/src/_qwp/sender-error";
import {
  createQwpSender,
  type QwpSender,
  type QwpSenderOptions,
} from "../../client-core/src/_qwp/sender";
import {
  QwpClient,
  QwpClientPoolOptions,
  type QwpPoolSlotReservation,
} from "../../client-core/src/_qwp/client";
import {
  formatQwpNodeReplayDataLoss,
  quarantineQwpNodeReplayStore,
  QwpNodeFileReplayStore,
  QwpReplayStoreCorruptionError,
  QwpReplayStoreQuarantinedError,
  QWP_SF_DEFAULTS,
} from "./qwp-node/file-replay-store";
import type {
  QwpNodeReplayDataLossReport,
  QwpSfBackpressurePolicy,
  QwpSfDurability,
} from "./qwp-node/file-replay-store";
import {
  QwpNodeOrphanDrainer,
  type QwpNodeOrphanDrainEvent,
} from "./qwp-node/orphan-drainer";
import {
  QwpNodeUdpSession,
  type QwpNodeUdpOptions,
} from "./qwp-node/udp-sender";

// The journal itself stays internal, as the replay store contract it implements
// does: store-and-forward is configured through QwpNodeStoreAndForwardOptions,
// and only what reaches a caller through it -- its policies, errors and
// data-loss reports -- is public.
export {
  QWP_SF_BACKPRESSURE_POLICY,
  QWP_SF_DURABILITY,
  QwpReplayStoreAppendTimeoutError,
  QwpReplayStoreBatchTooLargeError,
  QwpReplayStoreCheckpointError,
  QwpReplayStoreCorruptionError,
  QwpReplayStoreError,
  QwpReplayStoreFullError,
  QwpReplayStoreLockedError,
  QwpReplayStoreLockLostError,
  QwpReplayStoreLockUnprovableError,
  QwpReplayStoreQuarantinedError,
  QwpReplayStoreSegmentTooLargeError,
} from "./qwp-node/file-replay-store";
export type {
  QwpNodeReplayDataLossReport,
  QwpSfBackpressurePolicy,
  QwpSfDurability,
} from "./qwp-node/file-replay-store";
// The orphan drainer, its slot scanner and the UDP session stay internal, as in
// the other QuestDB clients: orphan recovery is configured through
// QwpNodeStoreAndForwardOptions and observed through onOrphanDrainEvent, and UDP
// ingress publishes through a sender.
export {
  QWP_ORPHAN_DRAIN_EVENT_KIND,
  QWP_ORPHAN_FAILED_SENTINEL,
  retryQwpNodeOrphanSlot,
} from "./qwp-node/orphan-drainer";
export { QwpUdpDatagramTooLargeError } from "./qwp-node/udp-sender";
export type {
  QwpNodeUdpOptions,
  QwpNodeUdpSocketLike,
} from "./qwp-node/udp-sender";
export type {
  QwpNodeOrphanDrainEvent,
  QwpNodeOrphanDrainEventKind,
  QwpNodeOrphanDrainerMetrics,
} from "./qwp-node/orphan-drainer";

export type { QwpWebSocketLike } from "../../client-core/src/_qwp/_internal/websocket-connection";

/**
 * Default `X-QWP-Client-Id`, which QuestDB records in server-side diagnostics.
 *
 * Kept in step with `packages/nodejs-client/package.json` by
 * `test/qwp/node-transport.test.ts`, rather than imported: a JSON import would
 * reach the bundled output, and the manifest is not part of the module graph.
 * Deliberately not exported -- the version is observable on the wire, which is
 * where the test pins it, so this need not become public API.
 */
const QWP_NODE_DEFAULT_CLIENT_ID = "typescript/5.0.0";

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
      // A 5xx or a 429 is what a proxy, a load balancer, or a rolling restart
      // answers with while a backend is coming back, so it must not end the
      // reconnect loop: connectLoop rethrows a non-retryable error without
      // retrying it, which latches the sender terminal on the first blip. This matches the browser bootstrap
      // (`statusCode >= 500`) and the ILP HTTP transport's retriable set.
      // 401/403 stay terminal, and a 4xx other than 429 is a client-side
      // mistake that byte-identical replay cannot fix.
      retryable: statusCode === 421 || statusCode === 429 || statusCode >= 500,
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

/**
 * Node WebSocket connection settings: endpoints, upgrade headers, the TLS
 * agent, authentication and opening deadlines. A pooled client's `cluster`
 * takes these, and the ingress and egress options extend them.
 */
export interface QwpNodeWebSocketOptions extends QwpWebSocketConnectOptions {
  headers?: Record<string, string>;
  /** Optional HTTP(S) agent used for the WebSocket upgrade. */
  agent?: Agent;
  /**
   * Time allowed after TCP/TLS connection for HTTP authentication and the
   * WebSocket upgrade.
   *
   * Defaults to `connectTimeoutMs` when that is set, and to 15s otherwise, so
   * narrowing only the connect deadline bounds the whole opening rather than
   * being exceeded by a default nobody chose. Set this to give the slower
   * phase its own budget. Capped at 2,147,483,647ms (the host timer ceiling);
   * a larger value throws a `RangeError`.
   */
  authTimeoutMs?: number;
  authorization?: string;
  clientId?: string;
  maxVersion?: number;
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

/**
 * Everything a Node QWP WebSocket sender takes: the connection, row buffering
 * and flushing, and delivery -- acknowledgement, reconnect and replay, kept in
 * memory or, with `storeAndForward`, in a crash-safe journal.
 *
 * There is no `target` or `zone`. Only the primary accepts writes, and the
 * endpoint sweep reaches it through the 421 each replica answers the upgrade
 * with; both route query sessions, on {@link QwpNodeEgressOptions}.
 */
export interface QwpNodeIngressOptions
  extends QwpNodeWebSocketOptions,
    QwpSenderOptions,
    QwpIngressSessionOptions {
  /**
   * Requests durable ACKs on the `/write/v4` upgrade; connecting fails with
   * QwpDurableAckUnavailableError when the server does not confirm them.
   * durableAckKeepaliveMs takes effect only alongside it.
   */
  requestDurableAck?: boolean;
  /**
   * Upgrades the default in-memory ingress replay to persistent Node
   * store-and-forward, journalled in this sender's `senderId` slot below the
   * configured directory. No two live senders may share a slot.
   */
  storeAndForward?: QwpNodeStoreAndForwardOptions;
  /**
   * Names this sender's journal slot below `storeAndForward.directory`, the
   * slot root: the journal is `<directory>/<senderId>`, and a pooled client's
   * are `<directory>/<senderId>-<slot>`. Defaults to `default`, as the
   * `sender_id` key does. Letters, digits, underscores and hyphens only; it is
   * not sent to the server.
   */
  senderId?: string;
}

/** Notification that an unreplayable foreground slot was preserved aside. */
export interface QwpNodeReplayRecoveryEvent {
  readonly timestampMs: number;
  readonly directory: string;
  readonly quarantineDirectory: string;
  readonly error: QwpReplayStoreQuarantinedError;
  readonly senderError: QwpSenderError;
}

/**
 * Node store-and-forward: a crash-safe journal that keeps each frame on disk
 * until the server acknowledges it, and the recovery of journals that
 * terminated producers left behind.
 */
export interface QwpNodeStoreAndForwardOptions {
  /**
   * The slot root. Each sender journals into its own slot below it:
   * `<directory>/<senderId>`, with `senderId` defaulting to `default`, or
   * `<directory>/<senderId>-<slot>` for a pooled sender. This is the layout
   * `sf_dir` and `sender_id` describe in a connect string.
   */
  directory: string;
  /**
   * Target maximum journal size including fixed segment reservations and
   * symbol metadata. Defaults to 10 GiB. The current symbol dictionary may
   * exceed this target so it cannot consume the journal's live frame budget
   * before a drained close retires that dictionary generation.
   *
   * A commit whose deferred prefix already fills the journal also overshoots
   * it, because QuestDB withholds that prefix's ACK until the commit arrives,
   * so no amount of trimming could make room first. For fixed segment size S,
   * reservations are capped at S * (floor(maxBytes / S) + max(floor(maxBytes / S),
   * ceil(min(maxBytes, 32 MiB) / S))), saturated at Number.MAX_SAFE_INTEGER. The
   * closing batch must fit the applicable standalone rounded segment allowance
   * on its own. The retained dictionary is additive; beyond the cap appends
   * backpressure. When S divides maxBytes exactly, this segment cap is 2 *
   * maxBytes.
   *
   * Must reserve at least one whole segment -- `maxSegmentBytes + 32` for the
   * 24-byte SFA header and the 8-byte frame header. A smaller target throws a
   * `RangeError`, because no append could ever reserve its first segment and
   * no acknowledgement could ever free room for one.
   */
  maxBytes?: number;
  /**
   * Maximum QWP frame payload and target segment data size. Each fixed segment
   * reserves this value plus one record header and its 24-byte SFA header,
   * so a maximum-sized frame still fits. Defaults to 4 MiB. `maxBytes` must
   * leave room for one whole segment of this size plus those 32 bytes of
   * headers.
   */
  maxSegmentBytes?: number;
  /**
   * Local persistence barrier. `append` fsyncs every frame before its append
   * resolves, `periodic` checkpoints dirty files in the background, and
   * `memory` relies on OS page-cache writeback, which normally survives a
   * process failure but makes no power-loss promise. Defaults to `memory`, as
   * `sf_durability` does; choose `append` for a journal that has to survive
   * power loss.
   */
  durability?: QwpSfDurability;
  /** Periodic durability checkpoint cadence. Defaults to 5 seconds. */
  checkpointIntervalMs?: number;
  /**
   * Behavior when maxBytes is exhausted. `wait` pauses the append until ACK
   * trimming frees space or its deadline expires; `error` fails it at once
   * with QwpReplayStoreFullError. Defaults to `wait`, as a connect string does.
   *
   * This decides journal exhaustion only. A transient retryable fault parks
   * until {@link appendDeadlineMs} under either policy, so the only errors an
   * append surfaces are exhaustion and that deadline.
   */
  backpressurePolicy?: QwpSfBackpressurePolicy;
  /** Per-append capacity or retryable store-fault deadline. Defaults to 30 seconds. */
  appendDeadlineMs?: number;
  /**
   * Reports journal bytes abandoned during recovery. Defaults to logging at
   * error level; recovery still succeeds, so this must never be silent.
   */
  onRecoveryDataLoss?: (report: QwpNodeReplayDataLossReport) => void;
  /**
   * Minimum time an orphan slot's symbol catch-up cap gap must persist before
   * it is quarantined. The gap must also be observed 16 times. Defaults to
   * five minutes; zero uses the observation threshold alone.
   */
  catchUpCapGapMinEscalationWindowMs?: number;
  /**
   * Adopts sibling replay slots left by terminated producers. Standalone
   * senders default this to false; pooled clients always recover their own
   * idle in-range and out-of-range `<senderId>-N` slots.
   */
  drainOrphans?: boolean;
  /** Maximum sibling slots drained concurrently. Defaults to 4. */
  maxBackgroundDrainers?: number;
  /**
   * Periodic rescan cadence; zero disables the timer. Pooled ownership
   * changes can still trigger a scan. Defaults to 30 seconds. Capped at
   * 2,147,483,647ms (the host timer ceiling); a larger value throws a
   * `RangeError`.
   */
  orphanScanIntervalMs?: number;
  /**
   * Receives isolated scanner, drainer, durable-ACK capability-gap, and
   * primary-unavailable lifecycle notifications.
   */
  onOrphanDrainEvent?: (event: QwpNodeOrphanDrainEvent) => void;
  /**
   * Receives a data-loss notification when corrupt foreground replay bytes are
   * preserved under an `.unreplayable-N` pathname and a fresh slot is opened.
   */
  onRecoveryQuarantine?: (event: QwpNodeReplayRecoveryEvent) => void;
}

/**
 * Everything a Node QWP query session takes: the connection, endpoint
 * routing, result compression, and the session's flow control, deadlines and
 * failover.
 */
export interface QwpNodeEgressOptions
  extends QwpNodeWebSocketOptions,
    QwpRoutingOptions,
    QwpEgressSessionOptions {
  /**
   * Requests Zstd-compressed result batches. The default is `raw`, which
   * preserves compatibility with servers that predate QWP compression.
   * `auto` currently advertises the same ordered preference as `zstd`.
   */
  compression?: QwpEgressCompression;
  /**
   * Zstd level hint sent to the server. Must be between 1 and 22, and only
   * takes effect alongside `compression`; the default `raw` sends no
   * accept-encoding header for a level to travel on.
   */
  compressionLevel?: number;
  /**
   * Requests a server-side RESULT_BATCH row cap, and rejects a batch that
   * declares more rows: decoder scratch is sized from the declared row count
   * and retained for the session's lifetime.
   */
  maxBatchRows?: number;
}

/**
 * Node configuration for a combined pooled QWP ingress/egress client. One
 * endpoint list and authentication are shared, while side-specific options
 * remain explicit.
 */
export interface QwpNodeClientOptions {
  /**
   * Endpoints, authentication and the connection settings both sides share.
   * Each URL may be an origin, a reverse-proxy base path, or an existing
   * `/write/v4` or `/read/v1` endpoint; each side derives its own route.
   */
  cluster: QwpNodeWebSocketOptions;
  /**
   * The pooled senders' options. `url`, `failoverUrls` and `authorization`
   * belong to `cluster`; any other connection setting given here overrides
   * the cluster's for ingress only.
   */
  ingress?: Omit<
    QwpNodeIngressOptions,
    "url" | "failoverUrls" | "authorization"
  >;
  /** The query sessions' options, on the same terms as `ingress`. */
  egress?: Omit<QwpNodeEgressOptions, "url" | "failoverUrls" | "authorization">;
  pool?: QwpClientPoolOptions;
  /**
   * Coordinates a non-blocking startup: ingress connects in the background,
   * using memory replay when store-and-forward is absent, and the egress pool
   * remains cold until the first query. Conflicts with a positive queryPoolMin,
   * an ingress initialConnectMode other than `async`, or ingress
   * `reconnect: false`. This is the typed spelling of the `lazy_connect` key,
   * which, as in the Java, Rust and Python clients, only the pooled client
   * applies.
   */
  lazyConnect?: boolean;
}

/**
 * Typed overrides for a ws/wss cluster string, in the sections of
 * {@link QwpNodeClientOptions}. They take precedence after the complete string
 * has been validated; the endpoints themselves always come from `addr`.
 */
export interface QwpNodeClientConfigOptions {
  /** Connection overrides both sides share. */
  cluster?: Partial<Omit<QwpNodeWebSocketOptions, "url" | "failoverUrls">>;
  /** Ingress overrides; `storeAndForward` may supply or override `sf_dir`. */
  ingress?: Omit<
    QwpNodeIngressOptions,
    "url" | "failoverUrls" | "authorization"
  >;
  /** Egress overrides. */
  egress?: Omit<QwpNodeEgressOptions, "url" | "failoverUrls" | "authorization">;
  pool?: QwpClientPoolOptions;
  /** Overrides the `lazy_connect` key. */
  lazyConnect?: boolean;
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

/**
 * Opens one Node QWP WebSocket with the upgrade headers required by QuestDB,
 * walking `failoverUrls` as a session would. Set `requestDurableAck` only for
 * an ingress (`/write/v4`) endpoint.
 *
 * @internal A raw connection with no session over it. The package root does
 * not export it: the senders and connectQwpNodeEgress() open their own
 * connections. Tests use it to drive the upgrade directly.
 */
export function connectQwpNodeWebSocket(
  options: QwpNodeWebSocketOptions &
    Pick<QwpNodeIngressOptions, "requestDurableAck">,
): Promise<QwpBinaryConnection> {
  return createQwpNodeConnectionFactory(options)();
}

/** Creates a stateful Node endpoint walker suitable for session reconnects. */
function createQwpNodeConnectionFactory(
  options: QwpNodeWebSocketOptions &
    Pick<QwpNodeIngressOptions, "requestDurableAck">,
  healthTracker?: QwpFailoverHealthTracker,
  resetClassificationsAfterExhaustion = true,
): QwpConnectionFactory {
  return createQwpFailoverConnectionFactory(
    options.url,
    options.failoverUrls,
    (endpoint, signal) =>
      connectQwpNodeEndpoint(
        options,
        endpoint,
        signal,
        options.requestDurableAck === true,
      ),
    {
      // No target or zone. Only the primary accepts a write upgrade: a
      // replica, or a primary still catching up, answers 421 with its role,
      // which classifies and demotes that endpoint, so the sweep reaches the
      // primary on its own. A role filter could only refuse the endpoint the
      // sweep found, and zone affinity does not apply to a primary, which has
      // to be followed across zones -- the walker's own rule for
      // target=primary.
      healthTracker,
      resetClassificationsAfterExhaustion,
    },
  );
}

/**
 * Names the userinfo an endpoint carries, or undefined when it carries none.
 * An unparseable endpoint is left alone; `ws` rejects it on its own terms.
 */
function endpointUserinfo(endpoint: string | URL): string | undefined {
  let url: URL;
  try {
    url = typeof endpoint === "string" ? new URL(endpoint) : endpoint;
  } catch {
    return undefined;
  }
  if (url.password) return "a password";
  if (url.username) return "a username";
  return undefined;
}

function connectQwpNodeEndpoint(
  options: QwpNodeWebSocketOptions,
  endpoint: string | URL,
  signal: AbortSignal | undefined,
  // A parameter rather than an options field: the egress path passes false,
  // so no shared options object can ask /read/v1 for durable ACK.
  requestDurableAck: boolean,
): Promise<QwpBinaryConnection> {
  validateQwpWebSocketTimeouts(options);
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    // Node's URL TypeError retains the rejected input on an enumerable `input`
    // property. Returning it directly leaks malformed userinfo through error
    // serializers even though its message is generic. Replace it, without the
    // original as a cause, and classify the local configuration failure as
    // non-retryable.
    return Promise.reject(qwpNonRetryable(new TypeError("Invalid URL")));
  }
  const agent = validateQwpWebSocketAgent(
    options.agent,
    endpointUrl.protocol === "wss:",
  );
  const clientMaxVersion = options.maxVersion ?? QWP_VERSION;
  if (
    !Number.isSafeInteger(clientMaxVersion) ||
    clientMaxVersion < 1 ||
    clientMaxVersion > QWP_VERSION
  ) {
    return Promise.reject(
      qwpNonRetryable(
        new RangeError(
          `maxVersion must be an integer between 1 and ${QWP_VERSION}`,
        ),
      ),
    );
  }
  // `ws` turns userinfo into an Authorization: Basic header, so this is a live
  // credential the client never manages: it does not interact with
  // `authorization`, and it is not carried to a failover endpoint that has none.
  // It also ends up in QwpFailoverError's message and on QwpUpgradeError.url.
  // The connect-string parser already rejects the same shape, so accepting it
  // here was the outlier. Use `authorization`, or username/password/token.
  const userinfo = endpointUserinfo(endpoint);
  if (userinfo) {
    return Promise.reject(
      qwpNonRetryable(
        new Error(
          `QWP endpoint URLs must not carry ${userinfo}; pass credentials through the 'authorization' option, or username/password/token on a connect string`,
        ),
      ),
    );
  }
  const headers: Record<string, string> = {
    "X-QWP-Max-Version": String(clientMaxVersion),
    "X-QWP-Client-Id": options.clientId ?? QWP_NODE_DEFAULT_CLIENT_ID,
    ...options.headers,
  };
  // Resolving this quietly meant the caller's own Authorization header simply
  // never went on the wire. The typed `authorization` field conflicting with
  // connect-string credentials is rejected rather than resolved either way, and
  // the same conflict spelled through the headers escape hatch has to be too.
  const headerAuthorization = Object.keys(headers).find(
    (name) => name.toLowerCase() === "authorization",
  );
  if (options.authorization && headerAuthorization) {
    return Promise.reject(
      qwpNonRetryable(
        new Error(
          "an Authorization header cannot be combined with the 'authorization' option; set exactly one of them",
        ),
      ),
    );
  }
  if (options.authorization) headers.Authorization = options.authorization;
  if (requestDurableAck) {
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
  let socket: QwpWebSocketLike;
  try {
    socket = factory(endpoint, {
      protocols: options.protocols,
      agent,
      headers,
      onConnected: resolveConnected,
      onUpgrade: (receivedHeaders) => {
        upgradeHeaders = receivedHeaders;
      },
      onUpgradeRejected: (rejection) => {
        rejectOpening(classifyUpgradeRejection(endpoint, rejection));
      },
    });
  } catch (error) {
    // `ws` builds the whole upgrade request inside its constructor, and that
    // constructor performs no I/O: everything it can throw describes the
    // arguments, not the network. ERR_INVALID_PROTOCOL from https.request is
    // one such case -- Node's own agent check, which validateQwpWebSocketAgent
    // defers to for wss rather than testing the agent's class -- but it is not
    // the only one. ERR_INVALID_CHAR from a credential carrying a control
    // character is the common one: a token read with readFileSync keeps the
    // file's trailing newline, and the connect string rejects that by name
    // while this path did not.
    //
    // Marking the class rather than one code is what matters. The reconnect
    // classifier retries anything carrying no `retryable` flag, so a permanent
    // local fault was retried for the whole budget -- unbounded under
    // store-and-forward -- and then reported as an elapsed deadline naming
    // nothing, indistinguishable from an unreachable server. A network failure
    // cannot reach this catch, so nothing retryable is caught by widening it.
    return Promise.reject(
      error instanceof Error ? qwpNonRetryable(error) : error,
    );
  }
  return openQwpWebSocket(socket, {
    url: endpoint,
    signal,
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
      if (requestDurableAck && !durableAckEnabled) {
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

/**
 * Opens a Node WebSocket and starts an ingress ACK/NACK session.
 *
 * @internal The session factory behind createQwpNodeSender(). The package root
 * does not export it: applications publish through a sender, as in the Java,
 * Rust and Python clients.
 */
export async function connectQwpNodeIngress(
  options: QwpNodeIngressOptions,
  /** Cancels a first connect still negotiating; see QwpIngressSession.connect. */
  signal?: AbortSignal,
): Promise<QwpIngressSession> {
  return connectQwpNodeIngressInternal(options, true, undefined, signal);
}

/** Ingress options plus the session handoffs only this adapter sets. */
type QwpNodeIngressInternalOptions = QwpNodeIngressOptions &
  QwpIngressSessionInternalOptions;

async function connectQwpNodeIngressInternal(
  options: QwpNodeIngressInternalOptions,
  startOrphanDrainer: boolean,
  sharedHealthTracker?: QwpFailoverHealthTracker,
  signal?: AbortSignal,
): Promise<QwpIngressSession> {
  // Resolved first, so a malformed keepalive is rejected before any journal
  // work. Without requestDurableAck it is ignored, as in the Java and Rust
  // clients.
  const durableAckKeepaliveMs = resolveQwpDurableAckKeepaliveMs(
    options.requestDurableAck,
    options.durableAckKeepaliveMs,
  );
  const healthTracker =
    sharedHealthTracker ??
    createQwpFailoverHealthTracker(options.url, options.failoverUrls);
  const storeAndForward = resolveNodeStoreAndForwardOptions(options);
  if (storeAndForward && options.orphanStoreAndForward !== true) {
    await warnAboutUnreachableJournal(
      storeAndForwardRoot(options.storeAndForward!),
      storeAndForward.directory,
    );
  }
  if (storeAndForward && options.replayStore) {
    throw new RangeError(
      "storeAndForward and a custom replayStore cannot both be configured",
    );
  }
  // Recovery reports abandoned or quarantined journal bytes while the session
  // is still being built, so those onSenderError deliveries cannot pass
  // through the inbox the session owns. Counting them here and handing the
  // total to the session keeps deliveredErrorNotifications a true count of the
  // stream the caller observed; it read zero before, for exactly the data-loss
  // events the counter exists to surface.
  const recoveryDeliveries = { count: 0 };
  let replayStore = storeAndForward
    ? new QwpNodeFileReplayStore(
        withRecoveryDataLossReporter(
          storeAndForward,
          options.onSenderError,
          recoveryDeliveries,
        ),
      )
    : options.replayStore;
  const reconnect = storeAndForward
    ? (options.reconnect ?? {})
    : options.reconnect;
  // A journal always replays in the background, and left unset the connection
  // would pick `async` for that; the documented default is `off`, promoted to
  // `sync` by a tuned reconnect budget, as in the Java client.
  const initialConnectMode = storeAndForward
    ? (options.initialConnectMode ??
      (selectsQwpSyncInitialConnect(options.reconnect)
        ? QWP_INITIAL_CONNECT_MODE.SYNC
        : QWP_INITIAL_CONNECT_MODE.OFF))
    : options.initialConnectMode;
  const backgroundReplay =
    storeAndForward !== undefined ||
    options.backgroundStoreAndForward === true ||
    initialConnectMode === QWP_INITIAL_CONNECT_MODE.ASYNC;
  const storeBatchCap =
    storeAndForward?.maxSegmentBytes ??
    (storeAndForward ? QWP_SF_DEFAULTS.maxSegmentBytes : undefined);
  const effectiveSessionOptions: QwpIngressSessionInternalOptions = {
    ...options,
    reconnect,
    replayStore,
    backgroundStoreAndForward: backgroundReplay,
    initialConnectMode,
    maxBatchSizeBytes: minimumDefined(options.maxBatchSizeBytes, storeBatchCap),
    catchUpCapGapMinEscalationWindowMs:
      storeAndForward?.catchUpCapGapMinEscalationWindowMs,
    durableAckKeepaliveMs,
    priorSenderErrorDeliveries: () => recoveryDeliveries.count,
  };
  const orphanDrainer =
    startOrphanDrainer && storeAndForward?.drainOrphans === true
      ? createStandaloneOrphanDrainer(
          { ...options, storeAndForward },
          healthTracker,
        )
      : undefined;
  const connectionFactory = createQwpNodeConnectionFactory(
    options,
    healthTracker,
    startOrphanDrainer,
  );
  let session: QwpIngressSession;
  try {
    session = await QwpIngressSession.connect(
      connectionFactory,
      effectiveSessionOptions,
      signal,
    );
  } catch (error) {
    if (
      !storeAndForward ||
      options.orphanStoreAndForward === true ||
      !isQuarantinableReplayRecoveryError(error)
    ) {
      throw error;
    }
    // Retry the same directory once before giving up on it. A failed load
    // closes its store, and that close drains pending maintenance and drops a
    // watermark left stranded by a torn checkpoint -- so the very condition
    // that rejected the journal is usually repaired by the time we get here,
    // and the frames are intact. Quarantining on the first failure abandons
    // recoverable data.
    const retryStore = new QwpNodeFileReplayStore(
      withRecoveryDataLossReporter(
        storeAndForward,
        effectiveSessionOptions.onSenderError,
        recoveryDeliveries,
      ),
    );
    try {
      replayStore = retryStore;
      session = await QwpIngressSession.connect(
        connectionFactory,
        { ...effectiveSessionOptions, replayStore: retryStore },
        signal,
      );
    } catch (retryError) {
      // Only a second recovery failure proves the journal is unreadable.
      // Anything else -- a transport fault, an aborted connect -- says nothing
      // about it, so leave the directory alone and report it as-is.
      if (!isQuarantinableReplayRecoveryError(retryError)) throw retryError;
      const recoveryError = await quarantineQwpNodeReplayStore(
        storeAndForward.directory,
        retryError,
      );
      emitReplayRecoveryQuarantine(
        storeAndForward,
        recoveryError,
        effectiveSessionOptions.onSenderError,
        recoveryDeliveries,
      );
      replayStore = new QwpNodeFileReplayStore(
        withRecoveryDataLossReporter(
          storeAndForward,
          effectiveSessionOptions.onSenderError,
          recoveryDeliveries,
        ),
      );
      session = await QwpIngressSession.connect(
        connectionFactory,
        { ...effectiveSessionOptions, replayStore },
        signal,
      );
    }
  }
  if (orphanDrainer) {
    session.registerCloseHook(() => orphanDrainer.close());
    orphanDrainer.start();
  }
  return session;
}

/**
 * Routes abandoned journal bytes into the onSenderError stream. Recovery has
 * already succeeded by the time this runs, so it only reports; the caller's
 * own onRecoveryDataLoss wins when supplied.
 */
function withRecoveryDataLossReporter(
  options: QwpNodeStoreAndForwardOptions,
  onSenderError?: (error: QwpSenderError) => void,
  deliveries?: { count: number },
): QwpNodeStoreAndForwardOptions {
  if (options.onRecoveryDataLoss || !onSenderError) return options;
  return {
    ...options,
    onRecoveryDataLoss: (report: QwpNodeReplayDataLossReport) => {
      const senderError = createQwpDataLossSenderError(
        formatQwpNodeReplayDataLoss(report),
      );
      if (deliveries) deliveries.count++;
      // A rejected promise from an async onSenderError must fall back to the
      // default handler, exactly as a synchronous throw does.
      safelyInvoke(onSenderError, senderError, () =>
        defaultQwpSenderErrorHandler(senderError),
      );
    },
  };
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
  onSenderError?: (error: QwpSenderError) => void,
  deliveries?: { count: number },
): void {
  const senderError = createQwpDataLossSenderError(
    error.message,
    error.quarantineDirectory,
  );
  const event: QwpNodeReplayRecoveryEvent = {
    timestampMs: Date.now(),
    directory: error.directory,
    quarantineDirectory: error.quarantineDirectory,
    error,
    senderError,
  };
  if (!options.onRecoveryQuarantine && !onSenderError) {
    log("error", error);
    return;
  }
  let loggedFallback = false;
  const reportCallbackFailure = (): void => {
    if (loggedFallback) return;
    loggedFallback = true;
    // Recovery already succeeded. Notification callbacks must not brick the
    // fresh producer slot; fall back to the default logger instead. A failure
    // may surface asynchronously (a rejected promise), so log at most once.
    log("error", error);
  };
  safelyInvoke(options.onRecoveryQuarantine, event, reportCallbackFailure);
  if (onSenderError && deliveries) deliveries.count++;
  safelyInvoke(onSenderError, senderError, reportCallbackFailure);
}

/**
 * Creates a fluent Node QWP sender without opening the WebSocket yet.
 * Call connect(), or let the first flush connect lazily.
 */
export function createQwpNodeSender(options: QwpNodeIngressOptions): QwpSender {
  // This factory is lazy, so without a check here the failover factory's own
  // one would not run until the first connect. Routing is configuration, and
  // a mixed scheme decides which socket carries the credentials below, so it
  // belongs with the other construction-time rejections.
  assertUniformQwpEndpointScheme(options.url, options.failoverUrls);
  assertNoQwpIngressRouting(options, "", "set it on the egress options");
  return createQwpSender(
    (signal) => connectQwpNodeIngress(options, signal),
    options,
  );
}

/** Opens a Node QWP connection and returns a fluent sender. */
export async function connectQwpNodeSender(
  options: QwpNodeIngressOptions,
): Promise<QwpSender> {
  const sender = createQwpNodeSender(options);
  await sender.connect();
  return sender;
}

/**
 * Creates a fluent Node QWP-over-UDP sender without opening its socket yet.
 * UDP has no authentication, server ACK, durable ACK, transaction, retry, or
 * store-and-forward semantics.
 */
export function createQwpNodeUdpSender(options: QwpNodeUdpOptions): QwpSender {
  validateUdpSenderOptions(options);
  return createQwpSender(
    () => QwpNodeUdpSession.connect(options),
    {
      ...options,
      autoFlushBytes:
        options.autoFlushBytes ?? options.maxDatagramSize ?? 1_400,
      transactional: false,
      gorilla: false,
      symbolDictionary: "full",
    },
    { rejectZeroColumnRows: true },
  );
}

/** Opens a Node UDP socket and returns a fluent fire-and-forget QWP sender. */
export async function connectQwpNodeUdpSender(
  options: QwpNodeUdpOptions,
): Promise<QwpSender> {
  const sender = createQwpNodeUdpSender(options);
  await sender.connect();
  return sender;
}

function validateUdpSenderOptions(options: QwpNodeUdpOptions): void {
  // The type has no such field; this names the problem for a JavaScript
  // caller rather than silently sending without a transaction.
  if ((options as { transactional?: unknown }).transactional) {
    throw new RangeError("QWP UDP does not support transactions");
  }
}

/** Opens a Node WebSocket and waits for the egress SERVER_INFO handshake. */
export async function connectQwpNodeEgress(
  options: QwpNodeEgressOptions,
  /** Cancels an opening connection during pooled-client shutdown. */
  signal?: AbortSignal,
): Promise<QwpEgressSession> {
  const transport = egressTransportOptions(options);
  return connectQwpEgressSession(
    createQwpEgressFailoverConnectionFactory(
      transport.url,
      transport.failoverUrls,
      (endpoint, signal) =>
        connectQwpNodeEndpoint(transport, endpoint, signal, false),
      { target: options.target, zone: options.zone },
      options.serverInfoTimeoutMs ?? QWP_DEFAULT_EGRESS_SERVER_INFO_TIMEOUT_MS,
    ),
    // One maxBatchRows is both the cap this client requests on the wire and
    // the bound the session enforces on the answer; without it a peer's
    // declared row count sizes the decoder scratch on its own.
    options,
    signal,
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
  const { ingress, egress } = resolveQwpNodeClientSides(options);
  const slotCoordinator = createPooledSlotCoordinator(ingress, options.pool);
  const orphanDrainer = createPooledOrphanDrainer(
    ingress,
    options.pool,
    slotCoordinator,
  );
  let unsubscribeRecoveryScan: (() => void) | undefined;
  return new QwpClient(
    {
      createSender: async (slot, signal) => {
        const sender = createQwpNodeSender(
          pooledNodeIngressOptions(ingress, slot),
        );
        const abortOpening = (): void => {
          void sender.close().catch(() => undefined);
        };
        try {
          if (signal?.aborted) throw new QwpSendClosedError();
          signal?.addEventListener("abort", abortOpening, { once: true });
          await sender.connect();
          if (signal?.aborted) throw new QwpSendClosedError();
          return sender;
        } catch (error) {
          await sender.close().catch(() => undefined);
          throw error;
        } finally {
          signal?.removeEventListener("abort", abortOpening);
        }
      },
      createQuerySession: (_slot, signal) =>
        connectQwpNodeEgress(egress, signal),
      senderSlotReservation: slotCoordinator,
      start: async () => {
        if (orphanDrainer && slotCoordinator) {
          unsubscribeRecoveryScan = slotCoordinator.onAvailable(() =>
            orphanDrainer.scanNow(),
          );
        }
        orphanDrainer?.start();
        if (ingress.storeAndForward) {
          await warnAboutLegacyPooledSlots(
            storeAndForwardRoot(ingress.storeAndForward),
            validateQwpSenderId(ingress.senderId ?? QWP_DEFAULT_SENDER_ID),
            ingress.storeAndForward.drainOrphans,
          );
        }
      },
      close: async () => {
        unsubscribeRecoveryScan?.();
        unsubscribeRecoveryScan = undefined;
        await orphanDrainer?.close();
      },
    },
    options.pool,
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
  try {
    await client.connect();
  } catch (error) {
    // connect() starts the background factories -- the orphan drainer and the
    // pool housekeeper -- before it prewarms, and a failed prewarm
    // deliberately leaves the client open so createQwpNodeClient() callers can
    // retry connect() on the handle they still hold. This helper never hands
    // that handle back, so nobody could stop what it started: the drainer went
    // on adopting sibling replay slots, holding their advisory locks for the
    // life of the process, and its unref-free drain loop kept the process
    // alive. Every retry leaked another one.
    await client.close().catch(() => undefined);
    throw error;
  }
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

function pooledNodeIngressOptions(
  options: QwpNodeIngressOptions,
  slot: number,
): QwpNodeIngressOptions {
  if (!options.storeAndForward) return options;
  return {
    ...options,
    // Each pooled sender journals into its own slot of the configured root.
    senderId: `${validateQwpSenderId(options.senderId ?? QWP_DEFAULT_SENDER_ID)}-${slot}`,
    storeAndForward: {
      ...options.storeAndForward,
      // The client-level drainer owns sibling adoption. Per-sender scanners
      // would contend with other managed pool slots during prewarm/borrows.
      drainOrphans: false,
    },
  };
}

function createStandaloneOrphanDrainer(
  options: QwpNodeIngressOptions,
  healthTracker: QwpFailoverHealthTracker,
): QwpNodeOrphanDrainer {
  // The journal is always a slot below the configured directory, so the slots
  // scanned are that directory's: the store-and-forward group the caller
  // designated, and never the application directory holding it, which once
  // got unrelated neighbouring journals adopted, transmitted and emptied.
  const ownDirectory = storeAndForwardRoot(options.storeAndForward!);
  return createNodeOrphanDrainer(
    options,
    dirname(ownDirectory),
    (slotName) => slotName === basename(ownDirectory),
    healthTracker,
  );
}

function createPooledOrphanDrainer(
  // Recovery sessions are built from the same ingress options as the pooled
  // foreground senders, so an adopted slot negotiates the durable ACK its
  // producer requested: an ordinary OK must not advance the persisted
  // watermark for rows the caller asked to keep until they are durable.
  ingress: QwpNodeIngressOptions,
  pool: QwpClientPoolOptions | undefined,
  slotCoordinator?: QwpPooledSfaSlotCoordinator,
): QwpNodeOrphanDrainer | undefined {
  const storeAndForward = ingress.storeAndForward;
  if (!storeAndForward) return undefined;
  const rootDirectory = storeAndForwardRoot(storeAndForward);
  const managedSlotCount = pool?.senderPoolMax ?? 4;
  const senderId = validateQwpSenderId(
    ingress.senderId ?? QWP_DEFAULT_SENDER_ID,
  );
  const healthTracker = createQwpFailoverHealthTracker(
    ingress.url,
    ingress.failoverUrls,
  );
  return createNodeOrphanDrainer(
    ingress,
    rootDirectory,
    (slotName) => {
      const managedIndex = parseCanonicalSenderSlot(slotName, senderId);
      if (managedIndex !== undefined) {
        return (
          managedIndex < managedSlotCount &&
          slotCoordinator?.isForegroundReserved(managedIndex) === true
        );
      }
      // Same-base slots in and outside the current pool range are always
      // recovered. A caller must opt in before unrelated siblings are adopted.
      return storeAndForward.drainOrphans !== true;
    },
    healthTracker,
    slotCoordinator,
  );
}

function createNodeOrphanDrainer(
  options: QwpNodeIngressOptions,
  rootDirectory: string,
  excludeSlot: (slotName: string) => boolean,
  healthTracker: QwpFailoverHealthTracker,
  slotCoordinator?: QwpPooledSfaSlotCoordinator,
): QwpNodeOrphanDrainer {
  const storeAndForward = options.storeAndForward!;
  return new QwpNodeOrphanDrainer({
    rootDirectory,
    excludeSlot,
    tryReserveSlot: slotCoordinator
      ? (directory) => slotCoordinator.tryReserveRecovery(directory)
      : undefined,
    releaseSlot: slotCoordinator
      ? (directory) => slotCoordinator.releaseRecovery(directory)
      : undefined,
    maxConcurrent: storeAndForward.maxBackgroundDrainers,
    scanIntervalMs: storeAndForward.orphanScanIntervalMs,
    durableAckPollIntervalMs:
      resolveQwpDurableAckKeepaliveMs(
        options.requestDurableAck,
        options.durableAckKeepaliveMs,
      ) ?? 0,
    onEvent: storeAndForward.onOrphanDrainEvent,
    onSenderError: options.onSenderError,
    eventInboxCapacity: options.connectionListenerInboxCapacity,
    errorInboxCapacity: options.errorInboxCapacity,
    createSession: (directory, onReconnectEvent) =>
      connectQwpNodeIngressInternal(
        {
          ...orphanIngressSessionOptions(options, onReconnectEvent),
          senderId: undefined,
          storeAndForward: {
            ...storeAndForward,
            directory,
            drainOrphans: false,
          },
        },
        false,
        healthTracker,
      ),
  });
}

function createPooledSlotCoordinator(
  ingress: QwpNodeIngressOptions,
  pool: QwpClientPoolOptions | undefined,
): QwpPooledSfaSlotCoordinator | undefined {
  if (!ingress.storeAndForward) return undefined;
  return new QwpPooledSfaSlotCoordinator(
    validateQwpSenderId(ingress.senderId ?? QWP_DEFAULT_SENDER_ID),
    pool?.senderPoolMax ?? 4,
  );
}

/** Serializes foreground pool creation with recovery of its stable SFA slots. */
class QwpPooledSfaSlotCoordinator implements QwpPoolSlotReservation {
  private readonly foreground = new Set<number>();
  private readonly recovering = new Set<number>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly senderId: string,
    private readonly managedSlotCount: number,
  ) {}

  tryReserve(slot: number): boolean {
    if (this.foreground.has(slot) || this.recovering.has(slot)) return false;
    this.foreground.add(slot);
    return true;
  }

  release(slot: number): void {
    if (!this.foreground.delete(slot)) return;
    this.notifyAvailable();
  }

  onAvailable(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isForegroundReserved(slot: number): boolean {
    return this.foreground.has(slot);
  }

  tryReserveRecovery(directory: string): boolean {
    const slot = parseCanonicalSenderSlot(basename(directory), this.senderId);
    if (slot === undefined || slot >= this.managedSlotCount) return true;
    if (this.foreground.has(slot) || this.recovering.has(slot)) return false;
    this.recovering.add(slot);
    return true;
  }

  releaseRecovery(directory: string): void {
    const slot = parseCanonicalSenderSlot(basename(directory), this.senderId);
    if (
      slot === undefined ||
      slot >= this.managedSlotCount ||
      !this.recovering.delete(slot)
    ) {
      return;
    }
    this.notifyAvailable();
  }

  private notifyAvailable(): void {
    for (const listener of this.listeners) listener();
  }
}

function parseCanonicalSenderSlot(
  name: string,
  senderId: string,
): number | undefined {
  const escapedSenderId = senderId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escapedSenderId}-(0|[1-9]\\d*)$`).exec(name);
  if (!match) return undefined;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? index : undefined;
}

/**
 * Reads a store-and-forward slot root, naming the option when it is missing.
 *
 * `directory` is a required string on the options type, so only a JavaScript
 * caller can omit it -- and omitting it produced an unnamed
 * `TypeError: Cannot read properties of undefined (reading 'trim')` from
 * whichever of these call sites ran first, at connect time, while the empty
 * string had a diagnostic of its own a line below. The connect string cannot
 * reach this: without `sf_dir` there is no store-and-forward section at all.
 */
function storeAndForwardRoot(
  storeAndForward: QwpNodeStoreAndForwardOptions,
): string {
  if (typeof storeAndForward.directory !== "string") {
    throw new RangeError(
      `storeAndForward requires a 'directory' (sf_dir), received ${storeAndForward.directory === undefined ? "undefined" : typeof storeAndForward.directory}`,
    );
  }
  const rootDirectory = storeAndForward.directory.trim();
  if (!rootDirectory) {
    throw new RangeError("storeAndForward directory must not be empty");
  }
  return rootDirectory;
}

/**
 * The journal a session opens: the `senderId` slot below the configured root,
 * `default` unless named -- the layout a connect string's `sf_dir` and
 * `sender_id` describe, so the typed options and the string reach the same
 * journal. An adopted orphan is the one exception: its directory is the slot
 * the scanner found.
 */
function resolveNodeStoreAndForwardOptions(
  options: QwpNodeIngressInternalOptions,
): QwpNodeStoreAndForwardOptions | undefined {
  const storeAndForward = options.storeAndForward;
  if (!storeAndForward) return storeAndForward;
  // Validated for an orphan's directory too, so the diagnostic does not
  // depend on which session reads it.
  const rootDirectory = storeAndForwardRoot(storeAndForward);
  if (options.orphanStoreAndForward === true) return storeAndForward;
  return {
    ...storeAndForward,
    directory: join(
      rootDirectory,
      validateQwpSenderId(options.senderId ?? QWP_DEFAULT_SENDER_ID),
    ),
  };
}

/** Extension of a store-and-forward segment file, per QwpNodeFileReplayStore. */
const JOURNAL_SEGMENT_SUFFIX = ".sfa";

/**
 * Warns when the slot root itself holds journal segments.
 *
 * Every journal is a slot below the configured directory, so segments in the
 * directory itself belong to no slot: nothing replays them, the orphan
 * scanner cannot see them because it only inspects child directories, and no
 * error is raised. They are what a directory naming a slot rather than its
 * root leaves behind -- `sf_dir=/var/lib/qwp/default`, say, after an earlier
 * `sf_dir=/var/lib/qwp` journalled into that same `default` slot -- so the
 * unsent frames in it are not lost, only stranded. Say so instead.
 */
async function warnAboutUnreachableJournal(
  rootDirectory: string,
  journalDirectory: string,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(rootDirectory);
  } catch {
    return;
  }
  if (!entries.some((entry) => entry.endsWith(JOURNAL_SEGMENT_SUFFIX))) return;
  log(
    "warn",
    `QWP store-and-forward is using '${journalDirectory}', but its slot root '${rootDirectory}' holds journal segments that nothing will replay. ` +
      `The store-and-forward directory (sf_dir) is the slot root: each journal lives in <directory>/<senderId>, where senderId (sender_id) is 'default' unless set, or in <directory>/<senderId>-<slot> for a pooled sender.`,
  );
}

/** The slot name typed pooled clients used before senderId defaulted to `default`. */
const LEGACY_POOLED_SLOT_NAME = /^sender-(0|[1-9]\d*)$/;

/**
 * Warns when the slot root holds journals under the `sender-<slot>` names a
 * typed pooled client used before its senderId defaulted to `default`.
 *
 * The pool now journals into `<senderId>-<slot>`, and its drainer adopts only
 * those names unless drainOrphans is set, so such a backlog is neither
 * replayed nor reported. Like the slot-root warning, this only says so: the
 * frames are stranded, not lost, until the slots are renamed or drained once.
 */
async function warnAboutLegacyPooledSlots(
  rootDirectory: string,
  senderId: string,
  drainOrphans: boolean | undefined,
): Promise<void> {
  // A pool named `sender` still owns those slots, and drainOrphans adopts them.
  if (drainOrphans === true || senderId === "sender") return;
  let entries: Dirent[];
  try {
    entries = await readdir(rootDirectory, { withFileTypes: true });
  } catch {
    return;
  }
  const stranded: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !LEGACY_POOLED_SLOT_NAME.test(entry.name)) {
      continue;
    }
    let files: string[];
    try {
      files = await readdir(join(rootDirectory, entry.name));
    } catch {
      continue;
    }
    if (files.some((file) => file.endsWith(JOURNAL_SEGMENT_SUFFIX))) {
      stranded.push(entry.name);
    }
  }
  if (stranded.length === 0) return;
  stranded.sort();
  log(
    "warn",
    `QWP store-and-forward slot root '${rootDirectory}' holds journals in ${stranded.map((name) => `'${name}'`).join(", ")} that this pool will not replay. ` +
      `Pooled senders journal into <directory>/<senderId>-<slot>, here '${senderId}-<slot>'; earlier builds named a typed pool's slots 'sender-<slot>'. ` +
      `Rename each to '${senderId}-<slot>' while no client uses the directory, or set drainOrphans (drain_orphans=on) to replay them once.`,
  );
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
