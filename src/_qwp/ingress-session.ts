import {
  decodeQwpIngressSymbolDictionaryDelta,
  decodeQwpIngressResponse,
  encodeQwpDurableAckPollFrame,
  encodeQwpIngressFrame,
  QWP_FLAG_DEFER_COMMIT,
  QWP_STATUS,
  QwpIngressEncodeOptions,
  QwpIngressResponse,
  QwpProtocolError,
  QwpSymbolDictionary,
  QwpTableBuffer,
} from "./_core";
import {
  QWP_INITIAL_CONNECT_MODE,
  QwpBinaryConnection,
  QwpConnectionCloseInfo,
  QwpConnectionFactory,
  QwpHandshakeMetadata,
  QwpInitialConnectMode,
  QwpIngressReplayStore,
  QwpReconnectOptions,
  QwpReplayDictionaryPersistenceError,
} from "./transport";
import { QwpReconnectingIngressConnection } from "./_internal/reconnecting-ingress-connection";
import { QwpNotificationDispatcher } from "./_internal/notification-dispatcher";
import { safelyInvoke } from "./_internal/safe-callback";
import {
  createQwpSenderError,
  defaultQwpSenderErrorHandler,
  QWP_SENDER_ERROR_POLICY,
  type QwpSenderError,
} from "./sender-error";
import { log } from "../logging";

const QWP_FLAGS_OFFSET = 5;
const DEFAULT_CONNECTION_LISTENER_INBOX_CAPACITY = 64;
const DEFAULT_ERROR_INBOX_CAPACITY = 256;
const DEFAULT_PROGRESS_INBOX_CAPACITY = 256;

interface PlannedIngressFrames {
  readonly frames: Uint8Array[];
}

function splitUnitCount(tables: readonly QwpTableBuffer[]): number {
  return tables.reduce(
    (total, table) => total + Math.max(1, table.rowCount),
    0,
  );
}

function splitTablesAtUnit(
  tables: readonly QwpTableBuffer[],
  leftUnitCount: number,
): [QwpTableBuffer[], QwpTableBuffer[]] {
  const left: QwpTableBuffer[] = [];
  const right: QwpTableBuffer[] = [];
  let remaining = leftUnitCount;

  for (const table of tables) {
    if (remaining <= 0) {
      right.push(table);
    } else if (table.rowCount === 0) {
      left.push(table);
      remaining--;
    } else if (remaining >= table.rowCount) {
      left.push(table);
      remaining -= table.rowCount;
    } else {
      left.push(table.sliceRows(0, remaining));
      right.push(table.sliceRows(remaining, table.rowCount));
      remaining = 0;
    }
  }
  return [left, right];
}

/**
 * Preflights a logical ingress flush without publishing any frame. Oversized
 * candidates are bisected in table/row order. Accepted candidates advance a
 * delta dictionary transactionally; any terminal failure restores its initial
 * size. Non-final frames defer commit so the final frame closes the group.
 */
function planIngressFrames(
  tables: readonly QwpTableBuffer[],
  encodeOptions: QwpIngressEncodeOptions,
  maxBatchSizeBytes: number,
): PlannedIngressFrames {
  const dictionary = encodeOptions.dictionary;
  const initialDictionarySize = dictionary?.size;
  let confirmedMaxSymbolId = encodeOptions.confirmedMaxSymbolId ?? -1;
  const frames: Uint8Array[] = [];

  const plan = (candidate: readonly QwpTableBuffer[]): void => {
    const dictionarySize = dictionary?.size;
    const frame = encodeQwpIngressFrame(candidate, {
      ...encodeOptions,
      deferCommit: false,
      dictionary,
      confirmedMaxSymbolId: dictionary
        ? confirmedMaxSymbolId
        : encodeOptions.confirmedMaxSymbolId,
    });
    if (frame.byteLength <= maxBatchSizeBytes) {
      frames.push(frame);
      if (dictionary) confirmedMaxSymbolId = dictionary.size - 1;
      return;
    }

    if (dictionarySize !== undefined) dictionary!.truncate(dictionarySize);
    const units = splitUnitCount(candidate);
    if (units <= 1) {
      throw new QwpBatchTooLargeError(frame.byteLength, maxBatchSizeBytes);
    }
    const [left, right] = splitTablesAtUnit(candidate, Math.ceil(units / 2));
    plan(left);
    plan(right);
  };

  try {
    plan(tables);
    const deferAll = encodeOptions.deferCommit ?? false;
    frames.forEach((frame, index) => {
      if (deferAll || index < frames.length - 1) {
        frame[QWP_FLAGS_OFFSET] |= QWP_FLAG_DEFER_COMMIT;
      }
    });
    return { frames };
  } catch (error) {
    if (initialDictionarySize !== undefined) {
      dictionary!.truncate(initialDictionarySize);
    }
    throw error;
  }
}

function mergeIngressResponses(
  responses: readonly QwpIngressResponse[],
): QwpIngressResponse {
  const last = responses[responses.length - 1];
  const tables = new Map<string, bigint>();
  for (const response of responses) {
    for (const table of response.tables) {
      const previous = tables.get(table.name);
      if (previous === undefined || table.sequenceTransaction > previous) {
        tables.set(table.name, table.sequenceTransaction);
      }
    }
  }
  return {
    ...last,
    tables: [...tables].map(([name, sequenceTransaction]) => ({
      name,
      sequenceTransaction,
    })),
  };
}

export interface QwpIngressSessionOptions {
  ackTimeoutMs?: number;
  /**
   * Bounded reconnection and at-least-once replay policy. Reconnection is
   * enabled by default for factory-created sessions; set false to keep one
   * fixed connection. Browser and non-persistent Node replay is memory-only.
   *
   * An ACK lost during disconnect can cause a frame to be replayed after the
   * server accepted it; configure server-side deduplication when duplicates
   * are not acceptable.
   */
  reconnect?: QwpReconnectOptions | false;
  /**
   * Hard cap for the built-in memory-only replay queue, including estimated
   * per-frame bookkeeping. Defaults to 128 MiB. This applies in browsers and
   * non-persistent Node sessions; custom replay stores enforce their own cap.
   */
  memoryReplayMaxBytes?: number;
  /**
   * Maximum time a memory replay append waits for ACK-driven trimming after
   * reaching memoryReplayMaxBytes. Defaults to 30 seconds.
   */
  memoryReplayAppendDeadlineMs?: number;
  /** @internal Node adapter hook for persistent store-and-forward. */
  replayStore?: QwpIngressReplayStore;
  /** @internal Starts memory or persistent replay without waiting for a server. */
  backgroundStoreAndForward?: boolean;
  /** @internal Initial connection policy supplied by the Node adapter. */
  initialConnectMode?: QwpInitialConnectMode;
  /** @internal Orphan sessions may quarantine persistent catch-up cap gaps. */
  orphanStoreAndForward?: boolean;
  /** @internal Consecutive durable-ACK gap budget retained for orphan SF. */
  orphanDurableAckMismatchMaxDurationMs?: number;
  /** @internal Minimum cap-gap dwell before an orphan can be quarantined. */
  catchUpCapGapMinEscalationWindowMs?: number;
  /**
   * Optional local ingress frame cap. Browsers cannot read WebSocket upgrade
   * headers, so browser applications should set this to the server's configured
   * QWP cap. When the server also advertises a cap, the smaller value wins.
   * Table batches are split at row boundaries automatically; an individual row
   * that cannot fit is rejected with QwpBatchTooLargeError before it is sent.
   */
  maxBatchSizeBytes?: number;
  /**
   * Enables durable-ACK tracking. While committed table transactions await
   * durable upload, Node transports send WebSocket PING frames and browser
   * transports send table-less QWP poll frames. Zero keeps tracking enabled
   * but disables automatic polling.
   */
  durableAckKeepaliveMs?: number;
  /**
   * Bounded reconnect-listener inbox. Oldest pending events are dropped when
   * full. Defaults to 64, matching the Java client.
   */
  connectionListenerInboxCapacity?: number;
  /**
   * Bounded typed/legacy error inbox. Oldest pending errors are dropped when
   * full. Defaults to 256, matching the Java client.
   */
  errorInboxCapacity?: number;
  /**
   * Java-parity typed server-rejection and data-loss notifications. When
   * omitted, the default handler logs retriable errors at warn and terminal
   * errors or abandoned data at error.
   */
  onSenderError?: (error: QwpSenderError) => void;
  onResponse?: (response: QwpIngressResponse) => void;
  onDurableAck?: (response: QwpIngressResponse) => void;
  /** Monotonic send/accept/durability notifications. Callback errors are ignored. */
  onProgress?: (event: QwpIngressProgressEvent) => void;
  /** Server rejections, deadlines, and terminal session failures. */
  onError?: (event: QwpIngressErrorEvent) => void;
}

export const QWP_INGRESS_PROGRESS_KIND = {
  PUBLISHED: "published",
  ACKNOWLEDGED: "acknowledged",
  DURABLE_ACKNOWLEDGED: "durable-acknowledged",
} as const;

const DEFAULT_INGRESS_RECONNECT_OPTIONS: Readonly<QwpReconnectOptions> = {
  maxAttempts: 0,
  initialBackoffMs: 100,
  maxBackoffMs: 5_000,
  maxDurationMs: 300_000,
};

export type QwpIngressProgressKind =
  (typeof QWP_INGRESS_PROGRESS_KIND)[keyof typeof QWP_INGRESS_PROGRESS_KIND];

/** Immutable point-in-time ingress telemetry, safe in browsers and Node.js. */
export interface QwpIngressMetrics {
  /** Highest client-session sequence allocated, or -1 before the first send. */
  readonly publishedSequence: bigint;
  /** Highest client-session sequence covered by a successful cumulative ACK. */
  readonly acknowledgedSequence: bigint;
  readonly pendingResponses: number;
  readonly pendingResponseBytes: number;
  readonly pendingDurableTables: number;
  readonly totalFramesPublished: number;
  readonly totalBytesPublished: number;
  /** Physical sends; includes replay and dictionary catch-up when available. */
  readonly totalFramesSent: number;
  readonly totalBytesSent: number;
  readonly totalFramesReplayed: number;
  readonly totalBytesReplayed: number;
  readonly totalAcks: number;
  readonly totalNacks: number;
  readonly totalDurableAcks: number;
  readonly totalErrors: number;
  readonly totalReconnectAttempts: number;
  readonly totalReconnectsSucceeded: number;
  readonly totalFailovers: number;
  readonly totalReconnectErrors: number;
  readonly deliveredProgressNotifications: number;
  readonly droppedProgressNotifications: number;
  readonly deliveredConnectionNotifications: number;
  readonly droppedConnectionNotifications: number;
  readonly deliveredErrorNotifications: number;
  readonly droppedErrorNotifications: number;
  /** Stable store-and-forward watermark; absent without reconnect/replay. */
  readonly replayPublishedFrameSequence?: bigint;
  /** Trim watermark; in durable-ACK mode it advances only after durability. */
  readonly replayAcknowledgedFrameSequence?: bigint;
  readonly pendingReplayFrames: number;
  readonly pendingReplayBytes: number;
  readonly memoryReplayMaxBytes?: number;
  readonly memoryReplayUsedBytes?: number;
  readonly waitingMemoryReplayAppends: number;
  readonly totalMemoryReplayBackpressureStalls: number;
  readonly totalMemoryReplayAppendTimeouts: number;
  readonly lastError?: Error;
}

export interface QwpIngressProgressEvent {
  readonly kind: QwpIngressProgressKind;
  readonly timestampMs: number;
  readonly sequence?: bigint;
  readonly response?: QwpIngressResponse;
  readonly metrics: QwpIngressMetrics;
}

export interface QwpIngressErrorEvent {
  readonly error: Error;
  readonly terminal: boolean;
  readonly timestampMs: number;
  readonly response?: QwpIngressResponse;
  /** Present for a classified server rejection. */
  readonly senderError?: QwpSenderError;
  readonly metrics: QwpIngressMetrics;
}

/**
 * One ingress operation with independent local-publication and server-ACK
 * completion. Publication resolves after every physical frame belonging to
 * the logical batch has been accepted by the connection. For persistent Node
 * transports that means the frames are durable in the replay journal.
 */
export interface QwpIngressSendResult {
  /** Last client-session sequence allocated to this logical batch. */
  readonly sequence: bigint;
  /** Local transport/journal ownership boundary. */
  readonly publication: Promise<void>;
  /** Cumulative server response for every frame in the logical batch. */
  readonly acknowledgement: Promise<QwpIngressResponse>;
}

interface PendingResponse {
  resolve: (response: QwpIngressResponse) => void;
  reject: (error: unknown) => void;
  readonly payloadBytes: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface PendingDurableResponse {
  readonly targets: Map<string, bigint>;
  resolve: () => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface PendingAcknowledgedSequence {
  readonly targetSequence: bigint;
  resolve: () => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class QwpIngressNackError extends Error {
  constructor(
    readonly response: QwpIngressResponse,
    readonly senderError: QwpSenderError = createQwpSenderError(response),
  ) {
    super(
      response.errorMessage ??
        `QuestDB rejected QWP frame [status=0x${response.status.toString(16)}]`,
    );
    this.name = "QwpIngressNackError";
  }
}

export class QwpIngressSessionClosedError extends Error {
  constructor(readonly closeInfo?: QwpConnectionCloseInfo) {
    super(
      closeInfo
        ? `QWP ingress connection closed [code=${closeInfo.code}, reason=${closeInfo.reason}]`
        : "QWP ingress session is closed",
    );
    this.name = "QwpIngressSessionClosedError";
  }
}

/** The ingress ACK watermark did not reach the requested frame in time. */
export class QwpIngressAckTimeoutError extends Error {
  constructor(
    readonly targetSequence: bigint,
    readonly acknowledgedSequence: bigint,
    readonly timeoutMs: number,
  ) {
    super(
      `timed out waiting for QWP ACK watermark [targetSequence=${targetSequence}, acknowledgedSequence=${acknowledgedSequence}, timeoutMs=${timeoutMs}]`,
    );
    this.name = "QwpIngressAckTimeoutError";
  }
}

export class QwpBatchTooLargeError extends RangeError {
  constructor(
    readonly batchSizeBytes: number,
    readonly maxBatchSizeBytes: number,
  ) {
    super(
      `QWP batch exceeds the negotiated limit [size=${batchSizeBytes}, max=${maxBatchSizeBytes}]`,
    );
    this.name = "QwpBatchTooLargeError";
  }
}

function validateIngressSessionOptions(
  options: QwpIngressSessionOptions,
): void {
  const timeout = options.ackTimeoutMs ?? 15_000;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new RangeError("ackTimeoutMs must be a positive finite number");
  }
  const localBatchCap = options.maxBatchSizeBytes;
  if (
    localBatchCap !== undefined &&
    (!Number.isSafeInteger(localBatchCap) || localBatchCap <= 0)
  ) {
    throw new RangeError("maxBatchSizeBytes must be a positive safe integer");
  }
  const memoryReplayMaxBytes = options.memoryReplayMaxBytes;
  if (
    memoryReplayMaxBytes !== undefined &&
    (!Number.isSafeInteger(memoryReplayMaxBytes) || memoryReplayMaxBytes <= 0)
  ) {
    throw new RangeError(
      "memoryReplayMaxBytes must be a positive safe integer",
    );
  }
  const memoryReplayAppendDeadlineMs = options.memoryReplayAppendDeadlineMs;
  if (
    memoryReplayAppendDeadlineMs !== undefined &&
    (!Number.isSafeInteger(memoryReplayAppendDeadlineMs) ||
      memoryReplayAppendDeadlineMs <= 0 ||
      memoryReplayAppendDeadlineMs > 2_147_483_647)
  ) {
    throw new RangeError(
      "memoryReplayAppendDeadlineMs must be a positive safe integer no greater than 2147483647",
    );
  }
  if (
    options.replayStore &&
    (memoryReplayMaxBytes !== undefined ||
      memoryReplayAppendDeadlineMs !== undefined)
  ) {
    throw new RangeError(
      "memory replay capacity options cannot be combined with a custom replayStore",
    );
  }
  const keepalive = options.durableAckKeepaliveMs;
  if (
    keepalive !== undefined &&
    (!Number.isFinite(keepalive) || keepalive < 0)
  ) {
    throw new RangeError(
      "durableAckKeepaliveMs must be a non-negative finite number",
    );
  }
  const orphanDurableAckBudget = options.orphanDurableAckMismatchMaxDurationMs;
  if (
    orphanDurableAckBudget !== undefined &&
    (!Number.isFinite(orphanDurableAckBudget) || orphanDurableAckBudget < 0)
  ) {
    throw new RangeError(
      "orphanDurableAckMismatchMaxDurationMs must be a non-negative finite number",
    );
  }
  for (const [name, value, minimum] of [
    [
      "connectionListenerInboxCapacity",
      options.connectionListenerInboxCapacity,
      1,
    ],
    ["errorInboxCapacity", options.errorInboxCapacity, 16],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < minimum)
    ) {
      throw new RangeError(`${name} must be an integer of at least ${minimum}`);
    }
  }
}

/**
 * Connection-scoped ingress sequencer.
 *
 * One promise is registered before each WebSocket send, preventing a fast ACK
 * from racing its waiter. Calls are serialized to preserve the server's
 * zero-based wire sequence. Successful ACKs are cumulative, so an ACK for
 * sequence N resolves every outstanding send through N.
 */
export class QwpIngressSession {
  private readonly pending = new Map<bigint, PendingResponse>();
  private readonly durableWatermarks = new Map<string, bigint>();
  private readonly pendingDurableTargets = new Map<string, bigint>();
  private readonly durableWaiters = new Set<PendingDurableResponse>();
  private readonly acknowledgedSequenceWaiters =
    new Set<PendingAcknowledgedSequence>();
  private readonly durableFrameTargets = new Map<
    bigint,
    ReadonlyMap<string, bigint>
  >();
  private acknowledgementRejection?: {
    readonly sequence: bigint;
    readonly error: QwpIngressNackError;
  };
  private nextSequence = 0n;
  private sendTail: Promise<void> = Promise.resolve();
  private durablePollTimer?: ReturnType<typeof setTimeout>;
  private readonly localMaxBatchSizeBytes?: number;
  private readonly symbolDictionary = new QwpSymbolDictionary();
  private publishedMaxSymbolId = -1;
  private deltaSymbolsPublished = false;
  private acknowledgedSequence = -1n;
  private durableAcknowledgedSequence = -1n;
  private totalFramesPublished = 0;
  private totalBytesPublished = 0;
  private totalFramesSent = 0;
  private totalBytesSent = 0;
  private totalAcks = 0;
  private totalNacks = 0;
  private totalDurableAcks = 0;
  private totalErrors = 0;
  private lastError?: Error;
  private failure?: Error;
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly closeHooks: (() => void | Promise<void>)[] = [];
  private readonly receiveLoop: Promise<void>;
  private readonly progressDispatcher?: QwpNotificationDispatcher<() => void>;
  private readonly errorDispatcher?: QwpNotificationDispatcher<() => void>;

  constructor(
    private readonly connection: QwpBinaryConnection,
    private readonly options: QwpIngressSessionOptions = {},
  ) {
    try {
      if (
        options.reconnect &&
        !(connection instanceof QwpReconnectingIngressConnection)
      ) {
        throw new Error(
          "ingress reconnect options require QwpIngressSession.connect(factory, options)",
        );
      }
      if (
        (options.memoryReplayMaxBytes !== undefined ||
          options.memoryReplayAppendDeadlineMs !== undefined) &&
        !(connection instanceof QwpReconnectingIngressConnection)
      ) {
        throw new Error(
          "memory replay capacity options require ingress reconnect",
        );
      }
      validateIngressSessionOptions(options);
    } catch (error) {
      try {
        void connection
          .close(1002, "invalid QWP ingress session options")
          .catch(() => undefined);
      } catch {
        // Preserve the configuration error when transport cleanup also fails.
      }
      throw error;
    }
    this.localMaxBatchSizeBytes = options.maxBatchSizeBytes;
    if (options.onResponse || options.onDurableAck || options.onProgress) {
      this.progressDispatcher = new QwpNotificationDispatcher(
        (callback) => callback(),
        DEFAULT_PROGRESS_INBOX_CAPACITY,
      );
    }
    if (
      options.onError ||
      (options.onSenderError && !connection.managesIngressSenderErrors)
    ) {
      this.errorDispatcher = new QwpNotificationDispatcher(
        (callback) => callback(),
        options.errorInboxCapacity ?? DEFAULT_ERROR_INBOX_CAPACITY,
      );
    }
    for (const entry of connection.ingressSymbolDictionary ?? []) {
      this.symbolDictionary.addRecovered(entry);
    }
    this.publishedMaxSymbolId = this.symbolDictionary.size - 1;
    this.deltaSymbolsPublished = this.symbolDictionary.size > 0;
    this.receiveLoop = this.consumeMessages();
  }

  static async connect(
    factory: QwpConnectionFactory,
    options: QwpIngressSessionOptions = {},
    /**
     * Cancels a first connect that is still negotiating. The reconnect loop
     * owns its own controller, but the initial attempt bypasses it -- it is
     * either handed in as `initialConnection` or awaited directly below -- so
     * without this a close() during the first connect left the socket and its
     * deadline alive for the full connect/auth timeout.
     */
    signal?: AbortSignal,
  ): Promise<QwpIngressSession> {
    validateIngressSessionOptions(options);
    if (options.replayStore && options.reconnect === false) {
      throw new RangeError("a QWP replayStore requires ingress reconnect");
    }
    const reconnectOptions =
      options.reconnect === false
        ? undefined
        : (options.reconnect ?? DEFAULT_INGRESS_RECONNECT_OPTIONS);
    const initialConnectMode =
      options.initialConnectMode ??
      (options.reconnect === undefined && !options.backgroundStoreAndForward
        ? QWP_INITIAL_CONNECT_MODE.OFF
        : undefined);
    // Preserve the connector contract that the first browser/Node transport
    // is constructed synchronously. The in-memory replay store initializes
    // asynchronously, but real and test WebSockets may open immediately after
    // their factory returns.
    const initialConnection =
      reconnectOptions &&
      options.reconnect === undefined &&
      !options.replayStore &&
      !options.backgroundStoreAndForward
        ? factory(signal)
        : undefined;
    const connection = reconnectOptions
      ? await QwpReconnectingIngressConnection.connect(
          factory,
          reconnectOptions,
          options.replayStore,
          options.maxBatchSizeBytes,
          options.memoryReplayMaxBytes,
          options.memoryReplayAppendDeadlineMs,
          options.backgroundStoreAndForward,
          initialConnectMode,
          options.orphanStoreAndForward,
          options.orphanDurableAckMismatchMaxDurationMs,
          options.catchUpCapGapMinEscalationWindowMs,
          initialConnection,
          options.connectionListenerInboxCapacity ??
            DEFAULT_CONNECTION_LISTENER_INBOX_CAPACITY,
          options.errorInboxCapacity ?? DEFAULT_ERROR_INBOX_CAPACITY,
          options.onSenderError,
          // Without this the signal reached only the eager initialConnection
          // above, which is skipped for exactly the configurations that own a
          // replay store -- so close() could not tear down the one connect
          // that holds a lock.
          signal,
        )
      : await factory(signal);
    try {
      return new QwpIngressSession(connection, options);
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  get closed(): Promise<QwpConnectionCloseInfo> {
    return this.connection.closed;
  }

  get handshake(): QwpHandshakeMetadata {
    return this.connection.handshake;
  }

  get maxBatchSizeBytes(): number | undefined {
    const serverBatchCap = this.connection.handshake.maxBatchSizeBytes;
    return this.localMaxBatchSizeBytes === undefined
      ? serverBatchCap
      : serverBatchCap === undefined
        ? this.localMaxBatchSizeBytes
        : Math.min(this.localMaxBatchSizeBytes, serverBatchCap);
  }

  /** Highest stable frame sequence published by this session/transport. */
  get publishedFrameSequence(): bigint {
    return (
      this.connection.getIngressMetrics?.().publishedFrameSequence ??
      this.nextSequence - 1n
    );
  }

  /**
   * Highest cumulative ACK watermark. When durable ACK was negotiated this
   * advances only after durability; otherwise it follows ordinary OK ACKs.
   */
  get acknowledgedFrameSequence(): bigint {
    const transport = this.connection.getIngressMetrics?.();
    if (transport) return transport.acknowledgedFrameSequence;
    return this.connection.handshake.durableAckEnabled
      ? this.durableAcknowledgedSequence
      : this.acknowledgedSequence;
  }

  get metrics(): QwpIngressMetrics {
    const transport = this.connection.getIngressMetrics?.();
    let pendingResponseBytes = 0;
    for (const pending of this.pending.values()) {
      pendingResponseBytes += pending.payloadBytes;
    }
    return Object.freeze({
      publishedSequence: this.nextSequence - 1n,
      acknowledgedSequence: this.acknowledgedSequence,
      pendingResponses: this.pending.size,
      pendingResponseBytes,
      pendingDurableTables: this.pendingDurableTargets.size,
      totalFramesPublished: this.totalFramesPublished,
      totalBytesPublished: this.totalBytesPublished,
      totalFramesSent: transport?.totalFramesSent ?? this.totalFramesSent,
      totalBytesSent: transport?.totalBytesSent ?? this.totalBytesSent,
      totalFramesReplayed: transport?.totalFramesReplayed ?? 0,
      totalBytesReplayed: transport?.totalBytesReplayed ?? 0,
      totalAcks: this.totalAcks,
      totalNacks: transport?.totalServerNacks ?? this.totalNacks,
      totalDurableAcks: this.totalDurableAcks,
      totalErrors: this.totalErrors,
      totalReconnectAttempts: transport?.totalReconnectAttempts ?? 0,
      totalReconnectsSucceeded: transport?.totalReconnectsSucceeded ?? 0,
      totalFailovers: transport?.totalFailovers ?? 0,
      totalReconnectErrors: transport?.totalReconnectErrors ?? 0,
      deliveredProgressNotifications:
        this.progressDispatcher?.metrics.delivered ?? 0,
      droppedProgressNotifications:
        this.progressDispatcher?.metrics.dropped ?? 0,
      deliveredConnectionNotifications:
        transport?.deliveredConnectionNotifications ?? 0,
      droppedConnectionNotifications:
        transport?.droppedConnectionNotifications ?? 0,
      deliveredErrorNotifications:
        (transport?.deliveredErrorNotifications ?? 0) +
        (this.errorDispatcher?.metrics.delivered ?? 0),
      droppedErrorNotifications:
        (transport?.droppedErrorNotifications ?? 0) +
        (this.errorDispatcher?.metrics.dropped ?? 0),
      replayPublishedFrameSequence: transport?.publishedFrameSequence,
      replayAcknowledgedFrameSequence: transport?.acknowledgedFrameSequence,
      pendingReplayFrames: transport?.pendingReplayFrames ?? 0,
      pendingReplayBytes: transport?.pendingReplayBytes ?? 0,
      memoryReplayMaxBytes: transport?.memoryReplayMaxBytes,
      memoryReplayUsedBytes: transport?.memoryReplayUsedBytes,
      waitingMemoryReplayAppends: transport?.waitingMemoryReplayAppends ?? 0,
      totalMemoryReplayBackpressureStalls:
        transport?.totalMemoryReplayBackpressureStalls ?? 0,
      totalMemoryReplayAppendTimeouts:
        transport?.totalMemoryReplayAppendTimeouts ?? 0,
      lastError: this.lastError,
    });
  }

  sendTables(
    tables: readonly QwpTableBuffer[],
    encodeOptions: QwpIngressEncodeOptions = {},
  ): Promise<QwpIngressResponse> {
    try {
      return this.sendTablesWithPublication(tables, encodeOptions)
        .acknowledgement;
    } catch (error) {
      if (error instanceof QwpBatchTooLargeError) return Promise.reject(error);
      throw error;
    }
  }

  /**
   * Starts an ingress batch and exposes local publication separately from its
   * server ACK. High-level senders use this boundary to retain retryable rows
   * until a persistent replay journal owns the complete logical batch.
   */
  sendTablesWithPublication(
    tables: readonly QwpTableBuffer[],
    encodeOptions: QwpIngressEncodeOptions = {},
  ): QwpIngressSendResult {
    this.throwIfUnavailable();
    const cap = this.maxBatchSizeBytes;
    if (cap === undefined) {
      return this.sendFrameWithPublication(
        encodeQwpIngressFrame(tables, encodeOptions),
      );
    }
    const planned = planIngressFrames(tables, encodeOptions, cap);
    return this.sendPlannedFramesWithPublication(planned.frames);
  }

  /**
   * Encodes and publishes tables without waiting for their server ACK. With
   * Node store-and-forward this resolves only after every frame is durable in
   * the local journal; browser and non-persistent transports resolve after the
   * WebSocket accepts the frames.
   */
  publishTables(
    tables: readonly QwpTableBuffer[],
    encodeOptions: QwpIngressEncodeOptions = {},
  ): Promise<void> {
    this.throwIfUnavailable();
    const cap = this.maxBatchSizeBytes;
    if (cap === undefined) {
      return this.publishFrame(encodeQwpIngressFrame(tables, encodeOptions));
    }
    let planned: PlannedIngressFrames;
    try {
      planned = planIngressFrames(tables, encodeOptions, cap);
    } catch (error) {
      if (error instanceof QwpBatchTooLargeError) return Promise.reject(error);
      throw error;
    }
    return this.publishPlannedFrames(planned.frames);
  }

  /**
   * Sends tables using the session's connection-scoped symbol dictionary.
   * String symbol values are assigned stable IDs automatically.
   * If a replay dictionary append fails, that call rejects with
   * QwpReplayDictionaryPersistenceError; retrying uses full inline symbols.
   */
  sendTablesDelta(
    tables: readonly QwpTableBuffer[],
    encodeOptions: Pick<
      QwpIngressEncodeOptions,
      "gorilla" | "deferCommit"
    > = {},
  ): Promise<QwpIngressResponse> {
    try {
      return this.sendTablesDeltaWithPublication(tables, encodeOptions)
        .acknowledgement;
    } catch (error) {
      if (error instanceof QwpBatchTooLargeError) return Promise.reject(error);
      throw error;
    }
  }

  /** Delta-dictionary variant of sendTablesWithPublication(). */
  sendTablesDeltaWithPublication(
    tables: readonly QwpTableBuffer[],
    encodeOptions: Pick<
      QwpIngressEncodeOptions,
      "gorilla" | "deferCommit"
    > = {},
  ): QwpIngressSendResult {
    this.throwIfUnavailable();
    if (this.connection.ingressDeltaSymbolDictionaryEnabled === false) {
      return this.sendTablesWithPublication(tables, encodeOptions);
    }
    const previousSize = this.symbolDictionary.size;
    const previousPublishedMaxSymbolId = this.publishedMaxSymbolId;
    const previousDeltaSymbolsPublished = this.deltaSymbolsPublished;
    let successfullyPublishedMaxSymbolId = previousPublishedMaxSymbolId;
    let successfullyPublishedDelta = previousDeltaSymbolsPublished;
    const recordPublishedDelta = (frame: Uint8Array): void => {
      const delta = decodeQwpIngressSymbolDictionaryDelta(frame);
      if (!delta) return;
      successfullyPublishedDelta = true;
      successfullyPublishedMaxSymbolId = Math.max(
        successfullyPublishedMaxSymbolId,
        delta.startId + delta.entries.length - 1,
      );
    };
    let sending: QwpIngressSendResult;
    try {
      const cap = this.maxBatchSizeBytes;
      if (cap !== undefined) {
        const planned = planIngressFrames(
          tables,
          {
            ...encodeOptions,
            dictionary: this.symbolDictionary,
            confirmedMaxSymbolId: this.publishedMaxSymbolId,
          },
          cap,
        );
        this.publishedMaxSymbolId = this.symbolDictionary.size - 1;
        this.deltaSymbolsPublished = true;
        sending = this.sendPlannedFramesWithPublication(
          planned.frames,
          recordPublishedDelta,
        );
      } else {
        const frame = encodeQwpIngressFrame(tables, {
          ...encodeOptions,
          dictionary: this.symbolDictionary,
          confirmedMaxSymbolId: this.publishedMaxSymbolId,
        });
        this.publishedMaxSymbolId = this.symbolDictionary.size - 1;
        this.deltaSymbolsPublished = true;
        const rawSending = this.sendFrameWithPublication(frame);
        sending = {
          ...rawSending,
          publication: rawSending.publication.then(() =>
            recordPublishedDelta(frame),
          ),
        };
      }
    } catch (error) {
      this.symbolDictionary.truncate(previousSize);
      this.publishedMaxSymbolId = previousPublishedMaxSymbolId;
      this.deltaSymbolsPublished = previousDeltaSymbolsPublished;
      throw error;
    }

    // The publication promise, rather than a synchronous try/catch around
    // sendFrame(), is the authoritative ownership boundary. Restore the
    // allocator/watermark before the acknowledgement observes a local journal
    // rejection, while retaining dictionary entries that did persist.
    const publication = sending.publication.catch((error: unknown) => {
      this.restoreDeltaStateAfterPublishFailure(previousSize);
      this.publishedMaxSymbolId = successfullyPublishedMaxSymbolId;
      this.deltaSymbolsPublished = successfullyPublishedDelta;
      throw error;
    });
    const acknowledgement = Promise.all([
      publication,
      sending.acknowledgement,
    ]).then(([, response]) => response);
    return { sequence: sending.sequence, publication, acknowledgement };
  }

  /**
   * Publishes tables with the automatic connection-scoped symbol dictionary.
   * After a replay dictionary persistence error, retries use full inline
   * symbols and no longer depend on the failed sidecar.
   */
  async publishTablesDelta(
    tables: readonly QwpTableBuffer[],
    encodeOptions: Pick<
      QwpIngressEncodeOptions,
      "gorilla" | "deferCommit"
    > = {},
  ): Promise<void> {
    this.throwIfUnavailable();
    if (this.connection.ingressDeltaSymbolDictionaryEnabled === false) {
      return this.publishTables(tables, encodeOptions);
    }
    const previousSize = this.symbolDictionary.size;
    const previousPublishedMaxSymbolId = this.publishedMaxSymbolId;
    const previousDeltaSymbolsPublished = this.deltaSymbolsPublished;
    let successfullyPublishedMaxSymbolId = previousPublishedMaxSymbolId;
    let successfullyPublishedDelta = previousDeltaSymbolsPublished;
    const recordPublishedDelta = (frame: Uint8Array): void => {
      const delta = decodeQwpIngressSymbolDictionaryDelta(frame);
      if (!delta) return;
      successfullyPublishedDelta = true;
      successfullyPublishedMaxSymbolId = Math.max(
        successfullyPublishedMaxSymbolId,
        delta.startId + delta.entries.length - 1,
      );
    };
    try {
      const cap = this.maxBatchSizeBytes;
      if (cap !== undefined) {
        const planned = planIngressFrames(
          tables,
          {
            ...encodeOptions,
            dictionary: this.symbolDictionary,
            confirmedMaxSymbolId: this.publishedMaxSymbolId,
          },
          cap,
        );
        this.publishedMaxSymbolId = this.symbolDictionary.size - 1;
        this.deltaSymbolsPublished = true;
        await this.publishPlannedFrames(planned.frames, recordPublishedDelta);
        return;
      }

      const frame = encodeQwpIngressFrame(tables, {
        ...encodeOptions,
        dictionary: this.symbolDictionary,
        confirmedMaxSymbolId: this.publishedMaxSymbolId,
      });
      this.publishedMaxSymbolId = this.symbolDictionary.size - 1;
      this.deltaSymbolsPublished = true;
      await this.publishFrame(frame);
      recordPublishedDelta(frame);
    } catch (error) {
      this.restoreDeltaStateAfterPublishFailure(previousSize);
      this.publishedMaxSymbolId = successfullyPublishedMaxSymbolId;
      this.deltaSymbolsPublished = successfullyPublishedDelta;
      throw error;
    }
  }

  /**
   * Restores the dictionary ID allocator after a failed asynchronous publish.
   *
   * A replay transport persists new dictionary entries before it appends the
   * frame that uses them. If that frame append fails, the persisted dictionary
   * is authoritative even though the frame-publication watermark must roll
   * back. Keeping those IDs prevents a changed retry from assigning a
   * different symbol to an already durable ID. The unchanged published
   * watermark makes the retry include the durable-but-unpublished prefix.
   */
  private restoreDeltaStateAfterPublishFailure(previousSize: number): void {
    if (!(this.connection instanceof QwpReconnectingIngressConnection)) {
      this.symbolDictionary.truncate(previousSize);
      return;
    }
    const recovered = this.connection.ingressSymbolDictionary;
    this.symbolDictionary.reset();
    for (const entry of recovered) {
      this.symbolDictionary.addRecovered(entry);
    }
  }

  /**
   * Publishes one pre-encoded frame without allocating an ACK waiter.
   * Applications can observe later acceptance through progress callbacks.
   */
  publishFrame(frame: Uint8Array): Promise<void> {
    this.throwIfUnavailable();
    if (
      this.maxBatchSizeBytes !== undefined &&
      frame.byteLength > this.maxBatchSizeBytes
    ) {
      return Promise.reject(
        new QwpBatchTooLargeError(frame.byteLength, this.maxBatchSizeBytes),
      );
    }
    const sequence = this.nextSequence++;
    this.totalFramesPublished++;
    this.totalBytesPublished += frame.byteLength;
    const publishing = this.sendTail.then(async () => {
      this.throwIfUnavailable();
      await this.connection.send(frame);
    });
    // A local store-capacity failure is backpressure, not a terminal session
    // failure. Keep the publication queue usable so callers can retry after
    // the background drainer frees journal capacity.
    this.sendTail = publishing.catch(() => undefined);
    this.emitProgress(QWP_INGRESS_PROGRESS_KIND.PUBLISHED, sequence);
    void publishing.then(
      () => {
        this.totalFramesSent++;
        this.totalBytesSent += frame.byteLength;
      },
      () => undefined,
    );
    return publishing;
  }

  sendFrame(frame: Uint8Array): Promise<QwpIngressResponse> {
    try {
      return this.sendFrameWithPublication(frame).acknowledgement;
    } catch (error) {
      if (error instanceof QwpBatchTooLargeError) return Promise.reject(error);
      throw error;
    }
  }

  /** Starts one pre-encoded frame with independent publication and ACKs. */
  sendFrameWithPublication(frame: Uint8Array): QwpIngressSendResult {
    return this.startFrameWithPublication(frame);
  }

  private startFrameWithPublication(
    frame: Uint8Array,
    publicationBarrier: Promise<void> = this.sendTail,
    ackTimeoutEnabled = true,
  ): QwpIngressSendResult {
    this.throwIfUnavailable();
    const ackDeferredUntilCommit =
      frame.byteLength > QWP_FLAGS_OFFSET &&
      (frame[QWP_FLAGS_OFFSET] & QWP_FLAG_DEFER_COMMIT) !== 0;
    if (
      this.maxBatchSizeBytes !== undefined &&
      frame.byteLength > this.maxBatchSizeBytes
    ) {
      throw new QwpBatchTooLargeError(frame.byteLength, this.maxBatchSizeBytes);
    }
    const sequence = this.nextSequence++;
    let pending!: PendingResponse;
    const response = new Promise<QwpIngressResponse>((resolve, reject) => {
      pending = { resolve, reject, payloadBytes: frame.byteLength };
    });
    this.pending.set(sequence, pending);
    this.totalFramesPublished++;
    this.totalBytesPublished += frame.byteLength;

    let sendStarted = false;
    const sending = publicationBarrier.then(
      async () => {
        this.throwIfUnavailable();
        sendStarted = true;
        await this.connection.send(frame);
      },
      (error: unknown) => {
        // This session sequence was already allocated, but the frame must not
        // reach a replay transport after an earlier frame in the same logical
        // transaction failed publication. Reserve its translation slot so all
        // later wire ACKs still map to the correct session sequence.
        this.connection.skipIngressClientSequence?.();
        throw error;
      },
    );
    this.sendTail = sending.catch((error: unknown) => {
      if (!sendStarted) return;
      if (error instanceof QwpReplayDictionaryPersistenceError) {
        this.recordError(error, false);
      } else if (this.connection instanceof QwpReconnectingIngressConnection) {
        // Replay transports own their terminal state. A local journal append
        // failure is retryable by the caller and must not brick the session;
        // terminal transport failures independently close the message stream.
        this.recordError(error, false);
      } else {
        this.fail(error);
      }
    });
    // Publish the callback only after sendTail owns this frame so a callback
    // that queues another frame cannot reorder it ahead of this sequence.
    this.emitProgress(QWP_INGRESS_PROGRESS_KIND.PUBLISHED, sequence);
    void sending.then(
      () => {
        this.totalFramesSent++;
        this.totalBytesSent += frame.byteLength;
        if (this.pending.get(sequence) !== pending) return;
        // QuestDB deliberately sends no ACK for a deferred frame. The later
        // group-closing frame has its own deadline and cumulatively resolves
        // this waiter, so starting a per-frame timer here would make valid
        // transactions fail merely because they stayed open for ackTimeoutMs.
        if (ackDeferredUntilCommit || !ackTimeoutEnabled) return;
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(sequence)) return;
          const error = new Error(
            `timed out waiting for QWP ACK [sequence=${sequence}]`,
          );
          pending.reject(error);
          this.recordError(error, false);
        }, this.options.ackTimeoutMs ?? 15_000);
      },
      () => undefined,
    );
    void sending.catch((error: unknown) => {
      const current = this.pending.get(sequence);
      if (current !== pending) return;
      this.pending.delete(sequence);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    });
    return {
      sequence,
      publication: sending,
      acknowledgement: response,
    };
  }

  private sendPlannedFramesWithPublication(
    frames: readonly Uint8Array[],
    onFramePublished?: (frame: Uint8Array) => void,
  ): QwpIngressSendResult {
    const sends: QwpIngressSendResult[] = [];
    let publicationBarrier = this.sendTail;
    for (const frame of frames) {
      const sending = this.startFrameWithPublication(frame, publicationBarrier);
      const tracked = onFramePublished
        ? {
            ...sending,
            publication: sending.publication.then(() =>
              onFramePublished(frame),
            ),
          }
        : sending;
      sends.push(tracked);
      // Within one logical split batch a failed prefix must suppress every
      // later frame. In particular, never send the final commit frame after a
      // deferred prefix failed to enter the replay journal.
      publicationBarrier = tracked.publication;
    }
    if (sends.length === 1) return sends[0];
    // The final barrier settles only after every suffix has either published
    // or been deliberately suppressed and had its sequence slot reserved.
    const publication = publicationBarrier;
    const acknowledgement = Promise.all(
      sends.map((send) => send.acknowledgement),
    ).then(mergeIngressResponses);
    return {
      sequence: sends[sends.length - 1].sequence,
      publication,
      acknowledgement,
    };
  }

  private async publishPlannedFrames(
    frames: readonly Uint8Array[],
    onFramePublished?: (frame: Uint8Array) => void,
  ): Promise<void> {
    for (const frame of frames) {
      await this.publishFrame(frame);
      onFramePublished?.(frame);
    }
  }

  /**
   * Waits independently for the cumulative frame ACK watermark. A negative
   * target is already satisfied, but still surfaces a latched session error.
   */
  waitForAcknowledged(
    targetSequence: bigint,
    timeoutMs = this.options.ackTimeoutMs ?? 15_000,
  ): Promise<void> {
    this.throwIfUnavailable();
    if (typeof targetSequence !== "bigint") {
      return Promise.reject(
        new TypeError("QWP ACK target sequence must be a bigint"),
      );
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(
        new RangeError("QWP ACK watermark timeout must be positive and finite"),
      );
    }
    const rejection = this.acknowledgementFailure(targetSequence);
    if (rejection) return Promise.reject(rejection);
    if (
      targetSequence < 0n ||
      this.acknowledgedFrameSequence >= targetSequence
    ) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const pending: PendingAcknowledgedSequence = {
        targetSequence,
        resolve,
        reject,
      };
      pending.timer = setTimeout(() => {
        if (!this.acknowledgedSequenceWaiters.delete(pending)) return;
        const error = new QwpIngressAckTimeoutError(
          targetSequence,
          this.acknowledgedFrameSequence,
          timeoutMs,
        );
        reject(error);
        this.recordError(error, false);
      }, timeoutMs);
      this.acknowledgedSequenceWaiters.add(pending);
      // Close the ACK-before-registration race. JavaScript is single-threaded,
      // but a custom connection can synchronously enqueue a response callback.
      this.resolveAcknowledgedSequenceWaiters();
    });
  }

  /**
   * Waits until a durable ACK covers every table transaction in an OK ACK.
   * Durable tracking must have been enabled with durableAckKeepaliveMs.
   */
  waitForDurable(
    response: QwpIngressResponse,
    timeoutMs = this.options.ackTimeoutMs ?? 15_000,
  ): Promise<void> {
    if (this.options.durableAckKeepaliveMs === undefined) {
      return Promise.reject(
        new Error("durable ACK tracking is not enabled for this session"),
      );
    }
    if (response.status !== QWP_STATUS.OK) {
      return Promise.reject(
        new Error("only a successful QWP ACK can be awaited for durability"),
      );
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(
        new RangeError("durable ACK timeout must be a positive finite number"),
      );
    }
    const targets = new Map(
      response.tables.map((table) => [table.name, table.sequenceTransaction]),
    );
    if (this.areDurableTargetsCovered(targets)) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const pending: PendingDurableResponse = { targets, resolve, reject };
      pending.timer = setTimeout(() => {
        if (!this.durableWaiters.delete(pending)) return;
        const error = new Error("timed out waiting for QWP durable ACK");
        reject(error);
        this.recordError(error, false);
      }, timeoutMs);
      this.durableWaiters.add(pending);
    });
  }

  /**
   * Prompts the server to publish its latest durable-ingress watermarks.
   * Node transports use a WebSocket PING; browsers send the protocol-level
   * table-less durable-ACK poll frame. Browser completion means the control
   * frame was published; durable progress arrives independently because the
   * server may withhold its cumulative OK while a transaction remains open.
   */
  pollDurableAck(): Promise<void> {
    this.throwIfUnavailable();
    return this.connection.ping
      ? this.connection.ping()
      : this.publishBrowserDurableAckPoll();
  }

  /**
   * Publishes a browser control poll without an ordinary ACK deadline.
   *
   * QuestDB can answer this frame with durable progress but deliberately defer
   * its cumulative OK while an earlier transaction is still open. Retaining an
   * untimed internal waiter preserves NACK handling and lets a later cumulative
   * OK retire the poll sequence; callers only wait for local publication.
   */
  private publishBrowserDurableAckPoll(): Promise<void> {
    const poll = this.startFrameWithPublication(
      encodeQwpDurableAckPollFrame(),
      this.sendTail,
      false,
    );
    void poll.acknowledgement.catch((error: unknown) => {
      if (this.closing || this.failure) return;
      this.fail(error);
    });
    return poll.publication;
  }

  /** @internal Registers runtime-specific cleanup owned by this session. */
  registerCloseHook(hook: () => void | Promise<void>): void {
    if (this.closing) {
      throw new QwpIngressSessionClosedError();
    }
    this.closeHooks.push(hook);
  }

  close(code = 1000, reason = ""): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeNow(code, reason);
    return this.closePromise;
  }

  private async closeNow(code: number, reason: string): Promise<void> {
    this.closing = true;
    this.clearDurablePoll();
    this.rejectAll(new QwpIngressSessionClosedError());
    const closeHooks = this.closeHooks.splice(0).map((hook) =>
      Promise.resolve()
        .then(hook)
        .catch(() => undefined),
    );
    let transportClose: Promise<void>;
    try {
      transportClose = this.connection.close(code, reason);
    } catch (error) {
      transportClose = Promise.reject(error);
    }
    const [, closeResult] = await Promise.allSettled([
      this.sendTail,
      transportClose,
      this.receiveLoop,
      ...closeHooks,
    ]);
    await Promise.all([
      this.progressDispatcher?.close(),
      this.errorDispatcher?.close(),
    ]);
    if (closeResult.status === "rejected") throw closeResult.reason;
  }

  private async consumeMessages(): Promise<void> {
    try {
      for await (const payload of this.connection.messages) {
        this.handleResponse(decodeQwpIngressResponse(payload));
      }
      if (!this.closing) {
        this.fail(
          new QwpIngressSessionClosedError(await this.connection.closed),
        );
      }
    } catch (error) {
      this.fail(error);
      if (error instanceof QwpProtocolError) {
        void this.connection.close(1002, "invalid QWP response");
      }
    }
  }

  private handleResponse(response: QwpIngressResponse): void {
    this.dispatchProgressCallback(this.options.onResponse, response);
    if (response.status === QWP_STATUS.DURABLE_ACK) {
      this.totalDurableAcks++;
      const advanced = this.applyDurableAck(response);
      this.dispatchProgressCallback(this.options.onDurableAck, response);
      if (advanced) {
        this.emitProgress(
          QWP_INGRESS_PROGRESS_KIND.DURABLE_ACKNOWLEDGED,
          undefined,
          response,
        );
      }
      return;
    }
    if (response.sequence === null) {
      throw new QwpProtocolError("QWP response is missing its wire sequence");
    }
    if (response.status === QWP_STATUS.OK) {
      this.totalAcks++;
      this.trackDurableFrame(response);
      this.trackDurableTargets(response);
      for (const [sequence, pending] of this.pending) {
        if (sequence > response.sequence) break;
        this.pending.delete(sequence);
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(response);
      }
      if (response.sequence > this.acknowledgedSequence) {
        this.acknowledgedSequence = response.sequence;
        this.emitProgress(
          QWP_INGRESS_PROGRESS_KIND.ACKNOWLEDGED,
          response.sequence,
          response,
        );
      }
      this.resolveAcknowledgedSequenceWaiters();
      return;
    }

    this.totalNacks++;
    const pending = this.pending.get(response.sequence);
    const fsn = this.connection.getIngressFrameSequence?.(response.sequence);
    const senderError = createQwpSenderError(response, {
      appliedPolicy: this.connection.managesIngressSenderErrors
        ? undefined
        : QWP_SENDER_ERROR_POLICY.TERMINAL,
      fromFsn: fsn ?? response.sequence,
      toFsn: fsn ?? response.sequence,
    });
    const error = new QwpIngressNackError(response, senderError);
    if (
      !this.acknowledgementRejection ||
      response.sequence < this.acknowledgementRejection.sequence
    ) {
      this.acknowledgementRejection = { sequence: response.sequence, error };
    }
    if (pending) {
      this.pending.delete(response.sequence);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.rejectAcknowledgedSequenceWaitersThrough(response.sequence, error);
    const dictionaryGap =
      this.deltaSymbolsPublished &&
      response.status === QWP_STATUS.DICTIONARY_GAP;
    this.recordError(error, dictionaryGap, response, senderError);
    if (dictionaryGap) {
      // This wire cannot repair a missing prefix without reconnect catch-up.
      this.fail(error, true);
      void this.connection.close(1002, "QWP symbol dictionary gap");
    }
  }

  private dispatchProgressCallback<T>(
    callback: ((event: T) => void) | undefined,
    event: T,
  ): void {
    if (!callback || !this.progressDispatcher) return;
    this.progressDispatcher.offer(() => safelyInvoke(callback, event));
  }

  private emitProgress(
    kind: QwpIngressProgressKind,
    sequence?: bigint,
    response?: QwpIngressResponse,
  ): void {
    this.dispatchProgressCallback(this.options.onProgress, {
      kind,
      timestampMs: Date.now(),
      sequence,
      response,
      metrics: this.metrics,
    });
  }

  private recordError(
    error: unknown,
    terminal: boolean,
    response?: QwpIngressResponse,
    senderError?: QwpSenderError,
  ): Error {
    const observed =
      error instanceof Error
        ? error
        : new Error(`QWP ingress failed: ${error}`);
    this.lastError = observed;
    this.totalErrors++;
    const event: QwpIngressErrorEvent = {
      error: observed,
      terminal,
      timestampMs: Date.now(),
      response,
      senderError,
      metrics: this.metrics,
    };
    const notify = (): void => {
      safelyInvoke(this.options.onError, event);
      if (senderError && !this.connection.managesIngressSenderErrors) {
        safelyInvoke(
          this.options.onSenderError ?? defaultQwpSenderErrorHandler,
          senderError,
        );
      } else if (!senderError && !this.options.onError) {
        safelyInvoke(
          defaultQwpIngressErrorHandler,
          Object.freeze({ terminal, error: observed }),
        );
      }
    };
    if (this.errorDispatcher) this.errorDispatcher.offer(notify);
    else notify();
    return observed;
  }

  private trackDurableTargets(response: QwpIngressResponse): void {
    if (this.options.durableAckKeepaliveMs === undefined) return;
    for (const table of response.tables) {
      const durable = this.durableWatermarks.get(table.name);
      if (durable !== undefined && durable >= table.sequenceTransaction) {
        continue;
      }
      const pending = this.pendingDurableTargets.get(table.name);
      if (pending === undefined || table.sequenceTransaction > pending) {
        this.pendingDurableTargets.set(table.name, table.sequenceTransaction);
      }
    }
    this.scheduleDurablePoll();
  }

  private trackDurableFrame(response: QwpIngressResponse): void {
    if (!this.connection.handshake.durableAckEnabled) return;
    this.durableFrameTargets.set(
      response.sequence!,
      new Map(
        response.tables.map((table) => [table.name, table.sequenceTransaction]),
      ),
    );
    this.advanceDurableFrameWatermark();
  }

  private applyDurableAck(response: QwpIngressResponse): boolean {
    let advanced = false;
    for (const table of response.tables) {
      const watermark = this.durableWatermarks.get(table.name);
      if (watermark === undefined || table.sequenceTransaction > watermark) {
        this.durableWatermarks.set(table.name, table.sequenceTransaction);
        advanced = true;
      }
      const target = this.pendingDurableTargets.get(table.name);
      if (target !== undefined && table.sequenceTransaction >= target) {
        this.pendingDurableTargets.delete(table.name);
      }
    }

    for (const waiter of this.durableWaiters) {
      if (!this.areDurableTargetsCovered(waiter.targets)) continue;
      this.durableWaiters.delete(waiter);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve();
    }
    const frameAdvanced = this.advanceDurableFrameWatermark();
    this.resolveAcknowledgedSequenceWaiters();
    if (this.pendingDurableTargets.size === 0) {
      this.clearDurablePoll();
    } else {
      this.scheduleDurablePoll();
    }
    return advanced || frameAdvanced;
  }

  private advanceDurableFrameWatermark(): boolean {
    let advanced = false;
    for (const [sequence, targets] of this.durableFrameTargets) {
      if (!this.areDurableTargetsCovered(targets)) break;
      this.durableFrameTargets.delete(sequence);
      if (sequence > this.durableAcknowledgedSequence) {
        this.durableAcknowledgedSequence = sequence;
        advanced = true;
      }
    }
    return advanced;
  }

  private resolveAcknowledgedSequenceWaiters(): void {
    const acknowledged = this.acknowledgedFrameSequence;
    for (const pending of this.acknowledgedSequenceWaiters) {
      if (pending.targetSequence > acknowledged) continue;
      this.acknowledgedSequenceWaiters.delete(pending);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve();
    }
  }

  private acknowledgementFailure(
    targetSequence: bigint,
  ): QwpIngressNackError | undefined {
    const rejection = this.acknowledgementRejection;
    return rejection && rejection.sequence <= targetSequence
      ? rejection.error
      : undefined;
  }

  private rejectAcknowledgedSequenceWaitersThrough(
    sequence: bigint,
    error: Error,
  ): void {
    for (const pending of this.acknowledgedSequenceWaiters) {
      if (pending.targetSequence < sequence) continue;
      this.acknowledgedSequenceWaiters.delete(pending);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private areDurableTargetsCovered(
    targets: ReadonlyMap<string, bigint>,
  ): boolean {
    for (const [table, target] of targets) {
      const watermark = this.durableWatermarks.get(table);
      if (watermark === undefined || watermark < target) return false;
    }
    return true;
  }

  private scheduleDurablePoll(): void {
    const interval = this.options.durableAckKeepaliveMs;
    if (
      interval === undefined ||
      interval === 0 ||
      this.pendingDurableTargets.size === 0 ||
      this.durablePollTimer
    ) {
      return;
    }
    this.durablePollTimer = setTimeout(() => {
      this.durablePollTimer = undefined;
      if (
        this.closing ||
        this.failure ||
        this.pendingDurableTargets.size === 0
      ) {
        return;
      }
      const poll = this.connection.ping
        ? this.connection.ping()
        : this.publishBrowserDurableAckPoll();
      void poll
        .then(() => this.scheduleDurablePoll())
        .catch((error: unknown) => this.fail(error));
    }, interval);
  }

  private clearDurablePoll(): void {
    if (!this.durablePollTimer) return;
    clearTimeout(this.durablePollTimer);
    this.durablePollTimer = undefined;
  }

  private throwIfUnavailable(): void {
    if (this.failure) throw this.failure;
    if (this.closing) throw new QwpIngressSessionClosedError();
  }

  private fail(error: unknown, alreadyObserved = false): void {
    if (this.failure) return;
    this.clearDurablePoll();
    this.failure = alreadyObserved
      ? error instanceof Error
        ? error
        : new Error(`QWP ingress failed: ${error}`)
      : this.recordError(error, true);
    this.rejectAll(this.failure);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const pending of this.durableWaiters) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.durableWaiters.clear();
    for (const pending of this.acknowledgedSequenceWaiters) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.acknowledgedSequenceWaiters.clear();
  }
}

function defaultQwpIngressErrorHandler(event: {
  readonly terminal: boolean;
  readonly error: Error;
}): void {
  log(
    event.terminal ? "error" : "warn",
    `QWP ingress ${event.terminal ? "terminated" : "reported an asynchronous failure"} [message=${event.error.message}]`,
  );
}
