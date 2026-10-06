import type {
  QwpConnectionCloseInfo,
  QwpHandshakeMetadata,
} from "../transport";

/**
 * Notification-inbox metrics exposed by reconnecting egress transports.
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

/**
 * Normalized binary connection consumed by QWP sessions.
 *
 * Adapters buffer messages until the single async iterator consumes them, so
 * unsolicited frames such as egress SERVER_INFO cannot race session startup.
 *
 * Internal, like the factory type and transport metrics in this module: the
 * runtime adapters hand connections to sessions they construct themselves, so
 * neither package root exports these types.
 */
export interface QwpBinaryConnection {
  readonly messages: AsyncIterable<Uint8Array>;
  readonly closed: Promise<QwpConnectionCloseInfo>;
  readonly handshake: QwpHandshakeMetadata;
  /** Recovered ingress dictionary supplied by replay connections. */
  readonly ingressSymbolDictionary?: readonly string[];
  /** False after replay dictionary persistence becomes unavailable. */
  readonly ingressDeltaSymbolDictionaryEnabled?: boolean;
  /** True when the transport dispatches typed sender errors itself. */
  readonly managesIngressSenderErrors?: boolean;
  /** Endpoint backing this connection, when supplied by its adapter. */
  readonly endpoint?: string | URL;

  /** Physical delivery metrics exposed by replaying transports. */
  getIngressMetrics?(): QwpIngressTransportMetrics;

  /** Notification-inbox metrics exposed by reconnecting transports. */
  getEgressMetrics?(): QwpEgressTransportMetrics;

  /**
   * Published watermark alone, for the flush path.
   *
   * Transports that expose this must keep it consistent with
   * {@link getIngressMetrics}'s `publishedFrameSequence`; callers fall back to
   * the full snapshot when it is absent.
   */
  getPublishedFrameSequence?(): bigint;

  /** Resolves a session sequence to its stable replay FSN. */
  getIngressFrameSequence?(clientSequence: bigint): bigint | undefined;

  /**
   * Reserves a client sequence for a split-batch suffix suppressed
   * before send(), keeping replay ACK translation aligned with the session.
   */
  skipIngressClientSequence?(): void;

  /**
   * Serializes a whole logical batch capacity check before its first
   * frame is sent, preventing a deferred prefix from consuming the only space
   * needed by its commit-bearing suffix.
   */
  prepareIngressBatch?(payloads: readonly Uint8Array[]): Promise<void>;

  /**
   * Marks this endpoint as temporarily unsuitable and asks a stateful
   * connection factory to start its next sweep at another configured endpoint.
   */
  deprioritizeEndpoint?(): void;

  send(payload: Uint8Array): Promise<void>;
  /** Sends an RFC 6455 PING when the underlying runtime supports it. */
  ping?(): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
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
