import {
  decodeQwpFrame,
  decodeQwpIngressResponse,
  decodeQwpIngressSymbolDictionaryDelta,
  encodeQwpIngressSymbolDictionaryFrame,
  QWP_FLAG_DEFER_COMMIT,
  QWP_FLAG_DELTA_SYMBOL_DICTIONARY,
  QWP_FLAG_DURABLE_ACK_POLL,
  QWP_HEADER_SIZE,
  QWP_STATUS,
  QwpProtocolError,
  qwpVarintSize,
  utf8Length,
} from "../_core";
import {
  QWP_INITIAL_CONNECT_MODE,
  QWP_RECONNECT_EVENT_KIND,
  QWP_UPGRADE_ERROR_KIND,
  QwpBinaryConnection,
  QwpConnectionCloseInfo,
  QwpConnectionFactory,
  QwpDurableAckUnavailableError,
  QwpFailoverError,
  QwpHandshakeMetadata,
  QwpIngressReplayRecord,
  QwpIngressReplayReference,
  QwpIngressReplayStore,
  QwpIngressTransportMetrics,
  QwpInitialConnectMode,
  QwpMemoryReplayAppendTimeoutError,
  QwpMemoryReplayFrameTooLargeError,
  QwpReconnectEvent,
  QwpReconnectExhaustedError,
  QwpReconnectOptions,
  QwpReplayDictionaryError,
  QwpReplayDictionaryPersistenceError,
  QwpReplayRejectedError,
  QwpSendClosedError,
  QwpUnrecoverableReplayDictionaryError,
  QwpUpgradeError,
} from "../transport";
import { QwpAsyncQueue } from "./async-queue";
import { jitterReconnectDelayMs } from "./reconnect-backoff";
import { awaitReconnectDeadline } from "./reconnect-deadline";
import { QwpNotificationDispatcher } from "./notification-dispatcher";
import {
  createQwpDataLossSenderError,
  createQwpProtocolViolationSenderError,
  createQwpSenderError,
  defaultQwpSenderErrorHandler,
  qwpSenderErrorCategory,
  QWP_SENDER_ERROR_CATEGORY,
  type QwpSenderError,
} from "../sender-error";

/**
 * The ingress reconnect policy applied when a field is not configured.
 *
 * QwpIngressSession.connect() spreads this under the caller's options, and the
 * constructor below reads every field from the merged result, so the two layers
 * cannot disagree. They used to: the session default object was replaced
 * wholesale by any partial `reconnect`, and the constructor's own per-field
 * fallbacks then supplied maxAttempts 3 and maxDurationMs 30s instead of the
 * unlimited/5-minute policy the session promises. Setting one documented key --
 * `reconnect_max_duration_millis`, say, which QWP.md presents as the ws/wss
 * replacement for ILP's `retry_timeout` -- therefore capped a running sender at
 * three reconnect attempts and latched it terminal during a transient outage.
 */
export const QWP_DEFAULT_INGRESS_RECONNECT_OPTIONS: Readonly<
  Required<Omit<QwpReconnectOptions, "onEvent">>
> = {
  /** Zero is unlimited: a running producer must outlast any outage. */
  maxAttempts: 0,
  initialBackoffMs: 100,
  maxBackoffMs: 5_000,
  maxDurationMs: 300_000,
  maxFrameRejections: 4,
  poisonMinEscalationWindowMs: 300_000,
};

/** Byte offset of the flags field inside the 12-byte QWP frame header. */
const QWP_FLAGS_OFFSET = 5;

/** Peeks the deferred-commit flag without decoding or copying the payload. */
function defersCommit(payload: Uint8Array): boolean {
  return (
    payload.byteLength > QWP_FLAGS_OFFSET &&
    (payload[QWP_FLAGS_OFFSET] & QWP_FLAG_DEFER_COMMIT) !== 0
  );
}

const DEFAULT_CATCH_UP_CAP_GAP_MIN_ESCALATION_WINDOW_MS = 300_000;
const MAX_CATCH_UP_CAP_GAP_ATTEMPTS = 16;
const DEFAULT_ORPHAN_DURABLE_ACK_MISMATCH_MAX_DURATION_MS = 300_000;
const MAX_ORPHAN_DURABLE_ACK_MISMATCH_ATTEMPTS = 16;
const DEFAULT_MEMORY_REPLAY_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_MEMORY_REPLAY_APPEND_DEADLINE_MS = 30_000;
// Charge a conservative fixed amount so even empty/very small opaque frames
// cannot grow the replay Map without bound. Payload arrays are not copied by
// the store, so the configured budget primarily tracks live frame storage.
const MEMORY_REPLAY_RECORD_OVERHEAD_BYTES = 64;

type ConnectAttemptPolicy = "single" | "configured" | "unbounded";

export class QwpCatchUpCapGapError extends RangeError {
  constructor(
    readonly symbolId: number,
    readonly frameLength: number,
    readonly maxBatchSizeBytes: number,
    details?: {
      attempt: number;
      episodeMs: number;
      minEscalationWindowMs: number;
      exhausted: boolean;
    },
  ) {
    super(
      `symbol dictionary entry exceeds reconnect target batch cap [id=${symbolId}, frameLength=${frameLength}, max=${maxBatchSizeBytes}` +
        (details
          ? `, attempt=${details.attempt}/${MAX_CATCH_UP_CAP_GAP_ATTEMPTS}, episodeMs=${details.episodeMs}/${details.minEscalationWindowMs}]${
              details.exhausted
                ? "; the data must be resent after the cap is raised"
                : "; retrying because a larger-cap node may return"
            }`
          : "]"),
    );
    this.name = "QwpCatchUpCapGapError";
  }
}

export class QwpDurableAckPersistentFailureError extends Error {
  constructor(
    readonly attempts: number,
    readonly episodeMs: number,
    readonly cause: QwpDurableAckUnavailableError,
  ) {
    super(
      `QWP durable ACK remained unavailable for an orphan replay slot [attempts=${attempts}/${MAX_ORPHAN_DURABLE_ACK_MISMATCH_ATTEMPTS}, episodeMs=${episodeMs}]: ${cause.message}`,
    );
    this.name = "QwpDurableAckPersistentFailureError";
  }
}

interface ReplayFrame extends Omit<QwpIngressReplayReference, "frameSequence"> {
  // Assigned inside send()'s serialized tail, immediately before the journal
  // append, so a frame that never reaches the store consumes no sequence.
  frameSequence: bigint;
  payload?: Uint8Array;
  readonly clientSequence?: bigint;
  ackDelivered: boolean;
  transmitted: boolean;
  durableTargets?: Map<string, bigint>;
  dictionaryCatchup?: boolean;
  /**
   * The frame carries QWP_FLAG_DEFER_COMMIT, so QuestDB deliberately withholds
   * its cumulative ACK until the transaction commits. Read from the frame
   * header rather than passed in, so it survives a journal round-trip and is
   * still known for frames recovered after a restart.
   */
  deferCommit?: boolean;
}

type LoadedReplayRecord = QwpIngressReplayReference & {
  readonly payload?: Uint8Array;
};

type LazyReplayStore = QwpIngressReplayStore &
  Required<Pick<QwpIngressReplayStore, "loadReferences" | "readPayload">>;

interface RecoveredDiscardTail {
  readonly startSequence: bigint;
  readonly tipSequence: bigint;
  readonly predecessorSequence?: bigint;
}

interface CapacityWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  // Assigned immediately after the waiter is built: the timeout callback
  // closes over the waiter, so the object has to exist first. Optional
  // rather than asserted, because between those two statements it genuinely
  // holds no timer, and clearTimeout() accepts undefined.
  timer?: ReturnType<typeof setTimeout>;
}

class RetriableIngressNackError extends Error {
  constructor(
    readonly frameSequence: bigint,
    readonly status: number,
    readonly retryDelayMs: number,
    message?: string,
  ) {
    super(
      `QuestDB temporarily rejected QWP frame [frameSequence=${frameSequence}, status=0x${status.toString(16)}]${
        message ? `: ${message}` : ""
      }`,
    );
    this.name = "RetriableIngressNackError";
  }
}

class RetriableIngressConnectionError extends Error {
  readonly cause: unknown;

  constructor(
    readonly retryDelayMs: number,
    cause: unknown,
  ) {
    super(
      cause instanceof Error
        ? cause.message
        : `QWP ingress connection was lost: ${cause}`,
    );
    this.name = "RetriableIngressConnectionError";
    this.cause = cause;
  }
}

class QwpMemoryReplayStore implements QwpIngressReplayStore {
  private readonly records = new Map<bigint, Uint8Array>();
  private readonly symbols: string[] = [];
  private readonly capacityWaiters = new Set<CapacityWaiter>();
  private usedBytes = 0;
  private closing = false;
  private totalBackpressureStalls = 0;
  private totalAppendTimeouts = 0;

  constructor(
    readonly maxBytes = DEFAULT_MEMORY_REPLAY_MAX_BYTES,
    private readonly appendDeadlineMs = DEFAULT_MEMORY_REPLAY_APPEND_DEADLINE_MS,
  ) {}

  get metrics() {
    return {
      maxBytes: this.maxBytes,
      usedBytes: this.usedBytes,
      waitingAppends: this.capacityWaiters.size,
      totalBackpressureStalls: this.totalBackpressureStalls,
      totalAppendTimeouts: this.totalAppendTimeouts,
    } as const;
  }

  async load(): Promise<readonly QwpIngressReplayRecord[]> {
    return Array.from(this.records, ([frameSequence, payload]) => ({
      frameSequence,
      payload: payload.slice(),
    }));
  }

  async append(record: QwpIngressReplayRecord): Promise<void> {
    if (this.closing) throw new QwpSendClosedError();
    if (this.records.has(record.frameSequence)) {
      throw new Error(
        `QWP memory replay sequence already exists [frameSequence=${record.frameSequence}]`,
      );
    }
    const requiredBytes =
      record.payload.byteLength + MEMORY_REPLAY_RECORD_OVERHEAD_BYTES;
    if (requiredBytes > this.maxBytes) {
      throw new QwpMemoryReplayFrameTooLargeError(
        this.maxBytes,
        record.payload.byteLength,
        requiredBytes,
      );
    }
    if (this.usedBytes + requiredBytes > this.maxBytes) {
      this.totalBackpressureStalls++;
      const deadline = Date.now() + this.appendDeadlineMs;
      while (this.usedBytes + requiredBytes > this.maxBytes) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          this.totalAppendTimeouts++;
          throw new QwpMemoryReplayAppendTimeoutError(
            this.maxBytes,
            this.usedBytes,
            requiredBytes,
            this.appendDeadlineMs,
          );
        }
        await this.waitForCapacity(remainingMs, requiredBytes);
        if (this.closing) throw new QwpSendClosedError();
      }
    }
    // send() already made the replay-owned payload copy. Sharing it between
    // the connection and this accounting store avoids doubling the backlog.
    this.records.set(record.frameSequence, record.payload);
    this.usedBytes += requiredBytes;
  }

  async acknowledgeThrough(frameSequence: bigint): Promise<void> {
    for (const sequence of this.records.keys()) {
      if (sequence > frameSequence) break;
      const payload = this.records.get(sequence)!;
      this.usedBytes -=
        payload.byteLength + MEMORY_REPLAY_RECORD_OVERHEAD_BYTES;
      this.records.delete(sequence);
    }
    this.releaseCapacityWaiters();
  }

  async loadSymbolDictionary(): Promise<readonly string[]> {
    return this.symbols.slice();
  }

  async appendSymbolDictionary(
    startId: number,
    entries: readonly string[],
  ): Promise<void> {
    if (startId !== this.symbols.length) {
      throw new QwpReplayDictionaryError(
        `memory replay dictionary is not dense [expected=${this.symbols.length}, received=${startId}]`,
      );
    }
    this.symbols.push(...entries);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const error = new QwpSendClosedError();
    for (const waiter of this.capacityWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.capacityWaiters.clear();
    this.records.clear();
    this.symbols.length = 0;
    this.usedBytes = 0;
  }

  private waitForCapacity(
    timeoutMs: number,
    requiredBytes: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter: CapacityWaiter = {
        resolve: () => {
          clearTimeout(waiter.timer);
          this.capacityWaiters.delete(waiter);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(waiter.timer);
          this.capacityWaiters.delete(waiter);
          reject(error);
        },
        timer: undefined,
      };
      waiter.timer = setTimeout(() => {
        this.totalAppendTimeouts++;
        waiter.reject(
          new QwpMemoryReplayAppendTimeoutError(
            this.maxBytes,
            this.usedBytes,
            requiredBytes,
            this.appendDeadlineMs,
          ),
        );
      }, timeoutMs);
      this.capacityWaiters.add(waiter);
    });
  }

  private releaseCapacityWaiters(): void {
    for (const waiter of [...this.capacityWaiters]) waiter.resolve();
  }
}

/**
 * Reconnects an ingress wire and translates its per-connection ACK sequence
 * back to stable replay records. Replay is deliberately at-least-once: a frame
 * accepted by the server whose ACK was lost may be sent again.
 */
export class QwpReconnectingIngressConnection implements QwpBinaryConnection {
  private readonly messagesQueue = new QwpAsyncQueue<Uint8Array>();
  private readonly frames = new Map<bigint, ReplayFrame>();
  private readonly durableWatermarks = new Map<string, bigint>();
  private readonly symbolDictionary: string[];
  private readonly store: QwpIngressReplayStore;
  private readonly lazyReplayStore?: LazyReplayStore;
  private readonly maxAttempts: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxDurationMs: number;
  private readonly maxFrameRejections: number;
  private readonly poisonMinEscalationWindowMs: number;
  private readonly catchUpCapGapMinEscalationWindowMs: number;
  private readonly orphanDurableAckMismatchMaxDurationMs: number;
  private readonly localMaxBatchSizeBytes?: number;
  private readonly connectionDispatcher?: QwpNotificationDispatcher<QwpReconnectEvent>;
  private readonly errorDispatcher?: QwpNotificationDispatcher<QwpSenderError>;
  private readonly resolveClosed: (info: QwpConnectionCloseInfo) => void;
  private connection?: QwpBinaryConnection;
  private connectingCandidate?: QwpBinaryConnection;
  private connectAbort?: AbortController;
  private lastHandshake?: QwpHandshakeMetadata;
  private lastEndpoint?: string | URL;
  // Wire log for the current connection, indexed by wire sequence minus
  // wireFramesBase. Acknowledged frames are dropped and the base advances, so
  // the log stays proportional to what is still unacknowledged rather than to
  // everything ever sent on the connection.
  private wireFrames: ReplayFrame[] = [];
  private wireFramesBase = 0;
  private nextFrameSequence = 0n;
  private nextClientSequence = 0n;
  private publishedFrameSequence = -1n;
  private acknowledgedFrameSequence = -1n;
  private highestOkFrameSequence = -1n;
  private poisonFrameSequence?: bigint;
  private poisonFirstStrikeMs = 0;
  private poisonStrikes = 0;
  /** Elapsed connection-outage time withheld from the escalation window. */
  private poisonOutageMs = 0;
  private poisonOutageStartedMs = 0;
  private catchUpCapGapAttempts = 0;
  private catchUpCapGapFirstMs = 0;
  private durableAckMismatchAttempts = 0;
  private durableAckMismatchFirstMs = 0;
  private progressAtLastExemptRecycle = -1n;
  private zeroProgressRecycles = 0;
  private recoveredDiscardTail?: RecoveredDiscardTail;
  private generation = 0;
  private sendTail: Promise<void> = Promise.resolve();
  private drainTail: Promise<void> = Promise.resolve();
  private reconnectTask?: Promise<void>;
  private storeClosePromise?: Promise<void>;
  private terminalError?: Error;
  private cancelBackoff?: () => void;
  private closing = false;
  private closedSettled = false;
  private totalFramesSent = 0;
  private totalBytesSent = 0;
  private totalFramesReplayed = 0;
  private totalBytesReplayed = 0;
  private totalReconnectAttempts = 0;
  private totalReconnectsSucceeded = 0;
  private totalFailovers = 0;
  private totalReconnectErrors = 0;
  private totalServerNacks = 0;
  private hasEverConnected = false;
  private deltaSymbolDictionaryEnabled: boolean;
  readonly messages: AsyncIterable<Uint8Array> = this.messagesQueue;
  readonly closed: Promise<QwpConnectionCloseInfo>;
  readonly managesIngressSenderErrors = true;
  ping?: () => Promise<void>;

  private constructor(
    private readonly factory: QwpConnectionFactory,
    private readonly reconnectOptions: QwpReconnectOptions,
    store: QwpIngressReplayStore,
    records: readonly LoadedReplayRecord[],
    symbolDictionary: readonly string[],
    recoveredDiscardTail: RecoveredDiscardTail | undefined,
    localMaxBatchSizeBytes?: number,
    private readonly backgroundStoreAndForward = false,
    private readonly orphanStoreAndForward = false,
    orphanDurableAckMismatchMaxDurationMs = DEFAULT_ORPHAN_DURABLE_ACK_MISMATCH_MAX_DURATION_MS,
    catchUpCapGapMinEscalationWindowMs = DEFAULT_CATCH_UP_CAP_GAP_MIN_ESCALATION_WINDOW_MS,
    connectionListenerInboxCapacity = 64,
    errorInboxCapacity = 256,
    onSenderError?: (error: QwpSenderError) => void,
    /**
     * Whether the caller actually asked for durable progress. The handshake
     * flag alone is the server's answer, not the client's question, and only
     * the question decides which watermark this connection maintains.
     */
    private readonly durableAckTracked = true,
  ) {
    this.store = store;
    this.lazyReplayStore = isLazyReplayStore(store) ? store : undefined;
    this.symbolDictionary = [...symbolDictionary];
    this.deltaSymbolDictionaryEnabled =
      store.loadSymbolDictionary !== undefined &&
      store.appendSymbolDictionary !== undefined;
    this.recoveredDiscardTail = recoveredDiscardTail;
    this.localMaxBatchSizeBytes = localMaxBatchSizeBytes;
    const defaults = QWP_DEFAULT_INGRESS_RECONNECT_OPTIONS;
    this.maxAttempts = reconnectOptions.maxAttempts ?? defaults.maxAttempts;
    this.initialBackoffMs =
      reconnectOptions.initialBackoffMs ?? defaults.initialBackoffMs;
    this.maxBackoffMs = reconnectOptions.maxBackoffMs ?? defaults.maxBackoffMs;
    this.maxDurationMs =
      reconnectOptions.maxDurationMs ?? defaults.maxDurationMs;
    this.maxFrameRejections =
      reconnectOptions.maxFrameRejections ?? defaults.maxFrameRejections;
    // WRITE_ERROR and INTERNAL_ERROR are RETRIABLE by policy, but the only
    // thing separating "this frame is poison" from "the server cannot write
    // right now" is how long the rejection persists. Five seconds did not
    // separate them at all: a concurrent DDL, a checkpoint or a briefly full
    // server volume outlives it easily, and with the reconnect backoff capped
    // at maxBackoffMs four strikes accumulate well inside that window -- so a
    // transient server-side fault permanently killed a running producer.
    this.poisonMinEscalationWindowMs =
      reconnectOptions.poisonMinEscalationWindowMs ??
      defaults.poisonMinEscalationWindowMs;
    this.catchUpCapGapMinEscalationWindowMs =
      catchUpCapGapMinEscalationWindowMs;
    this.orphanDurableAckMismatchMaxDurationMs =
      orphanDurableAckMismatchMaxDurationMs;
    if (reconnectOptions.onEvent) {
      this.connectionDispatcher = new QwpNotificationDispatcher(
        reconnectOptions.onEvent,
        connectionListenerInboxCapacity,
      );
    }
    this.errorDispatcher = new QwpNotificationDispatcher(
      onSenderError ?? defaultQwpSenderErrorHandler,
      errorInboxCapacity,
    );
    validateReconnectPolicy(
      this.maxAttempts,
      this.initialBackoffMs,
      this.maxBackoffMs,
      this.maxDurationMs,
      this.maxFrameRejections,
      this.poisonMinEscalationWindowMs,
      this.catchUpCapGapMinEscalationWindowMs,
    );
    let resolveClosed!: (info: QwpConnectionCloseInfo) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.resolveClosed = resolveClosed;

    let previous = -1n;
    for (const record of records) {
      if (record.frameSequence < 0n || record.frameSequence <= previous) {
        throw new Error(
          "QWP replay store records must have strictly increasing non-negative sequences",
        );
      }
      if (
        !Number.isSafeInteger(record.payloadLength) ||
        record.payloadLength < 0 ||
        (record.payload !== undefined &&
          record.payload.byteLength !== record.payloadLength)
      ) {
        throw new Error(
          `QWP replay store returned an invalid payload length [frameSequence=${record.frameSequence}, payloadLength=${record.payloadLength}]`,
        );
      }
      const frame: ReplayFrame = {
        frameSequence: record.frameSequence,
        payloadLength: record.payloadLength,
        payload: record.payload?.slice(),
        ackDelivered: true,
        transmitted: true,
      };
      this.frames.set(frame.frameSequence, frame);
      previous = frame.frameSequence;
    }
    if (records.length > 0) {
      this.acknowledgedFrameSequence = records[0].frameSequence - 1n;
    }
    this.nextFrameSequence = previous + 1n;
    this.publishedFrameSequence = previous;
  }

  static async connect(
    factory: QwpConnectionFactory,
    reconnectOptions: QwpReconnectOptions,
    replayStore?: QwpIngressReplayStore,
    localMaxBatchSizeBytes?: number,
    memoryReplayMaxBytes = DEFAULT_MEMORY_REPLAY_MAX_BYTES,
    memoryReplayAppendDeadlineMs = DEFAULT_MEMORY_REPLAY_APPEND_DEADLINE_MS,
    backgroundStoreAndForward = false,
    initialConnectMode: QwpInitialConnectMode = backgroundStoreAndForward
      ? QWP_INITIAL_CONNECT_MODE.ASYNC
      : QWP_INITIAL_CONNECT_MODE.SYNC,
    orphanStoreAndForward = false,
    orphanDurableAckMismatchMaxDurationMs = DEFAULT_ORPHAN_DURABLE_ACK_MISMATCH_MAX_DURATION_MS,
    catchUpCapGapMinEscalationWindowMs = DEFAULT_CATCH_UP_CAP_GAP_MIN_ESCALATION_WINDOW_MS,
    initialConnection?: Promise<QwpBinaryConnection>,
    connectionListenerInboxCapacity = 64,
    errorInboxCapacity = 256,
    onSenderError?: (error: QwpSenderError) => void,
    signal?: AbortSignal,
    durableAckTracked = true,
  ): Promise<QwpReconnectingIngressConnection> {
    const store: QwpIngressReplayStore =
      replayStore ??
      new QwpMemoryReplayStore(
        memoryReplayMaxBytes,
        memoryReplayAppendDeadlineMs,
      );
    let connection: QwpReconnectingIngressConnection | undefined;
    // close() aborts this while a connect is still negotiating. Without it the
    // caller returns from close() and this keeps going: a persistent store
    // takes its slot lock after the sender is gone and holds it for the rest
    // of the connect budget, and the abandoned session goes on to send frames
    // and even quarantine directories.
    const abortError = () =>
      signal?.reason ?? new Error("QWP connect was aborted");
    // The caller started `initialConnection` eagerly and nothing observes it
    // until connectLoop's first attempt awaits it, so every path that leaves
    // before that has to disown it here. Skipping this left the promise
    // floating: its rejection became an unhandled rejection -- which Node
    // turns into process exit by default -- fired *after* the caller had
    // already handled the rejection connect() itself returned, and a
    // connection it resolved anyway was leaked instead of closed.
    //
    // Deliberately not awaited. Attaching the handlers is what stops the
    // unhandled rejection, and it takes effect synchronously; waiting for the
    // attempt to settle would let a factory that ignores its signal turn an
    // abort into a hang -- the failure the store-and-forward slot-release
    // test exists to prevent. Nothing is left to sequence after it either:
    // the connection is disowned, so closing it is pure cleanup.
    const disownInitialConnection = (): void => {
      void initialConnection?.then(
        (opened) => opened.close().catch(() => undefined),
        () => undefined,
      );
    };
    if (signal?.aborted) {
      disownInitialConnection();
      throw abortError();
    }
    try {
      const lazyStore = isLazyReplayStore(store) ? store : undefined;
      const records: readonly LoadedReplayRecord[] = lazyStore
        ? await lazyStore.loadReferences()
        : (await store.load()).map((record) => ({
            ...record,
            payloadLength: record.payload.byteLength,
          }));
      const sortedRecords = [...records].sort((a, b) =>
        a.frameSequence < b.frameSequence
          ? -1
          : a.frameSequence > b.frameSequence
            ? 1
            : 0,
      );
      let persistedSymbolDictionary: readonly string[] = [];
      let persistedSymbolDictionaryFailure: unknown;
      if (store.loadSymbolDictionary) {
        try {
          persistedSymbolDictionary = await store.loadSymbolDictionary();
        } catch (error) {
          if (!store.replaceSymbolDictionary) throw error;
          persistedSymbolDictionaryFailure = error;
        }
      }
      const loadPayload = (record: LoadedReplayRecord) =>
        record.payload
          ? Promise.resolve(record.payload)
          : lazyStore!.readPayload(record.frameSequence);
      const recoveredDiscardTail = await analyzeRecoveredDiscardTail(
        sortedRecords,
        loadPayload,
      );
      const symbolDictionary = await recoverSymbolDictionary(
        sortedRecords,
        loadPayload,
        persistedSymbolDictionary,
        recoveredDiscardTail,
        store,
        persistedSymbolDictionaryFailure,
      );
      connection = new QwpReconnectingIngressConnection(
        factory,
        reconnectOptions,
        store,
        sortedRecords,
        symbolDictionary,
        recoveredDiscardTail,
        localMaxBatchSizeBytes,
        backgroundStoreAndForward,
        orphanStoreAndForward,
        orphanDurableAckMismatchMaxDurationMs,
        catchUpCapGapMinEscalationWindowMs,
        connectionListenerInboxCapacity,
        errorInboxCapacity,
        onSenderError,
        durableAckTracked,
      );
      // The store's lock is held from here on, so an abort has something to
      // release and must reach the connect that is about to run.
      if (signal?.aborted) throw abortError();
      const onAbort = () => {
        void connection?.close().catch(() => undefined);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await connection.retireRecoveredDiscardTailIfReady();
        if (
          backgroundStoreAndForward &&
          initialConnectMode === QWP_INITIAL_CONNECT_MODE.ASYNC
        ) {
          connection.startBackgroundConnect();
        } else {
          await connection.connectLoopOrCatchUp(
            initialConnectMode,
            initialConnection,
            backgroundStoreAndForward,
            orphanStoreAndForward,
          );
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      if (signal?.aborted) throw abortError();
      return connection;
    } catch (error) {
      await connection?.close().catch(() => undefined);
      // Unconditional: an abort landing after the connection was constructed
      // -- the aborted() check below it, or the onAbort that closes it out
      // from under connectLoop -- leaves before attempt 1 awaits
      // initialConnection just as surely as a failure before it. Guarding
      // this on `!connection` is what let those two paths orphan it. The
      // connection above is already closed by the time this runs, so closing
      // a candidate it had adopted is a no-op rather than a double free.
      disownInitialConnection();
      if (!connection) {
        await store.close().catch(() => undefined);
      }
      throw error;
    }
  }

  /** The foreground connect, with Java's catch-up fallback around it. */
  private async connectLoopOrCatchUp(
    initialConnectMode: QwpInitialConnectMode,
    initialConnection: Promise<QwpBinaryConnection> | undefined,
    backgroundStoreAndForward: boolean,
    orphanStoreAndForward: boolean,
  ): Promise<void> {
    try {
      await this.connectLoop(
        undefined,
        false,
        initialConnectMode === QWP_INITIAL_CONNECT_MODE.OFF
          ? "single"
          : "configured",
        initialConnection,
      );
    } catch (error) {
      if (
        backgroundStoreAndForward &&
        !orphanStoreAndForward &&
        error instanceof QwpCatchUpCapGapError
      ) {
        // Java returns the foreground sender once the wire has connected,
        // then moves recovered-dictionary catch-up to its unbounded I/O
        // loop. Do the same instead of making OFF/SYNC construction wait
        // forever for a larger-cap node.
        this.startBackgroundConnect();
      } else {
        throw error;
      }
    }
  }

  get handshake(): QwpHandshakeMetadata {
    if (!this.lastHandshake) {
      if (this.backgroundStoreAndForward) return { qwpVersion: 1 };
      throw new Error("QWP connection is not established");
    }
    return this.lastHandshake;
  }

  get endpoint(): string | URL | undefined {
    return this.lastEndpoint;
  }

  get ingressSymbolDictionary(): readonly string[] {
    return this.symbolDictionary.slice();
  }

  get ingressDeltaSymbolDictionaryEnabled(): boolean {
    return this.deltaSymbolDictionaryEnabled;
  }

  getIngressMetrics(): QwpIngressTransportMetrics {
    let pendingReplayBytes = 0;
    for (const frame of this.frames.values()) {
      pendingReplayBytes += frame.payloadLength;
    }
    const memoryMetrics =
      this.store instanceof QwpMemoryReplayStore
        ? this.store.metrics
        : undefined;
    return Object.freeze({
      publishedFrameSequence: this.publishedFrameSequence,
      acknowledgedFrameSequence: this.acknowledgedFrameSequence,
      pendingReplayFrames: this.frames.size,
      pendingReplayBytes,
      memoryReplayMaxBytes: memoryMetrics?.maxBytes,
      memoryReplayUsedBytes: memoryMetrics?.usedBytes,
      waitingMemoryReplayAppends: memoryMetrics?.waitingAppends ?? 0,
      totalMemoryReplayBackpressureStalls:
        memoryMetrics?.totalBackpressureStalls ?? 0,
      totalMemoryReplayAppendTimeouts: memoryMetrics?.totalAppendTimeouts ?? 0,
      totalFramesSent: this.totalFramesSent,
      totalBytesSent: this.totalBytesSent,
      totalFramesReplayed: this.totalFramesReplayed,
      totalBytesReplayed: this.totalBytesReplayed,
      totalReconnectAttempts: this.totalReconnectAttempts,
      totalReconnectsSucceeded: this.totalReconnectsSucceeded,
      totalFailovers: this.totalFailovers,
      totalReconnectErrors: this.totalReconnectErrors,
      totalServerNacks: this.totalServerNacks,
      deliveredConnectionNotifications:
        this.connectionDispatcher?.metrics.delivered ?? 0,
      droppedConnectionNotifications:
        this.connectionDispatcher?.metrics.dropped ?? 0,
      deliveredErrorNotifications: this.errorDispatcher?.metrics.delivered ?? 0,
      droppedErrorNotifications: this.errorDispatcher?.metrics.dropped ?? 0,
    });
  }

  getIngressFrameSequence(clientSequence: bigint): bigint | undefined {
    for (const frame of this.frames.values()) {
      if (frame.clientSequence === clientSequence) return frame.frameSequence;
    }
    return undefined;
  }

  skipIngressClientSequence(): void {
    // Only the client sequence is reserved. The skipped frame never reaches
    // the journal, so consuming a frame sequence here would leave a hole that
    // makes every later append non-contiguous.
    this.nextClientSequence++;
  }

  send(payload: Uint8Array): Promise<void> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.closing) return Promise.reject(new QwpSendClosedError());
    const frame: ReplayFrame = {
      // Placeholder; the real sequence is allocated in the tail below, once
      // the journal has accepted the frame.
      frameSequence: -1n,
      clientSequence: this.nextClientSequence++,
      payload: payload.slice(),
      payloadLength: payload.byteLength,
      ackDelivered: false,
      transmitted: false,
      deferCommit: defersCommit(payload),
    };
    const publishing = this.sendTail.then(async () => {
      this.throwIfUnavailable();
      const delta = readSymbolDictionaryDelta(frame.payload!);
      if (delta) {
        if (!this.deltaSymbolDictionaryEnabled) {
          throw new QwpReplayDictionaryError(
            "QWP delta symbol dictionaries are disabled because replay dictionary persistence is unavailable; encode symbols with full inline dictionaries",
          );
        }
        await this.persistSymbolDictionaryDelta(delta);
      }
      // Sends are serialized on sendTail, so allocating here rather than at
      // call time keeps frame sequences dense and in append order. A rejected
      // append -- an exhausted journal, a missed append deadline -- must not
      // consume one: the store enforces contiguity, so a hole would make every
      // later append fail until the journal drained completely.
      const frameSequence = this.nextFrameSequence;
      await this.store.append({
        frameSequence,
        payload: frame.payload!,
      });
      this.nextFrameSequence = frameSequence + 1n;
      frame.frameSequence = frameSequence;
      this.frames.set(frame.frameSequence, frame);
      this.publishedFrameSequence = frame.frameSequence;
      if (this.backgroundStoreAndForward) {
        if (this.lazyReplayStore) frame.payload = undefined;
        this.enqueueDrain(frame);
        return;
      }
      try {
        await this.transmit(frame);
      } catch (error) {
        this.failTerminal(error);
        throw error;
      }
    });
    this.sendTail = publishing.catch(() => undefined);
    return publishing;
  }

  private enqueueDrain(frame: ReplayFrame): void {
    const draining = this.drainTail.then(async () => {
      if (this.closing) return;
      await this.transmit(frame);
    });
    this.drainTail = draining.catch((error: unknown) => {
      if (!this.closing) this.failTerminal(error);
    });
  }

  private startBackgroundConnect(): void {
    const connecting = this.connectLoop(undefined, false, "unbounded");
    this.reconnectTask = connecting;
    void connecting
      .catch((error: unknown) => {
        if (!this.closing) this.failTerminal(error);
      })
      .finally(() => {
        if (this.reconnectTask === connecting) this.reconnectTask = undefined;
      });
  }

  async close(code = 1000, reason = ""): Promise<void> {
    if (this.closing) {
      await this.closed;
      return;
    }
    this.closing = true;
    this.cancelBackoff?.();
    this.messagesQueue.end();
    const connection = this.connection;
    // Tears down a connect that is still negotiating. Without this the socket
    // and its deadline outlive close(), keeping the event loop open for up to
    // connectTimeoutMs/authTimeoutMs after close() has already resolved.
    this.connectAbort?.abort();
    const connectingCandidate = this.connectingCandidate;
    this.connection = undefined;
    this.connectingCandidate = undefined;
    let closeInfo: QwpConnectionCloseInfo = {
      code,
      reason,
      wasClean: code === 1000,
    };
    if (connection) {
      try {
        await connection.close(code, reason);
        closeInfo = await connection.closed;
      } catch {
        // The persistent store still has to close after a transport close race.
      }
    }
    if (connectingCandidate && connectingCandidate !== connection) {
      await connectingCandidate.close(code, reason).catch(() => undefined);
    }
    try {
      await this.closeStore();
    } finally {
      this.releaseMemoryReplayReferences();
      await Promise.all([
        this.connectionDispatcher?.close(),
        this.errorDispatcher?.close(),
      ]);
      this.settleClosed(closeInfo);
    }
  }

  private async connectLoop(
    initialCause: unknown,
    reconnecting: boolean,
    attemptPolicy: ConnectAttemptPolicy = this.backgroundStoreAndForward
      ? "unbounded"
      : "configured",
    initialConnection?: Promise<QwpBinaryConnection>,
  ): Promise<void> {
    const outageStarted = Date.now();
    const reconnectDeadlineMs =
      attemptPolicy === "configured" && this.maxDurationMs > 0
        ? outageStarted + this.maxDurationMs
        : undefined;
    const previousEndpoint = this.lastEndpoint;
    let attempt = 0;
    let backoffMs = this.initialBackoffMs;
    let lastError = initialCause;
    let primaryUnavailableAttempts = 0;
    if (reconnecting) {
      this.emitEvent({
        kind: QWP_RECONNECT_EVENT_KIND.RECONNECTING,
        attempt: 0,
        previousEndpoint,
        cause: initialCause,
      });
    }

    const initialRetryDelayMs = reconnectDelayMs(initialCause);
    if (initialRetryDelayMs > 0) {
      await this.waitForBackoffWithinDeadline(
        jitterReconnectDelayMs(initialRetryDelayMs),
        reconnectDeadlineMs,
        attempt,
      );
    } else if (reconnecting && backoffMs > 0) {
      await this.waitForBackoffWithinDeadline(
        jitterReconnectDelayMs(backoffMs),
        reconnectDeadlineMs,
        attempt,
      );
      backoffMs = Math.min(Math.max(backoffMs * 2, 1), this.maxBackoffMs);
    }

    while (!this.closing) {
      if (attempt > 0 && backoffMs > 0) {
        await this.waitForBackoffWithinDeadline(
          jitterReconnectDelayMs(backoffMs),
          reconnectDeadlineMs,
          attempt,
        );
        backoffMs = Math.min(Math.max(backoffMs * 2, 1), this.maxBackoffMs);
      }
      this.throwIfUnavailable();
      attempt++;
      if (reconnecting) this.totalReconnectAttempts++;
      let candidate: QwpBinaryConnection | undefined;
      try {
        if (attempt === 1 && initialConnection) {
          candidate = await awaitReconnectDeadline(
            initialConnection,
            reconnectDeadlineMs,
            attempt,
            () => undefined,
            (opened) => void opened.close().catch(() => undefined),
          );
        } else {
          const abort = new AbortController();
          this.connectAbort = abort;
          try {
            candidate = await awaitReconnectDeadline(
              this.factory(abort.signal),
              reconnectDeadlineMs,
              attempt,
              () => abort.abort(),
              (opened) => void opened.close().catch(() => undefined),
            );
          } finally {
            if (this.connectAbort === abort) this.connectAbort = undefined;
          }
        }
        this.hasEverConnected = true;
        this.connectingCandidate = candidate;
        if (this.closing) {
          await candidate.close().catch(() => undefined);
          throw new QwpSendClosedError();
        }
        const replayed = await awaitReconnectDeadline(
          this.replayInto(candidate),
          reconnectDeadlineMs,
          attempt,
          () => void candidate?.close().catch(() => undefined),
        );
        if (this.closing) throw new QwpSendClosedError();
        this.install(candidate, replayed);
        // The server is reachable again, so the escalation window resumes.
        this.endPoisonOutage();
        this.resetCatchUpCapGapEpisode();
        this.resetDurableAckMismatchEpisode();
        this.connectingCandidate = undefined;
        if (reconnecting) {
          this.totalReconnectsSucceeded++;
          const failedOver =
            previousEndpoint !== undefined &&
            String(previousEndpoint) !== String(candidate.endpoint);
          if (failedOver) this.totalFailovers++;
          this.emitEvent({
            kind: failedOver
              ? QWP_RECONNECT_EVENT_KIND.FAILED_OVER
              : QWP_RECONNECT_EVENT_KIND.RECONNECTED,
            attempt,
            endpoint: candidate.endpoint,
            previousEndpoint,
          });
        } else {
          this.emitEvent({
            kind: QWP_RECONNECT_EVENT_KIND.CONNECTED,
            attempt: 0,
            endpoint: candidate.endpoint,
          });
        }
        return;
      } catch (error) {
        // A poison frame is meant to identify a connection that repeatedly
        // accepts the same replay head and then rejects it or disappears. A
        // failed connection/replay attempt breaks that sequence, so the
        // outage must not supply the escalation dwell time -- but the strikes
        // already earned have to survive it. Wiping the episode here made the
        // canonical poison case unreachable: a frame that takes the server
        // down guarantees the next connect fails, which reset the count
        // before it could ever reach maxFrameRejections.
        this.beginPoisonOutage();
        if (reconnecting) this.totalReconnectErrors++;
        lastError = error;
        if (this.connectingCandidate === candidate) {
          this.connectingCandidate = undefined;
        }
        if (candidate) await candidate.close().catch(() => undefined);
        this.emitEvent({
          kind: QWP_RECONNECT_EVENT_KIND.ATTEMPT_FAILED,
          attempt,
          endpoint: candidate?.endpoint,
          previousEndpoint,
          cause: error,
        });
        if (error instanceof QwpReconnectExhaustedError) throw error;
        const capGapError =
          error instanceof QwpCatchUpCapGapError
            ? this.applyCatchUpCapGapPolicy(error)
            : undefined;
        if (!capGapError) this.resetCatchUpCapGapEpisode();
        if (capGapError?.exhausted) throw capGapError.error;
        if (
          capGapError &&
          !this.orphanStoreAndForward &&
          attemptPolicy !== "unbounded"
        ) {
          throw capGapError.error;
        }
        const durableAckMismatch = durableAckUnavailableCause(error);
        if (
          durableAckMismatch &&
          (!this.backgroundStoreAndForward || attemptPolicy !== "unbounded")
        ) {
          this.resetDurableAckMismatchEpisode();
          throw durableAckMismatch;
        }
        const durableAckPolicy =
          durableAckMismatch &&
          this.backgroundStoreAndForward &&
          attemptPolicy === "unbounded"
            ? this.applyDurableAckMismatchPolicy(durableAckMismatch)
            : undefined;
        if (!durableAckPolicy) this.resetDurableAckMismatchEpisode();
        if (durableAckPolicy?.exhausted) throw durableAckPolicy.error;
        if (
          this.orphanStoreAndForward &&
          attemptPolicy === "unbounded" &&
          isPrimaryUnavailableError(error)
        ) {
          primaryUnavailableAttempts++;
          this.emitEvent({
            kind: QWP_RECONNECT_EVENT_KIND.PRIMARY_UNAVAILABLE,
            attempt: primaryUnavailableAttempts,
            previousEndpoint,
            cause: error,
          });
        }
        if (!durableAckPolicy && !this.isRetryableReconnectError(error)) {
          throw error;
        }
        const attemptsExhausted =
          attemptPolicy === "single" ||
          (attemptPolicy === "configured" &&
            this.maxAttempts > 0 &&
            attempt >= this.maxAttempts);
        const durationExhausted =
          attemptPolicy === "configured" &&
          this.maxDurationMs > 0 &&
          Date.now() - outageStarted >= this.maxDurationMs;
        if (attemptsExhausted || durationExhausted) {
          if (attemptPolicy === "single") throw error;
          throw new QwpReconnectExhaustedError(attempt, lastError);
        }
      }
    }
    throw new QwpSendClosedError();
  }

  private applyCatchUpCapGapPolicy(error: QwpCatchUpCapGapError): {
    exhausted: boolean;
    error: QwpCatchUpCapGapError;
  } {
    // Foreground SF owns producer data and must wait for a larger-cap node.
    if (!this.orphanStoreAndForward) {
      return { exhausted: false, error };
    }
    const now = monotonicNowMs();
    if (this.catchUpCapGapAttempts === 0) {
      this.catchUpCapGapFirstMs = now;
    }
    this.catchUpCapGapAttempts++;
    const episodeMs = Math.max(0, now - this.catchUpCapGapFirstMs);
    const exhausted =
      this.catchUpCapGapAttempts >= MAX_CATCH_UP_CAP_GAP_ATTEMPTS &&
      episodeMs >= this.catchUpCapGapMinEscalationWindowMs;
    return {
      exhausted,
      error: new QwpCatchUpCapGapError(
        error.symbolId,
        error.frameLength,
        error.maxBatchSizeBytes,
        {
          attempt: this.catchUpCapGapAttempts,
          episodeMs,
          minEscalationWindowMs: this.catchUpCapGapMinEscalationWindowMs,
          exhausted,
        },
      ),
    };
  }

  private resetCatchUpCapGapEpisode(): void {
    this.catchUpCapGapAttempts = 0;
    this.catchUpCapGapFirstMs = 0;
  }

  private applyDurableAckMismatchPolicy(error: QwpDurableAckUnavailableError): {
    exhausted: boolean;
    error: QwpDurableAckUnavailableError | QwpDurableAckPersistentFailureError;
  } {
    const now = monotonicNowMs();
    if (this.durableAckMismatchAttempts === 0) {
      this.durableAckMismatchFirstMs = now;
    }
    this.durableAckMismatchAttempts++;
    const episodeMs = Math.max(0, now - this.durableAckMismatchFirstMs);
    const durationExhausted =
      this.orphanDurableAckMismatchMaxDurationMs > 0 &&
      episodeMs >= this.orphanDurableAckMismatchMaxDurationMs;
    const exhausted =
      this.orphanStoreAndForward &&
      (this.durableAckMismatchAttempts >=
        MAX_ORPHAN_DURABLE_ACK_MISMATCH_ATTEMPTS ||
        durationExhausted);
    if (exhausted) {
      const persistent = new QwpDurableAckPersistentFailureError(
        this.durableAckMismatchAttempts,
        episodeMs,
        error,
      );
      this.emitEvent({
        kind: QWP_RECONNECT_EVENT_KIND.DURABLE_ACK_PERSISTENT_FAILURE,
        attempt: this.durableAckMismatchAttempts,
        previousEndpoint: this.lastEndpoint,
        cause: persistent,
        episodeMs,
      });
      return { exhausted: true, error: persistent };
    }
    this.emitEvent({
      kind: QWP_RECONNECT_EVENT_KIND.DURABLE_ACK_UNAVAILABLE,
      attempt: this.durableAckMismatchAttempts,
      previousEndpoint: this.lastEndpoint,
      cause: error,
      episodeMs,
    });
    return { exhausted: false, error };
  }

  private resetDurableAckMismatchEpisode(): void {
    this.durableAckMismatchAttempts = 0;
    this.durableAckMismatchFirstMs = 0;
  }

  private isRetryableReconnectError(error: unknown): boolean {
    if (
      this.backgroundStoreAndForward &&
      !this.orphanStoreAndForward &&
      this.hasEverConnected &&
      isEndpointPolicyFailure(error)
    ) {
      return true;
    }
    return isRetryableReconnectError(error);
  }

  private async replayInto(
    connection: QwpBinaryConnection,
  ): Promise<ReplayFrame[]> {
    const replayed: ReplayFrame[] = [];
    const cap = minimumDefined(
      connection.handshake.maxBatchSizeBytes,
      this.localMaxBatchSizeBytes,
    );
    this.durableWatermarks.clear();
    for (const payload of dictionaryCatchupFrames(this.symbolDictionary, cap)) {
      const frame: ReplayFrame = {
        frameSequence: -1n,
        payload,
        payloadLength: payload.byteLength,
        ackDelivered: true,
        transmitted: true,
        dictionaryCatchup: true,
      };
      replayed.push(frame);
      await this.sendPhysical(connection, payload, false);
    }
    for (const frame of this.frames.values()) {
      if (!frame.transmitted) continue;
      if (this.isRecoveredDiscardFrame(frame.frameSequence)) continue;
      frame.durableTargets = undefined;
      if (cap !== undefined && frame.payloadLength > cap) {
        throw new RangeError(
          `persisted QWP frame exceeds reconnect target batch cap [size=${frame.payloadLength}, max=${cap}]`,
        );
      }
      const payload = await this.readFramePayload(frame);
      frame.deferCommit = defersCommit(payload);
      replayed.push(frame);
      await this.sendPhysical(connection, payload, true);
    }
    return replayed;
  }

  private install(
    connection: QwpBinaryConnection,
    wireFrames: ReplayFrame[],
  ): void {
    this.hasEverConnected = true;
    this.connection = connection;
    this.lastHandshake = connection.handshake;
    this.lastEndpoint = connection.endpoint;
    this.wireFrames = wireFrames;
    this.wireFramesBase = 0;
    if (connection.ping && !this.ping) {
      // Assigned only when the initial transport supports PING so browser
      // connections keep the optional capability genuinely absent.
      this.ping = () => this.pingWithReconnect();
    }
    const generation = ++this.generation;
    void this.pump(connection, generation);
  }

  private async pump(
    connection: QwpBinaryConnection,
    generation: number,
  ): Promise<void> {
    try {
      for await (const payload of connection.messages) {
        if (
          this.closing ||
          this.connection !== connection ||
          generation !== this.generation
        ) {
          return;
        }
        let translated: Uint8Array | undefined;
        try {
          translated = await this.translateResponse(payload);
        } catch (error) {
          if (
            error instanceof RetriableIngressNackError ||
            error instanceof QwpProtocolError ||
            error instanceof QwpReplayRejectedError
          ) {
            throw error;
          }
          // The wire payload decoded successfully. Failures from this point
          // are local replay-store/bookkeeping failures, not evidence that
          // the server rejected the head frame.
          if (isRetryableReconnectError(error)) {
            // A journal fault here is usually transient: a briefly full or
            // read-only filesystem parks maintenanceFailure for about a
            // second and the store clears it on the next successful batch.
            // failTerminal() is permanent, so latching would brick a running
            // producer for the rest of the process lifetime -- the outcome
            // the store-level retry exists to prevent. transmitOnce() routes
            // the identical class to requestReconnect() for that reason and
            // this path has to agree. acknowledgeThrough() persists its
            // cursor before it mutates anything, so a failure here leaves
            // exactly the state a crash at this instant would leave, and
            // replay resumes from the persisted watermark.
            await this.requestReconnect(error, connection).catch(
              (reconnectError) => this.failTerminal(reconnectError),
            );
            return;
          }
          this.failTerminal(error);
          await connection
            .close(1011, "QWP ingress response processing failed")
            .catch(() => undefined);
          return;
        }
        if (translated) this.messagesQueue.push(translated);
        if (this.terminalError) return;
      }
      if (
        this.closing ||
        this.connection !== connection ||
        generation !== this.generation
      ) {
        return;
      }
      const info = await connection.closed;
      const cause = this.classifyConnectionLoss(
        new QwpSendClosedError(info),
        info,
      );
      if (cause instanceof QwpProtocolError) {
        this.failTerminal(cause);
        await connection
          .close(1002, "poisoned QWP ingress frame")
          .catch(() => undefined);
        return;
      }
      await this.requestReconnect(cause, connection).catch((reconnectError) =>
        this.failTerminal(reconnectError),
      );
      return;
    } catch (error) {
      if (
        this.closing ||
        this.connection !== connection ||
        generation !== this.generation
      ) {
        return;
      }
      if (
        error instanceof QwpProtocolError ||
        error instanceof QwpReplayRejectedError
      ) {
        this.failTerminal(error);
        await connection
          .close(1002, "terminal QWP response")
          .catch(() => undefined);
        return;
      }
      const cause =
        error instanceof RetriableIngressNackError
          ? error
          : this.classifyConnectionLoss(
              error,
              error instanceof QwpSendClosedError ? error.closeInfo : undefined,
            );
      if (cause instanceof QwpProtocolError) {
        this.failTerminal(cause);
        await connection
          .close(1002, "poisoned QWP ingress frame")
          .catch(() => undefined);
        return;
      }
      await this.requestReconnect(cause, connection).catch((reconnectError) => {
        this.failTerminal(reconnectError);
      });
    }
  }

  private async translateResponse(
    payload: Uint8Array,
  ): Promise<Uint8Array | undefined> {
    const response = decodeQwpIngressResponse(payload);
    if (response.status === QWP_STATUS.DURABLE_ACK) {
      for (const table of response.tables) {
        const current = this.durableWatermarks.get(table.name);
        if (current === undefined || table.sequenceTransaction > current) {
          this.durableWatermarks.set(table.name, table.sequenceTransaction);
        }
      }
      await this.trimDurablePrefix();
      return payload;
    }
    if (response.sequence === null) {
      throw new QwpProtocolError("QWP response is missing its wire sequence");
    }
    if (response.sequence < 0n) {
      throw new QwpProtocolError(
        `QWP response sequence is negative: ${response.sequence}`,
      );
    }
    const highestWireIndex = this.wireFramesBase + this.wireFrames.length - 1;
    if (response.sequence > BigInt(highestWireIndex)) {
      // Reject an over-range sequence rather than clamping it, matching the null
      // and negative guards above. A frame is logged here before it is sent, so
      // a conforming server can only acknowledge a sequence it has received,
      // never one beyond the last frame sent. Clamping a bogus over-range value
      // onto the newest in-flight frame would retire every unacknowledged frame
      // below it and delete journal records the server never confirmed -- the
      // watermark must never advance past an unacknowledged frame.
      throw new QwpProtocolError(
        `QWP response sequence is beyond the last frame sent: ${response.sequence} > ${highestWireIndex}`,
      );
    }
    const wireIndex = Number(response.sequence);
    const localIndex = wireIndex - this.wireFramesBase;
    const frame = localIndex >= 0 ? this.wireFrames[localIndex] : undefined;
    if (!frame) {
      // Either nothing has been sent on this connection yet, or this sequence
      // was covered by an earlier cumulative ACK and trimmed. A duplicate OK
      // has already been delivered; a NACK still has to be reported.
      if (response.status === QWP_STATUS.OK) return undefined;
      this.totalServerNacks++;
      const pending = this.pendingFsnRange();
      this.emitSenderError(
        createQwpSenderError(response, {
          messageSequence: response.sequence ?? undefined,
          fromFsn: pending?.from,
          toFsn: pending?.to,
        }),
      );
      if (isRetriableIngressStatus(response.status)) {
        throw new RetriableIngressNackError(
          -1n,
          response.status,
          this.nextExemptRecycleDelay(),
          response.errorMessage,
        );
      }
      throw new QwpProtocolError(
        `QuestDB rejected ingress before any frame was sent [status=0x${response.status.toString(16)}]${
          response.errorMessage ? `: ${response.errorMessage}` : ""
        }`,
      );
    }

    if (response.status === QWP_STATUS.OK) {
      if (frame.dictionaryCatchup) return undefined;
      const covered = this.wireFrames.slice(0, localIndex + 1);
      const clientTarget = findLastClientFrame(covered);
      const shouldDeliver = covered.some(
        (candidate) =>
          candidate.clientSequence !== undefined && !candidate.ackDelivered,
      );
      for (const candidate of covered) candidate.ackDelivered = true;
      if (frame.frameSequence > this.highestOkFrameSequence) {
        this.highestOkFrameSequence = frame.frameSequence;
      }
      this.clearPoisonThrough(frame.frameSequence);
      // Gated on the request, not on the handshake flag alone. A server that
      // reports durable-ACK support the caller never asked for switched this
      // connection onto a watermark that only DURABLE_ACK frames advance --
      // and nothing polls for those unless the caller asked, so the watermark
      // stalled at -1n while cumulative OKs kept arriving. close() then failed
      // with "pending data may be lost" on a fully acknowledged sender, and
      // durableTargets accumulated one map per frame with nothing to drain it.
      if (this.handshake.durableAckEnabled && this.durableAckTracked) {
        frame.durableTargets = new Map(
          response.tables.map((table) => [
            table.name,
            table.sequenceTransaction,
          ]),
        );
        await this.trimDurablePrefix();
      } else {
        await this.acknowledgeThrough(frame.frameSequence);
      }
      // ACKs are cumulative, so nothing reads the covered prefix again.
      // Dropping it keeps both the log and the payloads it pins bounded, and
      // keeps each ACK proportional to the frames it actually covers.
      this.wireFrames.splice(0, localIndex + 1);
      this.wireFramesBase += localIndex + 1;
      if (!shouldDeliver || clientTarget?.clientSequence === undefined) {
        return undefined;
      }
      return rewriteResponseSequence(payload, clientTarget.clientSequence);
    }

    this.totalServerNacks++;
    const pending = frame.dictionaryCatchup
      ? this.pendingFsnRange()
      : undefined;
    this.emitSenderError(
      createQwpSenderError(response, {
        messageSequence: response.sequence,
        fromFsn: pending?.from ?? frame.frameSequence,
        toFsn: pending?.to ?? frame.frameSequence,
      }),
    );

    if (isRetriableIngressStatus(response.status)) {
      const exempt =
        frame.dictionaryCatchup ||
        response.status === QWP_STATUS.NOT_WRITABLE ||
        // A DICTIONARY_GAP is the server asking for symbol catch-up, not a
        // verdict on this frame. The catch-up it triggers has not been sent
        // yet, so charging the frame a strike condemns it before the recovery
        // it asked for has been attempted.
        response.status === QWP_STATUS.DICTIONARY_GAP ||
        qwpSenderErrorCategory(response.status) ===
          QWP_SENDER_ERROR_CATEGORY.UNKNOWN;
      if (exempt) {
        this.resetPoisonEpisode();
        throw new RetriableIngressNackError(
          frame.frameSequence,
          response.status,
          this.nextExemptRecycleDelay(),
          response.errorMessage,
        );
      }
      if (this.recordPoisonStrike(frame.frameSequence)) {
        this.emitSenderError(
          createQwpProtocolViolationSenderError(
            `frame remained rejected after ${this.poisonStrikes} attempts${
              response.errorMessage ? `: ${response.errorMessage}` : ""
            }`,
            frame.frameSequence,
          ),
        );
        throw new QwpReplayRejectedError(
          frame.frameSequence,
          response.status,
          `frame remained rejected after ${this.poisonStrikes} attempts${
            response.errorMessage ? `: ${response.errorMessage}` : ""
          }`,
        );
      }
      throw new RetriableIngressNackError(
        frame.frameSequence,
        response.status,
        cappedExponentialBackoff(
          this.initialBackoffMs,
          this.maxBackoffMs,
          this.poisonStrikes - 1,
        ),
        response.errorMessage,
      );
    }

    if (frame.dictionaryCatchup) {
      const error = new QwpProtocolError(
        `QuestDB rejected QWP symbol dictionary catch-up [status=0x${response.status.toString(16)}]${
          response.errorMessage ? `: ${response.errorMessage}` : ""
        }`,
      );
      this.failTerminal(error);
      return undefined;
    }

    const replayError = new QwpReplayRejectedError(
      frame.frameSequence,
      response.status,
      response.errorMessage,
    );
    if (frame.clientSequence === undefined) {
      this.failTerminal(replayError);
      return undefined;
    }
    const translated = rewriteResponseSequence(payload, frame.clientSequence);
    this.messagesQueue.push(translated);
    this.failTerminal(replayError);
    return undefined;
  }

  private async trimDurablePrefix(): Promise<void> {
    let lastCovered: bigint | undefined;
    for (const frame of this.frames.values()) {
      // Successful ingress ACKs are cumulative. Deferred frames therefore
      // have no checkpoint of their own; a later commit-bearing ACK covers
      // them and its durable targets retire the whole preceding range.
      if (!frame.durableTargets) continue;
      if (!areTargetsCovered(frame.durableTargets, this.durableWatermarks)) {
        break;
      }
      lastCovered = frame.frameSequence;
    }
    if (lastCovered !== undefined) await this.acknowledgeThrough(lastCovered);
    this.pruneCompletedDurableWatermarks();
  }

  /** Do not carry a completed table incarnation into a later same-name table. */
  private pruneCompletedDurableWatermarks(): void {
    const pendingTables = new Set<string>();
    for (const frame of this.frames.values()) {
      if (!frame.durableTargets) continue;
      for (const table of frame.durableTargets.keys()) pendingTables.add(table);
    }
    for (const table of this.durableWatermarks.keys()) {
      if (!pendingTables.has(table)) this.durableWatermarks.delete(table);
    }
  }

  private clearPoisonThrough(frameSequence: bigint): void {
    if (
      this.poisonFrameSequence === undefined ||
      frameSequence < this.poisonFrameSequence
    ) {
      return;
    }
    this.resetPoisonEpisode();
  }

  private resetPoisonEpisode(): void {
    this.poisonFrameSequence = undefined;
    this.poisonFirstStrikeMs = 0;
    this.poisonStrikes = 0;
    this.poisonOutageMs = 0;
    this.poisonOutageStartedMs = 0;
  }

  /**
   * Marks the start of a connection-establishment outage. The strikes a frame
   * has already earned survive it -- otherwise a frame that takes the server
   * down can never escalate, because the very crash it causes makes the next
   * connect fail and wipes the episode. Only the dwell the outage would have
   * contributed is withheld, which is what the escalation window is for.
   */
  private beginPoisonOutage(): void {
    if (this.poisonFrameSequence === undefined) return;
    if (this.poisonOutageStartedMs === 0) {
      this.poisonOutageStartedMs = Date.now();
    }
  }

  /** Banks the elapsed outage so it cannot count toward the escalation window. */
  private endPoisonOutage(): void {
    if (this.poisonOutageStartedMs === 0) return;
    this.poisonOutageMs += Date.now() - this.poisonOutageStartedMs;
    this.poisonOutageStartedMs = 0;
  }

  private recordPoisonStrike(frameSequence: bigint): boolean {
    const now = Date.now();
    this.endPoisonOutage();
    if (this.poisonFrameSequence === frameSequence) {
      this.poisonStrikes++;
    } else {
      this.poisonFrameSequence = frameSequence;
      this.poisonStrikes = 1;
      this.poisonFirstStrikeMs = now;
      this.poisonOutageMs = 0;
      this.poisonOutageStartedMs = 0;
    }
    const connectedDwellMs =
      now - this.poisonFirstStrikeMs - this.poisonOutageMs;
    return (
      this.poisonStrikes >= this.maxFrameRejections &&
      connectedDwellMs >= this.poisonMinEscalationWindowMs
    );
  }

  private classifyConnectionLoss(
    cause: unknown,
    closeInfo?: QwpConnectionCloseInfo,
  ): Error {
    const exempt =
      closeInfo?.code === 1000 ||
      closeInfo?.code === 1001 ||
      closeInfo?.code === 1012 ||
      closeInfo?.code === 1013;
    if (exempt) this.resetPoisonEpisode();
    const head = exempt ? undefined : this.currentPoisonHead();
    if (!head) {
      return new RetriableIngressConnectionError(
        this.nextExemptRecycleDelay(),
        cause,
      );
    }
    if (this.recordPoisonStrike(head.frameSequence)) {
      const closeDetail = closeInfo
        ? `code=${closeInfo.code}, reason=${closeInfo.reason}`
        : "transport ended without an orderly close";
      const message = `QWP ingress frame repeatedly caused a non-orderly connection loss [frameSequence=${head.frameSequence}, strikes=${this.poisonStrikes}, ${closeDetail}]`;
      this.emitSenderError(
        createQwpProtocolViolationSenderError(
          message,
          head.frameSequence,
          this.nextFrameSequence - 1n,
        ),
      );
      return new QwpProtocolError(message);
    }
    return new RetriableIngressConnectionError(
      cappedExponentialBackoff(
        this.initialBackoffMs,
        this.maxBackoffMs,
        this.poisonStrikes - 1,
      ),
      cause,
    );
  }

  /**
   * The frame a non-orderly close is charged against, or undefined when the
   * close says nothing about any particular frame.
   *
   * This path infers suspicion from a frame sitting past the ACK watermark
   * when the connection died, so it may only consider frames the server was
   * expected to answer. A deferred frame is not one: QuestDB withholds its
   * cumulative OK for the life of the open transaction, so "unacknowledged" is
   * the protocol's normal state for it and carries no evidence about the
   * frame. Charging it meant four ordinary transport drops during one
   * transaction latched a running sender terminal. This is the same reasoning
   * translateResponse() applies to dictionary catch-up and DICTIONARY_GAP; a
   * NACK naming the frame still escalates it there, because that is a real
   * verdict rather than an inference.
   */
  private currentPoisonHead(): ReplayFrame | undefined {
    const progress =
      this.highestOkFrameSequence > this.acknowledgedFrameSequence
        ? this.highestOkFrameSequence
        : this.acknowledgedFrameSequence;
    return this.wireFrames.find(
      (frame) =>
        !frame.dictionaryCatchup &&
        !frame.deferCommit &&
        frame.frameSequence > progress,
    );
  }

  private nextExemptRecycleDelay(): number {
    const progress =
      this.highestOkFrameSequence > this.acknowledgedFrameSequence
        ? this.highestOkFrameSequence
        : this.acknowledgedFrameSequence;
    if (progress > this.progressAtLastExemptRecycle) {
      this.zeroProgressRecycles = 0;
    }
    this.progressAtLastExemptRecycle = progress;
    const level = this.zeroProgressRecycles++;
    if (level === 0) return 0;
    return cappedExponentialBackoff(
      this.initialBackoffMs,
      this.maxBackoffMs,
      level - 1,
    );
  }

  private async acknowledgeThrough(frameSequence: bigint): Promise<void> {
    await this.acknowledgeStoredFramesThrough(frameSequence);
    await this.retireRecoveredDiscardTailIfReady();
  }

  private async acknowledgeStoredFramesThrough(
    frameSequence: bigint,
  ): Promise<void> {
    await this.store.acknowledgeThrough(frameSequence);
    for (const sequence of this.frames.keys()) {
      if (sequence > frameSequence) break;
      this.frames.delete(sequence);
    }
    if (frameSequence > this.acknowledgedFrameSequence) {
      this.acknowledgedFrameSequence = frameSequence;
    }
  }

  private isRecoveredDiscardFrame(frameSequence: bigint): boolean {
    const tail = this.recoveredDiscardTail;
    return (
      tail !== undefined &&
      frameSequence >= tail.startSequence &&
      frameSequence <= tail.tipSequence
    );
  }

  private async retireRecoveredDiscardTailIfReady(): Promise<void> {
    const tail = this.recoveredDiscardTail;
    if (!tail) return;
    if (
      tail.predecessorSequence !== undefined &&
      this.frames.has(tail.predecessorSequence)
    ) {
      return;
    }
    const frameCount = tail.tipSequence - tail.startSequence + 1n;
    await this.acknowledgeStoredFramesThrough(tail.tipSequence);
    this.recoveredDiscardTail = undefined;
    // Retiring the tail is correct: it belongs to a transaction the producer
    // never committed, the server rolled it back on disconnect, and replaying
    // it would rebuild half a transaction. Doing it silently is not. This is
    // the one path that empties journalled frames with no NACK, no quarantine
    // and no recovery report, so it must reach the same channel as every other
    // abandonment -- otherwise a crash discards the tail with nothing for an
    // operator to see. The Java client logs the same fact on this path.
    this.emitSenderError(
      createQwpDataLossSenderError(
        `recovered store-and-forward journal ends with ${frameCount} deferred frame(s) ` +
          `whose transaction was never committed [fsn=${tail.startSequence}..${tail.tipSequence}]; ` +
          `the tail was retired without being transmitted`,
      ),
    );
  }

  private async persistSymbolDictionaryDelta(
    delta: NonNullable<ReturnType<typeof readSymbolDictionaryDelta>>,
  ): Promise<void> {
    if (
      !this.store.loadSymbolDictionary ||
      !this.store.appendSymbolDictionary
    ) {
      throw new QwpReplayDictionaryError(
        "QWP delta symbol dictionaries require a replay store with dictionary persistence",
      );
    }
    if (delta.startId > this.symbolDictionary.length) {
      throw new QwpReplayDictionaryError(
        `QWP symbol dictionary has a gap [expectedAtMost=${this.symbolDictionary.length}, received=${delta.startId}]`,
      );
    }
    const overlap = Math.min(
      this.symbolDictionary.length - delta.startId,
      delta.entries.length,
    );
    for (let index = 0; index < overlap; index++) {
      const id = delta.startId + index;
      if (this.symbolDictionary[id] !== delta.entries[index]) {
        throw new QwpReplayDictionaryError(
          `QWP symbol dictionary conflicts at ID ${id}`,
        );
      }
    }
    const firstNewEntry = Math.max(
      this.symbolDictionary.length - delta.startId,
      0,
    );
    const newEntries = delta.entries.slice(firstNewEntry);
    if (newEntries.length === 0) return;
    const startId = this.symbolDictionary.length;
    try {
      await this.store.appendSymbolDictionary(startId, newEntries);
    } catch (error) {
      this.deltaSymbolDictionaryEnabled = false;
      throw new QwpReplayDictionaryPersistenceError(error);
    }
    this.symbolDictionary.push(...newEntries);
  }

  private async transmit(frame: ReplayFrame): Promise<void> {
    // Loops when a reconnect completes while this frame's payload is being
    // read; see the currency check below.
    for (;;) {
      if (await this.transmitOnce(frame)) return;
    }
  }

  /** Returns false when a reconnect invalidated the captured connection. */
  private async transmitOnce(frame: ReplayFrame): Promise<boolean> {
    const connection = await this.requireConnection();
    const generation = this.generation;
    const cap = minimumDefined(
      connection.handshake.maxBatchSizeBytes,
      this.localMaxBatchSizeBytes,
    );
    if (cap !== undefined && frame.payloadLength > cap) {
      // Data the producer already handed over is never reclassified as
      // unsendable because a failover landed on a smaller-cap node: that would
      // invent a terminal for a frame an earlier node would have taken. Treat
      // it as a connection-level failure, exactly as replayInto() does with the
      // identical check, so the reconnect loop keeps looking for a node that
      // can take it. Marking it transmitted is what puts it in replayInto()'s
      // resend set; it is deliberately not pushed onto the wire log, because
      // nothing reached the wire and the log is indexed by wire sequence.
      frame.transmitted = true;
      await this.requestReconnect(
        new RangeError(
          `QWP frame exceeds reconnect target batch cap [size=${frame.payloadLength}, max=${cap}]`,
        ),
        connection,
      );
      return true;
    }
    let payload: Uint8Array;
    try {
      payload = await this.readFramePayload(frame);
    } catch (error) {
      // A journal read can fail transiently: a briefly full or read-only
      // filesystem parks maintenanceFailure for about a second, and the store
      // clears it on the next successful batch. enqueueDrain's only handler is
      // failTerminal, so letting this escape would brick a running producer for
      // the rest of the process lifetime -- the very outcome the store-level
      // retry was added to prevent. replayInto() makes the identical read and
      // connectLoop retries its failures, so route this one the same way.
      // Deterministic corruption still escapes and stays terminal.
      if (!isRetryableReconnectError(error)) throw error;
      // Nothing reached the wire, so the frame is deliberately kept off the
      // wire log; marking it transmitted is what puts it in replayInto()'s
      // resend set, exactly as the batch-cap branch above does.
      frame.transmitted = true;
      await this.requestReconnect(error, connection);
      return true;
    }
    // The journal read above yields, and with a lazy store it can park behind
    // an fsyncing append for longer than a jittered reconnect takes. install()
    // swaps this.wireFrames wholesale and resets wireFramesBase, while
    // replayInto() skipped this frame because it was not transmitted yet.
    // Pushing it now would log it against the replacement connection's wire
    // sequence while sending it on the dead one, so the replacement's next
    // cumulative ACK would retire a frame no server ever received and delete
    // its journal record. Retry against the current connection instead.
    if (this.connection !== connection || this.generation !== generation) {
      return false;
    }
    frame.transmitted = true;
    this.wireFrames.push(frame);
    try {
      await this.sendPhysical(connection, payload, false);
      if (this.lazyReplayStore) frame.payload = undefined;
    } catch (error) {
      await this.requestReconnect(error, connection);
      if (this.lazyReplayStore) frame.payload = undefined;
    }
    return true;
  }

  private async readFramePayload(frame: ReplayFrame): Promise<Uint8Array> {
    let payload = frame.payload;
    if (!payload) {
      if (!this.lazyReplayStore) {
        throw new QwpProtocolError(
          `QWP replay payload is unavailable [frameSequence=${frame.frameSequence}]`,
        );
      }
      payload = await this.lazyReplayStore.readPayload(frame.frameSequence);
    }
    if (payload.byteLength !== frame.payloadLength) {
      throw new QwpProtocolError(
        `persisted QWP frame length changed [frameSequence=${frame.frameSequence}, expected=${frame.payloadLength}, received=${payload.byteLength}]`,
      );
    }
    return payload;
  }

  private async sendPhysical(
    connection: QwpBinaryConnection,
    payload: Uint8Array,
    replayed: boolean,
  ): Promise<void> {
    this.totalFramesSent++;
    this.totalBytesSent += payload.byteLength;
    if (replayed) {
      this.totalFramesReplayed++;
      this.totalBytesReplayed += payload.byteLength;
    }
    await connection.send(payload);
  }

  private async requireConnection(): Promise<QwpBinaryConnection> {
    if (this.reconnectTask) await this.reconnectTask;
    this.throwIfUnavailable();
    if (!this.connection) throw new QwpSendClosedError();
    return this.connection;
  }

  private async requestReconnect(
    cause: unknown,
    failedConnection: QwpBinaryConnection,
  ): Promise<void> {
    if (this.closing) throw new QwpSendClosedError();
    if (this.connection && this.connection !== failedConnection) return;
    if (this.reconnectTask) {
      const activeReconnect = this.reconnectTask;
      await activeReconnect;
      if (this.connection === failedConnection && !this.closing) {
        await this.requestReconnect(cause, failedConnection);
      }
      return;
    }

    if (
      cause instanceof RetriableIngressNackError &&
      cause.status === QWP_STATUS.NOT_WRITABLE
    ) {
      // NOT_WRITABLE describes this node, not the replayed frame. Preserve the
      // frame and make the next factory sweep start at another endpoint.
      failedConnection.deprioritizeEndpoint?.();
    }
    this.connection = undefined;
    void failedConnection.close().catch(() => undefined);
    const reconnecting = this.connectLoop(
      cause,
      true,
      this.backgroundStoreAndForward ? "unbounded" : "configured",
    );
    this.reconnectTask = reconnecting;
    try {
      await reconnecting;
    } finally {
      if (this.reconnectTask === reconnecting) this.reconnectTask = undefined;
    }
  }

  private async pingWithReconnect(): Promise<void> {
    const connection = await this.requireConnection();
    if (!connection.ping) {
      throw new Error("QWP reconnect target does not support WebSocket PING");
    }
    try {
      await connection.ping();
    } catch (error) {
      await this.requestReconnect(error, connection);
      const replacement = await this.requireConnection();
      if (!replacement.ping) {
        throw new Error("QWP reconnect target does not support WebSocket PING");
      }
      await replacement.ping();
    }
  }

  private async waitForBackoff(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.cancelBackoff === cancel) this.cancelBackoff = undefined;
        resolve();
      }, delayMs);
      const cancel = (): void => {
        clearTimeout(timer);
        if (this.cancelBackoff === cancel) this.cancelBackoff = undefined;
        resolve();
      };
      this.cancelBackoff = cancel;
    });
  }

  private waitForBackoffWithinDeadline(
    delayMs: number,
    deadlineMs: number | undefined,
    attempts: number,
  ): Promise<void> {
    return awaitReconnectDeadline(
      this.waitForBackoff(delayMs),
      deadlineMs,
      attempts,
      () => this.cancelBackoff?.(),
    );
  }

  private emitEvent(event: Omit<QwpReconnectEvent, "timestampMs">): void {
    this.connectionDispatcher?.offer({
      ...event,
      timestampMs: Date.now(),
    });
  }

  private emitSenderError(error: QwpSenderError): void {
    this.errorDispatcher?.offer(error);
  }

  private pendingFsnRange(): { from: bigint; to: bigint } | undefined {
    const iterator = this.frames.keys();
    const first = iterator.next();
    if (first.done) return undefined;
    let to = first.value;
    for (const frameSequence of iterator) to = frameSequence;
    return { from: first.value, to };
  }

  private throwIfUnavailable(): void {
    if (this.terminalError) throw this.terminalError;
    if (this.closing) throw new QwpSendClosedError();
  }

  private failTerminal(error: unknown): void {
    if (this.terminalError) return;
    this.terminalError =
      error instanceof Error
        ? error
        : new Error(`QWP reconnect failed: ${error}`);
    this.cancelBackoff?.();
    this.messagesQueue.fail(this.terminalError);
    this.settleClosed({
      code: 1011,
      reason: this.terminalError.message,
      wasClean: false,
    });
    void this.closeStore()
      .catch(() => undefined)
      .finally(() => this.releaseMemoryReplayReferences());
    void this.connection
      ?.close(1011, "QWP reconnect failed")
      .catch(() => undefined);
  }

  private settleClosed(info: QwpConnectionCloseInfo): void {
    if (this.closedSettled) return;
    this.closedSettled = true;
    this.resolveClosed(info);
  }

  private closeStore(): Promise<void> {
    if (!this.storeClosePromise) {
      this.storeClosePromise = Promise.resolve().then(() => this.store.close());
    }
    return this.storeClosePromise;
  }

  private releaseMemoryReplayReferences(): void {
    if (!(this.store instanceof QwpMemoryReplayStore)) return;
    this.frames.clear();
    this.wireFrames = [];
    this.wireFramesBase = 0;
    this.symbolDictionary.length = 0;
    this.durableWatermarks.clear();
  }
}

function isLazyReplayStore(
  store: QwpIngressReplayStore,
): store is LazyReplayStore {
  return (
    typeof store.loadReferences === "function" &&
    typeof store.readPayload === "function"
  );
}

function readSymbolDictionaryDelta(payload: Uint8Array) {
  // Preserve support for opaque/custom payloads used with the low-level API.
  if (
    payload.byteLength < QWP_HEADER_SIZE ||
    (payload[5] & QWP_FLAG_DELTA_SYMBOL_DICTIONARY) === 0
  ) {
    return undefined;
  }
  return decodeQwpIngressSymbolDictionaryDelta(payload);
}

async function analyzeRecoveredDiscardTail(
  records: readonly LoadedReplayRecord[],
  loadPayload: (record: LoadedReplayRecord) => Promise<Uint8Array>,
): Promise<RecoveredDiscardTail | undefined> {
  let boundaryIndex = -1;
  for (let index = 0; index < records.length; index++) {
    if (isRecoveredCommitBarrier(await loadPayload(records[index]))) {
      boundaryIndex = index;
    }
  }
  if (boundaryIndex === records.length - 1) return undefined;
  return {
    startSequence: records[boundaryIndex + 1].frameSequence,
    tipSequence: records[records.length - 1].frameSequence,
    predecessorSequence:
      boundaryIndex < 0 ? undefined : records[boundaryIndex].frameSequence,
  };
}

function isRecoveredCommitBarrier(payload: Uint8Array): boolean {
  try {
    const frame = decodeQwpFrame(payload);
    if ((frame.flags & QWP_FLAG_DEFER_COMMIT) !== 0) return false;
    // A durable-ACK poll is side-effect-free and cannot cover deferred data
    // before it. Treat an exact poll as transparent during the recovery scan.
    if (
      frame.flags === QWP_FLAG_DURABLE_ACK_POLL &&
      frame.tableCount === 0 &&
      frame.payloadLength === 0
    ) {
      return false;
    }
    return true;
  } catch {
    // Opaque low-level payloads and malformed QWP records are never silently
    // retired. They remain replay barriers and preserve the existing behavior.
    return true;
  }
}

async function recoverSymbolDictionary(
  records: readonly LoadedReplayRecord[],
  loadPayload: (record: LoadedReplayRecord) => Promise<Uint8Array>,
  persistedDictionary: readonly string[],
  discardTail: RecoveredDiscardTail | undefined,
  store: QwpIngressReplayStore,
  persistedDictionaryFailure?: unknown,
): Promise<readonly string[]> {
  const hasDictionaryPersistence =
    store.loadSymbolDictionary !== undefined &&
    store.appendSymbolDictionary !== undefined;
  let recoveredFromPersisted = true;
  let dictionary: string[];
  try {
    dictionary = await reconstructSymbolDictionary(
      records,
      loadPayload,
      persistedDictionary,
      discardTail,
      hasDictionaryPersistence,
      persistedDictionaryFailure,
    );
  } catch (error) {
    if (!store.replaceSymbolDictionary || persistedDictionary.length === 0) {
      throw error;
    }
    // A structurally valid sidecar can still belong to an older dictionary
    // generation. Only discard it when the committed frames independently
    // reconstruct a complete dense dictionary from ID zero.
    dictionary = await reconstructSymbolDictionary(
      records,
      loadPayload,
      [],
      discardTail,
      hasDictionaryPersistence,
      error,
    );
    recoveredFromPersisted = false;
  }
  const replacePersistedDictionary =
    persistedDictionaryFailure !== undefined || !recoveredFromPersisted;
  if (replacePersistedDictionary) {
    try {
      await store.replaceSymbolDictionary!(dictionary);
    } catch (error) {
      throw new QwpReplayDictionaryError(
        "could not replace the unusable QWP symbol dictionary from surviving frame deltas",
        error,
      );
    }
  } else if (dictionary.length > persistedDictionary.length) {
    try {
      await store.appendSymbolDictionary!(
        persistedDictionary.length,
        dictionary.slice(persistedDictionary.length),
      );
    } catch (error) {
      throw new QwpReplayDictionaryError(
        "could not heal the recovered QWP symbol dictionary from surviving frame deltas",
        error,
      );
    }
  }
  return dictionary;
}

async function reconstructSymbolDictionary(
  records: readonly LoadedReplayRecord[],
  loadPayload: (record: LoadedReplayRecord) => Promise<Uint8Array>,
  baseline: readonly string[],
  discardTail: RecoveredDiscardTail | undefined,
  hasDictionaryPersistence: boolean,
  recoveryCause?: unknown,
): Promise<string[]> {
  const dictionary = [...baseline];
  const dictionaryIds = new Map(dictionary.map((entry, id) => [entry, id]));
  for (const record of records) {
    // A wholly deferred recovery tail is retired locally and never replayed.
    // Its dictionary additions therefore cannot make a committed prefix safe.
    if (
      discardTail !== undefined &&
      record.frameSequence >= discardTail.startSequence
    ) {
      break;
    }
    let delta: ReturnType<typeof readSymbolDictionaryDelta>;
    try {
      delta = readSymbolDictionaryDelta(await loadPayload(record));
    } catch (error) {
      throw new QwpUnrecoverableReplayDictionaryError(
        `persisted QWP frame contains an invalid symbol dictionary delta [sequence=${record.frameSequence}]`,
        recoveryCause ?? error,
      );
    }
    if (!delta) continue;
    if (!hasDictionaryPersistence) {
      throw new QwpUnrecoverableReplayDictionaryError(
        "persisted QWP delta frames require a replay store with dictionary persistence",
      );
    }
    if (delta.startId > dictionary.length) {
      throw new QwpUnrecoverableReplayDictionaryError(
        `persisted QWP frame references a symbol dictionary gap that cannot be reconstructed [startId=${delta.startId}, dictionarySize=${dictionary.length}]`,
        recoveryCause,
      );
    }
    delta.entries.forEach((entry, index) => {
      const id = delta.startId + index;
      const existing = dictionary[id];
      if (existing !== undefined && existing !== entry) {
        throw new QwpUnrecoverableReplayDictionaryError(
          `persisted QWP frame conflicts with symbol dictionary at ID ${id}`,
          recoveryCause,
        );
      }
      if (id === dictionary.length) {
        const duplicateId = dictionaryIds.get(entry);
        if (duplicateId !== undefined) {
          throw new QwpUnrecoverableReplayDictionaryError(
            `persisted QWP frame assigns symbol dictionary value ${JSON.stringify(entry)} to both ID ${duplicateId} and ID ${id}`,
            recoveryCause,
          );
        }
        dictionary.push(entry);
        dictionaryIds.set(entry, id);
      }
    });
  }
  return dictionary;
}

function dictionaryCatchupFrames(
  entries: readonly string[],
  maxBatchSizeBytes?: number,
): Uint8Array[] {
  if (entries.length === 0) return [];
  if (maxBatchSizeBytes === undefined) {
    return [encodeQwpIngressSymbolDictionaryFrame(0, entries)];
  }
  const result: Uint8Array[] = [];
  let startId = 0;
  while (startId < entries.length) {
    let count = 0;
    let entriesSize = 0;
    while (startId + count < entries.length) {
      const entryLength = utf8Length(entries[startId + count]);
      const nextEntriesSize =
        entriesSize + qwpVarintSize(entryLength) + entryLength;
      const nextCount = count + 1;
      const size =
        QWP_HEADER_SIZE +
        qwpVarintSize(startId) +
        qwpVarintSize(nextCount) +
        nextEntriesSize;
      if (size > maxBatchSizeBytes) break;
      count = nextCount;
      entriesSize = nextEntriesSize;
    }
    if (count === 0) {
      const entryLength = utf8Length(entries[startId]);
      const frameLength =
        QWP_HEADER_SIZE +
        qwpVarintSize(startId) +
        qwpVarintSize(1) +
        qwpVarintSize(entryLength) +
        entryLength;
      throw new QwpCatchUpCapGapError(startId, frameLength, maxBatchSizeBytes);
    }
    result.push(
      encodeQwpIngressSymbolDictionaryFrame(
        startId,
        entries.slice(startId, startId + count),
      ),
    );
    startId += count;
  }
  return result;
}

function minimumDefined(
  first: number | undefined,
  second: number | undefined,
): number | undefined {
  return first === undefined
    ? second
    : second === undefined
      ? first
      : Math.min(first, second);
}

function monotonicNowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function validateReconnectPolicy(
  maxAttempts: number,
  initialBackoffMs: number,
  maxBackoffMs: number,
  maxDurationMs: number,
  maxFrameRejections: number,
  poisonMinEscalationWindowMs: number,
  catchUpCapGapMinEscalationWindowMs: number,
): void {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0) {
    throw new RangeError(
      "reconnect maxAttempts must be a non-negative safe integer",
    );
  }
  for (const [name, value] of [
    ["initialBackoffMs", initialBackoffMs],
    ["maxBackoffMs", maxBackoffMs],
    ["maxDurationMs", maxDurationMs],
    ["poisonMinEscalationWindowMs", poisonMinEscalationWindowMs],
    ["catchUpCapGapMinEscalationWindowMs", catchUpCapGapMinEscalationWindowMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(
        `reconnect ${name} must be a non-negative finite number`,
      );
    }
  }
  if (maxBackoffMs < initialBackoffMs) {
    throw new RangeError(
      "reconnect maxBackoffMs must be greater than or equal to initialBackoffMs",
    );
  }
  if (!Number.isSafeInteger(maxFrameRejections) || maxFrameRejections < 1) {
    throw new RangeError(
      "reconnect maxFrameRejections must be a positive safe integer",
    );
  }
}

function isRetryableReconnectError(error: unknown): boolean {
  if (error instanceof QwpUpgradeError) return error.retryable !== false;
  if (error instanceof QwpFailoverError) {
    return error.attempts.some((attempt) =>
      isRetryableReconnectError(attempt.error),
    );
  }
  if (
    error instanceof QwpReplayRejectedError ||
    error instanceof QwpProtocolError
  ) {
    return false;
  }
  // Replay-store errors are declared in the Node-only layer, so the journal's
  // own verdict -- structural corruption, or a slot lock another process took
  // over -- is read structurally through the `retryable` flag those classes
  // carry. Every reconnect/replay path must honour the same verdict.
  return (
    (error as { retryable?: unknown } | null | undefined)?.retryable !== false
  );
}

function isEndpointPolicyFailure(error: unknown): boolean {
  if (error instanceof QwpUpgradeError) return true;
  return (
    error instanceof QwpFailoverError &&
    error.attempts.some((attempt) => isEndpointPolicyFailure(attempt.error))
  );
}

/** Returns a durable-ACK gap only when it accounts for the whole failure. */
function durableAckUnavailableCause(
  error: unknown,
): QwpDurableAckUnavailableError | undefined {
  if (error instanceof QwpDurableAckUnavailableError) return error;
  if (!(error instanceof QwpFailoverError) || error.attempts.length === 0) {
    return undefined;
  }
  let cause: QwpDurableAckUnavailableError | undefined;
  for (const attempt of error.attempts) {
    const attemptCause = durableAckUnavailableCause(attempt.error);
    if (!attemptCause) return undefined;
    cause ??= attemptCause;
  }
  return cause;
}

function isPrimaryUnavailableError(error: unknown): boolean {
  if (error instanceof QwpUpgradeError) {
    return error.kind === QWP_UPGRADE_ERROR_KIND.ROLE_REJECTED;
  }
  return (
    error instanceof QwpFailoverError &&
    error.attempts.length > 0 &&
    error.attempts.every((attempt) => isPrimaryUnavailableError(attempt.error))
  );
}

function reconnectDelayMs(error: unknown): number {
  return error instanceof RetriableIngressNackError ||
    error instanceof RetriableIngressConnectionError
    ? error.retryDelayMs
    : 0;
}

function isRetriableIngressStatus(status: number): boolean {
  return (
    status !== QWP_STATUS.SCHEMA_MISMATCH &&
    status !== QWP_STATUS.PARSE_ERROR &&
    status !== QWP_STATUS.SECURITY_ERROR
  );
}

function cappedExponentialBackoff(
  initialMs: number,
  maximumMs: number,
  exponent: number,
): number {
  if (initialMs === 0 || maximumMs === 0) return 0;
  return Math.min(initialMs * 2 ** Math.min(exponent, 52), maximumMs);
}

function findLastClientFrame(
  frames: readonly ReplayFrame[],
): ReplayFrame | undefined {
  for (let index = frames.length - 1; index >= 0; index--) {
    if (frames[index].clientSequence !== undefined) return frames[index];
  }
  return undefined;
}

function rewriteResponseSequence(
  payload: Uint8Array,
  sequence: bigint,
): Uint8Array {
  const translated = payload.slice();
  new DataView(
    translated.buffer,
    translated.byteOffset,
    translated.byteLength,
  ).setBigUint64(1, sequence, true);
  return translated;
}

function areTargetsCovered(
  targets: ReadonlyMap<string, bigint>,
  watermarks: ReadonlyMap<string, bigint>,
): boolean {
  for (const [table, target] of targets) {
    const watermark = watermarks.get(table);
    if (watermark === undefined || watermark < target) return false;
  }
  return true;
}
