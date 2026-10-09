import type { QwpNegotiatedEgressCompression } from "./_core/compression";
import type { QwpServerInfoMessage } from "./_core/egress";
import { redactQwpEndpoint } from "./_internal/redact-endpoint";

export interface QwpConnectionCloseInfo {
  code: number;
  reason: string;
  wasClean: boolean;
}

/** A failure while handing a QWP frame to the WebSocket transport. */
export class QwpSendError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "QwpSendError";
    this.cause = cause;
  }
}

/** The WebSocket did not drain a QWP frame before its send deadline. */
export class QwpSendTimeoutError extends QwpSendError {
  constructor(
    readonly timeoutMs: number,
    readonly bufferedAmountBytes?: number,
  ) {
    super(
      `QWP WebSocket send timed out after ${timeoutMs}ms; delivery outcome is unknown${
        bufferedAmountBytes === undefined
          ? ""
          : ` [bufferedAmount=${bufferedAmountBytes}]`
      }`,
    );
    this.name = "QwpSendTimeoutError";
  }
}

/** A QWP send was rejected because its WebSocket closed. */
export class QwpSendClosedError extends QwpSendError {
  constructor(readonly closeInfo?: QwpConnectionCloseInfo) {
    super(
      closeInfo
        ? `QWP WebSocket closed while sending [code=${closeInfo.code}, reason=${closeInfo.reason}]`
        : "QWP WebSocket is not open",
    );
    this.name = "QwpSendClosedError";
  }
}

/** One frame can never fit in the configured in-memory replay budget. */
export class QwpMemoryReplayFrameTooLargeError extends RangeError {
  constructor(
    readonly maxBytes: number,
    readonly payloadBytes: number,
    readonly requiredBytes: number,
  ) {
    super(
      `QWP frame exceeds the in-memory replay budget [maxBytes=${maxBytes}, payloadBytes=${payloadBytes}, requiredBytes=${requiredBytes}]`,
    );
    this.name = "QwpMemoryReplayFrameTooLargeError";
  }
}

/** One logical batch can never fit in the configured in-memory replay budget. */
export class QwpMemoryReplayBatchTooLargeError extends RangeError {
  constructor(
    readonly maxBytes: number,
    readonly frameCount: number,
    readonly requiredBytes: number,
  ) {
    super(
      `QWP logical batch exceeds the in-memory replay budget [maxBytes=${maxBytes}, frameCount=${frameCount}, requiredBytes=${requiredBytes}]`,
    );
    this.name = "QwpMemoryReplayBatchTooLargeError";
  }
}

/** ACK-driven trimming did not free in-memory replay capacity in time. */
export class QwpMemoryReplayAppendTimeoutError extends Error {
  constructor(
    readonly maxBytes: number,
    readonly usedBytes: number,
    readonly requiredBytes: number,
    readonly timeoutMs: number,
  ) {
    super(
      `QWP in-memory replay append remained backpressured for ${timeoutMs} ms [maxBytes=${maxBytes}, usedBytes=${usedBytes}, requiredBytes=${requiredBytes}]`,
    );
    this.name = "QwpMemoryReplayAppendTimeoutError";
  }
}

export interface QwpFailoverAttempt {
  readonly endpoint: string | URL;
  readonly error: unknown;
}

/** Every eligible QWP endpoint in one connection sweep failed. */
export class QwpFailoverError extends Error {
  readonly attempts: readonly QwpFailoverAttempt[];
  readonly cause?: unknown;

  constructor(attempts: readonly QwpFailoverAttempt[]) {
    // Redact before the endpoints are stored, not only before they are
    // formatted: `attempts` is public, and serialising it is as ordinary a way
    // to log a connect failure as printing the message.
    const redacted = attempts.map((attempt) => ({
      endpoint: redactQwpEndpoint(attempt.endpoint),
      error: attempt.error,
    }));
    const last = redacted[redacted.length - 1];
    super(
      `all QWP endpoints failed [count=${redacted.length}]${
        last ? `; last endpoint=${last.endpoint}` : ""
      }`,
    );
    this.name = "QwpFailoverError";
    this.attempts = redacted;
    this.cause = last?.error;
  }
}

/**
 * A QWP reconnect budget ran out: a synchronous ingress initial connect
 * reached reconnectMaxDurationMs, or an egress failover episode reached
 * failoverMaxAttempts or failoverMaxDurationMs. A connected ingress session does not raise
 * it, because its reconnects are not bounded.
 */
export class QwpReconnectExhaustedError extends Error {
  readonly cause: unknown;

  constructor(
    readonly attempts: number,
    cause: unknown,
  ) {
    super(`QWP reconnect attempts exhausted [attempts=${attempts}]`);
    this.name = "QwpReconnectExhaustedError";
    this.cause = cause;
  }
}

/** A replayed ingress frame was rejected and remains in persistent storage. */
export class QwpReplayRejectedError extends Error {
  constructor(
    readonly frameSequence: bigint,
    readonly status: number,
    message?: string,
  ) {
    super(
      `QWP replay frame was rejected and retained [frameSequence=${frameSequence}, status=0x${status.toString(16)}]${
        message ? `: ${message}` : ""
      }`,
    );
    this.name = "QwpReplayRejectedError";
  }
}

/** A replay store cannot preserve the dictionary required by delta frames. */
export class QwpReplayDictionaryError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "QwpReplayDictionaryError";
    this.cause = cause;
  }
}

/**
 * Recovered delta frames depend on symbol IDs that neither the durable
 * dictionary prefix nor the surviving frames can reconstruct.
 */
export class QwpUnrecoverableReplayDictionaryError extends QwpReplayDictionaryError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "QwpUnrecoverableReplayDictionaryError";
  }
}

/**
 * A replay dictionary sidecar rejected an append before its delta frame was
 * published. The reconnecting transport has permanently switched to full,
 * self-contained symbol encoding; retrying the logical batch is safe.
 */
export class QwpReplayDictionaryPersistenceError extends QwpReplayDictionaryError {
  constructor(cause: unknown) {
    super(
      "failed to persist the QWP symbol dictionary before publication; delta dictionaries are disabled for this connection -- retry the batch",
      cause,
    );
    this.name = "QwpReplayDictionaryPersistenceError";
  }
}

/**
 * @deprecated Standard egress sessions now reset and replay automatically.
 * Retained for source compatibility with clients that classified the former
 * explicit-replay opt-in failure.
 */
export class QwpEgressReplayRequiredError extends Error {
  constructor(readonly requestId?: bigint) {
    super(
      `QWP egress connection was lost with an operation in flight${
        requestId === undefined ? "" : ` [requestId=${requestId}]`
      }; configure onReplayReset to opt into at-least-once re-execution`,
    );
    this.name = "QwpEgressReplayRequiredError";
  }
}

/**
 * The kinds of `reconnect.onEvent` notification. The first seven are the
 * connection events the Java, Rust, Go and Python clients share (Java's
 * `SenderConnectionEvent.Kind`), so a listener ported from one of them keeps
 * its meaning. The last three report store-and-forward conditions that only
 * this client puts on the same stream.
 */
export const QWP_RECONNECT_EVENT_KIND = {
  /** The session's first successful connection. */
  CONNECTED: "connected",
  /**
   * The active connection was lost. Fired once per outage, before the first
   * reconnect attempt.
   */
  DISCONNECTED: "disconnected",
  /** A reconnect succeeded against the endpoint that was active before. */
  RECONNECTED: "reconnected",
  /** A reconnect succeeded against a different endpoint than before. */
  FAILED_OVER: "failed-over",
  /**
   * One endpoint failed: it could not be opened, or it opened and then failed
   * before the session could use it, as when it refuses the replayed frames.
   * Fired as each endpoint fails, before the sweep moves on.
   */
  ENDPOINT_ATTEMPT_FAILED: "endpoint-attempt-failed",
  /**
   * A sweep tried every endpoint and none accepted the connection. Fired once
   * per failed sweep, after that sweep's `endpoint-attempt-failed` events, with
   * `endpoint` set to the last endpoint tried.
   */
  ALL_ENDPOINTS_UNREACHABLE: "all-endpoints-unreachable",
  /**
   * The server rejected the credentials with HTTP 401 or 403. A credential
   * applies to the whole cluster, so the sweep stops at that endpoint and no
   * `all-endpoints-unreachable` follows. Browsers report it only when the
   * `sessionBootstrap` request is rejected, because their WebSocket API hides
   * the upgrade status.
   */
  AUTH_FAILED: "auth-failed",
  /** An unbounded SF loop is waiting for durable-ACK-capable endpoints. */
  DURABLE_ACK_UNAVAILABLE: "durable-ack-unavailable",
  /** An orphan exhausted its consecutive durable-ACK mismatch budget. */
  DURABLE_ACK_PERSISTENT_FAILURE: "durable-ack-persistent-failure",
  /** Every reachable ingress endpoint is temporarily unable to be primary. */
  PRIMARY_UNAVAILABLE: "primary-unavailable",
} as const;

export type QwpReconnectEventKind =
  (typeof QWP_RECONNECT_EVENT_KIND)[keyof typeof QWP_RECONNECT_EVENT_KIND];

export interface QwpReconnectEvent {
  readonly kind: QwpReconnectEventKind;
  /** One-based reconnect sweep number; zero for lifecycle-only events. */
  readonly attempt: number;
  readonly timestampMs: number;
  /**
   * The endpoint the event concerns; for `all-endpoints-unreachable`, the last
   * endpoint the sweep tried.
   */
  readonly endpoint?: string | URL;
  readonly previousEndpoint?: string | URL;
  readonly cause?: unknown;
  /** Elapsed time in the current consecutive capability-gap episode. */
  readonly episodeMs?: number;
}

/**
 * Initial connection policy for an ingress reconnect session: the values of the
 * `initialConnectMode` ingress option, which browser and Node senders accept
 * with or without a store-and-forward journal. The `initial_connect_retry`
 * connect-string key selects the same modes.
 */
export const QWP_INITIAL_CONNECT_MODE = {
  /** Try once on the caller and fail immediately. */
  OFF: "off",
  /** Retry on the caller until reconnectMaxDurationMs elapses. */
  SYNC: "sync",
  /** Return immediately and connect on the background replay loop. */
  ASYNC: "async",
} as const;

export type QwpInitialConnectMode =
  (typeof QWP_INITIAL_CONNECT_MODE)[keyof typeof QWP_INITIAL_CONNECT_MODE];

/**
 * Ingress reconnect and replay policy: the `reconnect` option of an ingress
 * session.
 *
 * As in the Java, Rust and Python clients, a session that has connected is
 * not stopped by any configured limit. Transport and endpoint failures are
 * retried until close(), and only a terminal error ends the session.
 * reconnectMaxDurationMs bounds a synchronous initial connect only.
 */
export interface QwpIngressReconnectOptions {
  /**
   * Full-jitter ceiling before the first failed connection sweep is retried.
   * Must not exceed 2_147_483_647ms. Defaults to 100ms.
   */
  reconnectInitialBackoffMs?: number;
  /**
   * Full-jitter exponential-backoff ceiling. Must not exceed 2_147_483_647ms.
   * Defaults to 5 seconds.
   */
  reconnectMaxBackoffMs?: number;
  /**
   * How long a synchronous initial connect keeps retrying before it fails
   * with QwpReconnectExhaustedError. Defaults to 5 minutes. Zero allows one
   * attempt and no retries, as in the Rust and Python clients; the attempt
   * itself is not cut short. Reconnects after the first connection do not
   * consult it, and neither does an initial connect that runs in the
   * background (initialConnectMode `"async"`, which Node's
   * `initial_connect_retry=async` and the pooled client's `lazy_connect` also
   * select): both retry until close() or a terminal error.
   */
  reconnectMaxDurationMs?: number;
  /**
   * Consecutive retriable rejections of one frame before it is treated as
   * poison and retained for inspection. Defaults to 4.
   */
  maxFrameRejections?: number;
  /**
   * Minimum time the same frame must remain suspect before repeated
   * rejections or non-orderly closes become terminal. Defaults to 5 seconds;
   * zero escalates as soon as maxFrameRejections is reached.
   */
  poisonMinEscalationWindowMs?: number;
  onEvent?: (event: QwpReconnectEvent) => void;
}

/**
 * Egress failover policy: the `reconnect` option of an egress session. Unlike
 * ingress, each failover episode is bounded, so a caller waiting for a query
 * result is not left waiting through a long outage.
 */
export interface QwpEgressReconnectOptions {
  /**
   * Maximum connection sweeps per failover episode; zero is unlimited.
   * Defaults to 8.
   */
  failoverMaxAttempts?: number;
  /**
   * Full-jitter ceiling before the first failed connection sweep is retried.
   * Must not exceed 2_147_483_647ms. Defaults to 50ms.
   */
  failoverBackoffInitialMs?: number;
  /**
   * Full-jitter exponential-backoff ceiling. Must not exceed 2_147_483_647ms.
   * Defaults to 1 second.
   */
  failoverBackoffMaxMs?: number;
  /**
   * Deadline for one failover episode; zero disables it. Defaults to 30
   * seconds.
   */
  failoverMaxDurationMs?: number;
  onEvent?: (event: QwpReconnectEvent) => void;
}

export interface QwpEgressReplayResetEvent {
  /** Client request being re-executed on the replacement connection. */
  readonly requestId: bigint;
  /** Authoritative SERVER_INFO received from the replacement endpoint. */
  readonly serverInfo: QwpServerInfoMessage;
  readonly previousEndpoint?: string | URL;
  readonly endpoint?: string | URL;
  readonly cause?: unknown;
}

export const QWP_UPGRADE_ERROR_KIND = {
  AUTHENTICATION: "authentication",
  ROLE_REJECTED: "role-rejected",
  HTTP_REJECTED: "http-rejected",
  VERSION_MISMATCH: "version-mismatch",
  CAPABILITY_MISMATCH: "capability-mismatch",
  TIMEOUT: "timeout",
  TRANSPORT: "transport",
  /** Browser WebSocket APIs do not expose the rejected HTTP upgrade. */
  OPAQUE: "opaque",
} as const;

export type QwpUpgradeErrorKind =
  (typeof QWP_UPGRADE_ERROR_KIND)[keyof typeof QWP_UPGRADE_ERROR_KIND];

export const QWP_UPGRADE_TIMEOUT_PHASE = {
  CONNECT: "connect",
  AUTHENTICATION: "authentication",
} as const;

/** Opening phase whose Node QWP deadline expired. */
export type QwpUpgradeTimeoutPhase =
  (typeof QWP_UPGRADE_TIMEOUT_PHASE)[keyof typeof QWP_UPGRADE_TIMEOUT_PHASE];

export interface QwpUpgradeErrorDetails {
  kind: QwpUpgradeErrorKind;
  /** Whether a later retry against the configured endpoint set may recover. */
  retryable?: boolean;
  /** Whether failover code should try another endpoint before surfacing this. */
  tryNextEndpoint?: boolean;
  url?: string | URL;
  statusCode?: number;
  statusMessage?: string;
  serverRole?: string;
  serverZone?: string;
  closeCode?: number;
  timeoutPhase?: QwpUpgradeTimeoutPhase;
  cause?: unknown;
}

export const QWP_TARGET = {
  ANY: "any",
  PRIMARY: "primary",
  REPLICA: "replica",
} as const;

/** Server role a query session accepts. Defaults to `any`. */
export type QwpTarget = (typeof QWP_TARGET)[keyof typeof QWP_TARGET];

/**
 * Browser-safe endpoint routing preferences for query sessions.
 *
 * Ingress takes none. QuestDB accepts writes on the primary alone: a replica,
 * or a primary still catching up, answers the `/write/v4` upgrade with 421
 * and the role it holds, and the endpoint sweep moves on, so a sender reaches
 * the primary whatever role or zone it could ask for.
 */
export interface QwpRoutingOptions {
  /** Selects any readable node, a primary/standalone node, or a replica. */
  target?: QwpTarget;
  /** Opaque, case-insensitive preferred zone; cross-zone fallback stays enabled. */
  zone?: string;
}

/** A failure while establishing or validating a QWP WebSocket upgrade. */
export class QwpUpgradeError extends Error {
  readonly kind: QwpUpgradeErrorKind;
  readonly retryable?: boolean;
  readonly tryNextEndpoint?: boolean;
  readonly url?: string | URL;
  readonly statusCode?: number;
  readonly statusMessage?: string;
  readonly serverRole?: string;
  readonly serverZone?: string;
  readonly closeCode?: number;
  /** Node opening phase that exceeded its deadline. */
  readonly timeoutPhase?: QwpUpgradeTimeoutPhase;
  readonly cause?: unknown;

  constructor(message: string, details: QwpUpgradeErrorDetails) {
    super(message);
    this.name = "QwpUpgradeError";
    this.kind = details.kind;
    this.retryable = details.retryable;
    this.tryNextEndpoint = details.tryNextEndpoint;
    // See redactQwpEndpoint(): this field is the one an upgrade failure most
    // often gets logged through.
    this.url =
      details.url === undefined ? undefined : redactQwpEndpoint(details.url);
    this.statusCode = details.statusCode;
    this.statusMessage = details.statusMessage;
    this.serverRole = details.serverRole;
    this.serverZone = details.serverZone;
    this.closeCode = details.closeCode;
    this.timeoutPhase = details.timeoutPhase;
    this.cause = details.cause;
  }

  /** True for a 421 response from a read-only replica. */
  get isTopologicalRoleReject(): boolean {
    return (
      this.kind === QWP_UPGRADE_ERROR_KIND.ROLE_REJECTED &&
      this.serverRole?.toUpperCase() === "REPLICA"
    );
  }

  /** True for a 421 response from a primary still completing catch-up. */
  get isTransientRoleReject(): boolean {
    return (
      this.kind === QWP_UPGRADE_ERROR_KIND.ROLE_REJECTED &&
      this.serverRole?.toUpperCase() === "PRIMARY_CATCHUP"
    );
  }
}

/** A connected endpoint advertised a role that does not satisfy `target`. */
export class QwpRoleMismatchError extends QwpUpgradeError {
  constructor(
    readonly target: QwpTarget,
    serverRole: string | undefined,
    url?: string | URL,
    serverZone?: string,
  ) {
    super(
      `QWP endpoint role does not match target [target=${target}, role=${serverRole ?? "unknown"}]`,
      {
        kind: QWP_UPGRADE_ERROR_KIND.ROLE_REJECTED,
        retryable: true,
        tryNextEndpoint: true,
        url,
        serverRole,
        serverZone,
      },
    );
    this.name = "QwpRoleMismatchError";
  }
}

/** A requested durable-ACK capability was not confirmed by the server. */
export class QwpDurableAckUnavailableError extends QwpUpgradeError {
  constructor(url: string | URL) {
    // No `readonly url` parameter property here: TypeScript emits that
    // assignment after super(), which would overwrite the base's redacted
    // value with the raw endpoint. The message has to be redacted separately,
    // since it is built before the base constructor runs.
    super(
      `QWP durable ACK was requested, but the server did not advertise support [url=${redactQwpEndpoint(url)}]`,
      {
        kind: QWP_UPGRADE_ERROR_KIND.CAPABILITY_MISMATCH,
        retryable: false,
        tryNextEndpoint: true,
        url,
      },
    );
    this.name = "QwpDurableAckUnavailableError";
  }
}

/** Metadata negotiated during the QWP WebSocket upgrade. */
export interface QwpHandshakeMetadata {
  /** QWP protocol version selected by the server. */
  readonly qwpVersion: number;
  /** Server's hard ingress WebSocket-payload cap, when advertised. */
  readonly maxBatchSizeBytes?: number;
  /** Server-selected egress content encoding, when advertised. */
  readonly contentEncoding?: string;
  /** Parsed effective egress codec and level selected by the server. */
  readonly negotiatedCompression?: QwpNegotiatedEgressCompression;
  /** Whether the server confirmed durable-ACK support. */
  readonly durableAckEnabled?: boolean;
  /** Server role advertised on a successful upgrade, when available. */
  readonly serverRole?: string;
  /** Server zone advertised on a successful upgrade, when available. */
  readonly serverZone?: string;
}
