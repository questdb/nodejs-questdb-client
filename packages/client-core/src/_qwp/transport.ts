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

export interface QwpIngressReplayRecord {
  readonly frameSequence: bigint;
  readonly payload: Uint8Array;
}

/** Lightweight durable-frame descriptor used by disk-backed replay stores. */
export interface QwpIngressReplayReference {
  readonly frameSequence: bigint;
  readonly payloadLength: number;
}

/** Browser-safe abstraction; Node supplies a persistent filesystem implementation. */
export interface QwpIngressReplayStore {
  load(): Promise<readonly QwpIngressReplayRecord[]>;
  /**
   * Opens and validates the journal without materializing every payload.
   * Implementations that provide this must also provide `readPayload`.
   */
  loadReferences?(): Promise<readonly QwpIngressReplayReference[]>;
  /** Reads one previously loaded durable payload on demand. */
  readPayload?(frameSequence: bigint): Promise<Uint8Array>;
  /**
   * @internal Waits until every payload in one logical batch can be appended
   * without an ACK between frames. Implementations must not mutate the journal.
   */
  prepareAppendBatch?(payloads: readonly Uint8Array[]): Promise<void>;
  append(record: QwpIngressReplayRecord): Promise<void>;
  acknowledgeThrough(frameSequence: bigint): Promise<void>;
  /**
   * @internal Removes a local prefix without representing it as a server ACK.
   * Persistent stores should provide this when recovery can abandon frames.
   *
   * "Without representing it as a server ACK" is about the transport's public
   * watermark, which the caller leaves alone. The removal itself must be as
   * durable as `acknowledgeThrough`'s: a discarded prefix that a later `load()`
   * can still see is a prefix this client reported abandoned and then sent
   * anyway.
   */
  discardThrough?(frameSequence: bigint): Promise<void>;
  /** Loads the durable, dense symbol prefix used by persisted delta frames. */
  loadSymbolDictionary?(): Promise<readonly string[]>;
  /** Persists new dense entries before a delta frame is made replayable. */
  appendSymbolDictionary?(
    startId: number,
    entries: readonly string[],
  ): Promise<void>;
  /**
   * Atomically replaces an unusable dictionary after surviving committed
   * frames prove that its complete ID space can be reconstructed.
   */
  replaceSymbolDictionary?(entries: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

/**
 * @internal Notification-inbox metrics exposed by reconnecting egress transports.
 *
 * Egress dispatches reconnect events through the same bounded inbox as ingress,
 * and it drops the oldest entry the same way. Without a reader the drop counter
 * was unobservable, so a run of discarded events was indistinguishable from a
 * healthy one: `attempt` resets on every success, so the delivered stream
 * carries no gap to infer from.
 */
export interface QwpEgressTransportMetrics {
  readonly deliveredConnectionNotifications: number;
  readonly droppedConnectionNotifications: number;
}

/** Physical ingress delivery counters maintained by reconnecting transports. */
export interface QwpIngressTransportMetrics {
  /** Highest stable replay-frame sequence handed to the transport. */
  readonly publishedFrameSequence: bigint;
  /** Highest replay-frame sequence removed after a server acknowledgement. */
  readonly acknowledgedFrameSequence: bigint;
  /** Stable frame ranges retired without ever receiving a server ACK. */
  readonly abandonedFrameRanges?: readonly {
    readonly fromFsn: bigint;
    readonly toFsn: bigint;
  }[];
  readonly pendingReplayFrames: number;
  readonly pendingReplayBytes: number;
  /** Configured cap for the built-in memory replay store. */
  readonly memoryReplayMaxBytes?: number;
  /** Estimated payload and record-bookkeeping bytes charged to that cap. */
  readonly memoryReplayUsedBytes?: number;
  readonly waitingMemoryReplayAppends: number;
  readonly totalMemoryReplayBackpressureStalls: number;
  readonly totalMemoryReplayAppendTimeouts: number;
  /** Physical WebSocket sends, including replay and dictionary catch-up. */
  readonly totalFramesSent: number;
  readonly totalBytesSent: number;
  readonly totalFramesReplayed: number;
  readonly totalBytesReplayed: number;
  readonly totalReconnectAttempts: number;
  readonly totalReconnectsSucceeded: number;
  readonly totalFailovers: number;
  readonly totalReconnectErrors: number;
  readonly totalServerNacks: number;
  readonly deliveredConnectionNotifications?: number;
  readonly droppedConnectionNotifications?: number;
  readonly deliveredErrorNotifications?: number;
  readonly droppedErrorNotifications?: number;
}

export const QWP_RECONNECT_EVENT_KIND = {
  CONNECTED: "connected",
  RECONNECTING: "reconnecting",
  ATTEMPT_FAILED: "attempt-failed",
  RECONNECTED: "reconnected",
  FAILED_OVER: "failed-over",
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
  readonly endpoint?: string | URL;
  readonly previousEndpoint?: string | URL;
  readonly cause?: unknown;
  /** Elapsed time in the current consecutive capability-gap episode. */
  readonly episodeMs?: number;
}

/**
 * Initial connection policy for an ingress reconnect session. Public browser
 * and memory-only helpers resolve their default internally; Node persistent
 * store-and-forward exposes all three modes.
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
   * rejections or non-orderly closes become terminal. Defaults to 5 minutes;
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

/** Server role accepted by an egress connection. Defaults to `any`. */
export type QwpTarget = (typeof QWP_TARGET)[keyof typeof QWP_TARGET];

/** Browser-safe endpoint-routing controls used by QWP egress clients. */
/**
 * Endpoint routing preferences. Named for egress, where they landed first, but
 * ingress ranks and validates its endpoints with the same machinery and honours
 * the same two keys.
 */
export interface QwpEgressRoutingOptions {
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

/**
 * Normalized binary connection consumed by QWP sessions.
 *
 * Adapters buffer messages until the single async iterator consumes them, so
 * unsolicited frames such as egress SERVER_INFO cannot race session startup.
 */
export interface QwpBinaryConnection {
  readonly messages: AsyncIterable<Uint8Array>;
  readonly closed: Promise<QwpConnectionCloseInfo>;
  readonly handshake: QwpHandshakeMetadata;
  /** @internal Recovered ingress dictionary supplied by replay connections. */
  readonly ingressSymbolDictionary?: readonly string[];
  /** @internal False after replay dictionary persistence becomes unavailable. */
  readonly ingressDeltaSymbolDictionaryEnabled?: boolean;
  /** @internal True when the transport dispatches typed sender errors itself. */
  readonly managesIngressSenderErrors?: boolean;
  /** Endpoint backing this connection, when supplied by its adapter. */
  readonly endpoint?: string | URL;

  /** @internal Physical delivery metrics exposed by replaying transports. */
  getIngressMetrics?(): QwpIngressTransportMetrics;

  /** @internal Notification-inbox metrics exposed by reconnecting transports. */
  getEgressMetrics?(): QwpEgressTransportMetrics;

  /**
   * @internal Published watermark alone, for the flush path.
   *
   * Transports that expose this must keep it consistent with
   * {@link getIngressMetrics}'s `publishedFrameSequence`; callers fall back to
   * the full snapshot when it is absent.
   */
  getPublishedFrameSequence?(): bigint;

  /** @internal Resolves a session sequence to its stable replay FSN. */
  getIngressFrameSequence?(clientSequence: bigint): bigint | undefined;

  /**
   * @internal Reserves a client sequence for a split-batch suffix suppressed
   * before send(), keeping replay ACK translation aligned with the session.
   */
  skipIngressClientSequence?(): void;

  /**
   * @internal Serializes a whole logical batch capacity check before its first
   * frame is sent, preventing a deferred prefix from consuming the only space
   * needed by its commit-bearing suffix.
   */
  prepareIngressBatch?(payloads: readonly Uint8Array[]): Promise<void>;

  /**
   * @internal Marks this endpoint as temporarily unsuitable and asks a stateful
   * connection factory to start its next sweep at another configured endpoint.
   */
  deprioritizeEndpoint?(): void;

  send(payload: Uint8Array): Promise<void>;
  /** Sends an RFC 6455 PING when the underlying runtime supports it. */
  ping?(): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}

export interface QwpWebSocketConnectOptions {
  url: string | URL;
  /** Additional endpoints attempted in order when the preferred endpoint fails. */
  failoverUrls?: readonly (string | URL)[];
  protocols?: string | string[];
  /**
   * Node TCP/TLS connection deadline, or the complete opening deadline in a
   * browser. Defaults to 15s. Capped at 2,147,483,647ms (the host timer
   * ceiling); a larger value throws a `RangeError`.
   */
  connectTimeoutMs?: number;
  /**
   * Maximum time a send may remain queued by the WebSocket. Defaults to 15s.
   * Capped at 2,147,483,647ms (the host timer ceiling); a larger value throws
   * a `RangeError`.
   */
  sendTimeoutMs?: number;
  /**
   * Maximum time allowed for a graceful WebSocket close. Defaults to 15s.
   * Capped at 2,147,483,647ms (the host timer ceiling); a larger value throws
   * a `RangeError`.
   */
  closeTimeoutMs?: number;
}

/**
 * Opens one connection. The optional signal is aborted when the owning session
 * closes, so a factory that is still negotiating can tear its socket down
 * instead of leaving it alive until its own deadline expires. Factories that
 * ignore the parameter remain assignable.
 */
export type QwpConnectionFactory = (
  signal?: AbortSignal,
) => Promise<QwpBinaryConnection>;
