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
} from "../core";
import {
  QWP_INITIAL_CONNECT_MODE,
  QWP_RECONNECT_EVENT_KIND,
  QwpBinaryConnection,
  QwpConnectionCloseInfo,
  QwpConnectionFactory,
  QwpFailoverError,
  QwpHandshakeMetadata,
  QwpIngressReplayRecord,
  QwpIngressReplayStore,
  QwpIngressTransportMetrics,
  QwpInitialConnectMode,
  QwpReconnectEvent,
  QwpReconnectExhaustedError,
  QwpReconnectOptions,
  QwpReplayDictionaryError,
  QwpReplayDictionaryPersistenceError,
  QwpReplayRejectedError,
  QwpSendClosedError,
  QwpUpgradeError,
} from "../transport";
import { QwpAsyncQueue } from "./async-queue";
import { jitterReconnectDelayMs } from "./reconnect-backoff";

const DEFAULT_CATCH_UP_CAP_GAP_MIN_ESCALATION_WINDOW_MS = 300_000;
const MAX_CATCH_UP_CAP_GAP_ATTEMPTS = 16;

type ConnectAttemptPolicy = "single" | "configured" | "unbounded";

class QwpCatchUpCapGapError extends RangeError {
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

interface ReplayFrame extends QwpIngressReplayRecord {
  readonly clientSequence?: bigint;
  ackDelivered: boolean;
  transmitted: boolean;
  durableTargets?: Map<string, bigint>;
  dictionaryCatchup?: boolean;
}

interface RecoveredDiscardTail {
  readonly startSequence: bigint;
  readonly tipSequence: bigint;
  readonly predecessorSequence?: bigint;
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

  async load(): Promise<readonly QwpIngressReplayRecord[]> {
    return Array.from(this.records, ([frameSequence, payload]) => ({
      frameSequence,
      payload: payload.slice(),
    }));
  }

  async append(record: QwpIngressReplayRecord): Promise<void> {
    this.records.set(record.frameSequence, record.payload.slice());
  }

  async acknowledgeThrough(frameSequence: bigint): Promise<void> {
    for (const sequence of this.records.keys()) {
      if (sequence > frameSequence) break;
      this.records.delete(sequence);
    }
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

  async close(): Promise<void> {}
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
  private readonly maxAttempts: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxDurationMs: number;
  private readonly maxFrameRejections: number;
  private readonly poisonMinEscalationWindowMs: number;
  private readonly catchUpCapGapMinEscalationWindowMs: number;
  private readonly localMaxBatchSizeBytes?: number;
  private readonly resolveClosed: (info: QwpConnectionCloseInfo) => void;
  private connection?: QwpBinaryConnection;
  private connectingCandidate?: QwpBinaryConnection;
  private lastHandshake?: QwpHandshakeMetadata;
  private lastEndpoint?: string | URL;
  private wireFrames: ReplayFrame[] = [];
  private nextFrameSequence = 0n;
  private nextClientSequence = 0n;
  private acknowledgedFrameSequence = -1n;
  private highestOkFrameSequence = -1n;
  private poisonFrameSequence?: bigint;
  private poisonFirstStrikeMs = 0;
  private poisonStrikes = 0;
  private catchUpCapGapAttempts = 0;
  private catchUpCapGapFirstMs = 0;
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
  ping?: () => Promise<void>;

  private constructor(
    private readonly factory: QwpConnectionFactory,
    private readonly reconnectOptions: QwpReconnectOptions,
    store: QwpIngressReplayStore,
    records: readonly QwpIngressReplayRecord[],
    symbolDictionary: readonly string[],
    recoveredDiscardTail: RecoveredDiscardTail | undefined,
    localMaxBatchSizeBytes?: number,
    private readonly backgroundStoreAndForward = false,
    private readonly orphanStoreAndForward = false,
    catchUpCapGapMinEscalationWindowMs = DEFAULT_CATCH_UP_CAP_GAP_MIN_ESCALATION_WINDOW_MS,
  ) {
    this.store = store;
    this.symbolDictionary = [...symbolDictionary];
    this.deltaSymbolDictionaryEnabled =
      store.loadSymbolDictionary !== undefined &&
      store.appendSymbolDictionary !== undefined;
    this.recoveredDiscardTail = recoveredDiscardTail;
    this.localMaxBatchSizeBytes = localMaxBatchSizeBytes;
    this.maxAttempts = reconnectOptions.maxAttempts ?? 3;
    this.initialBackoffMs = reconnectOptions.initialBackoffMs ?? 100;
    this.maxBackoffMs = reconnectOptions.maxBackoffMs ?? 5_000;
    this.maxDurationMs = reconnectOptions.maxDurationMs ?? 30_000;
    this.maxFrameRejections = reconnectOptions.maxFrameRejections ?? 4;
    this.poisonMinEscalationWindowMs =
      reconnectOptions.poisonMinEscalationWindowMs ?? 5_000;
    this.catchUpCapGapMinEscalationWindowMs =
      catchUpCapGapMinEscalationWindowMs;
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
      const frame: ReplayFrame = {
        frameSequence: record.frameSequence,
        payload: record.payload.slice(),
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
  }

  static async connect(
    factory: QwpConnectionFactory,
    reconnectOptions: QwpReconnectOptions,
    replayStore?: QwpIngressReplayStore,
    localMaxBatchSizeBytes?: number,
    backgroundStoreAndForward = false,
    initialConnectMode: QwpInitialConnectMode = backgroundStoreAndForward
      ? QWP_INITIAL_CONNECT_MODE.ASYNC
      : QWP_INITIAL_CONNECT_MODE.SYNC,
    orphanStoreAndForward = false,
    catchUpCapGapMinEscalationWindowMs = DEFAULT_CATCH_UP_CAP_GAP_MIN_ESCALATION_WINDOW_MS,
  ): Promise<QwpReconnectingIngressConnection> {
    const store = replayStore ?? new QwpMemoryReplayStore();
    let connection: QwpReconnectingIngressConnection | undefined;
    try {
      const records = await store.load();
      const sortedRecords = [...records].sort((a, b) =>
        a.frameSequence < b.frameSequence
          ? -1
          : a.frameSequence > b.frameSequence
            ? 1
            : 0,
      );
      const symbolDictionary = store.loadSymbolDictionary
        ? await store.loadSymbolDictionary()
        : [];
      validateRecoveredDictionary(sortedRecords, symbolDictionary, store);
      connection = new QwpReconnectingIngressConnection(
        factory,
        reconnectOptions,
        store,
        sortedRecords,
        symbolDictionary,
        analyzeRecoveredDiscardTail(sortedRecords),
        localMaxBatchSizeBytes,
        backgroundStoreAndForward,
        orphanStoreAndForward,
        catchUpCapGapMinEscalationWindowMs,
      );
      await connection.retireRecoveredDiscardTailIfReady();
      if (
        backgroundStoreAndForward &&
        initialConnectMode === QWP_INITIAL_CONNECT_MODE.ASYNC
      ) {
        connection.startBackgroundConnect();
      } else {
        try {
          await connection.connectLoop(
            undefined,
            false,
            backgroundStoreAndForward &&
              initialConnectMode === QWP_INITIAL_CONNECT_MODE.OFF
              ? "single"
              : "configured",
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
            connection.startBackgroundConnect();
          } else {
            throw error;
          }
        }
      }
      return connection;
    } catch (error) {
      await connection?.close().catch(() => undefined);
      if (!connection) await store.close().catch(() => undefined);
      throw error;
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
      pendingReplayBytes += frame.payload.byteLength;
    }
    return Object.freeze({
      publishedFrameSequence: this.nextFrameSequence - 1n,
      acknowledgedFrameSequence: this.acknowledgedFrameSequence,
      pendingReplayFrames: this.frames.size,
      pendingReplayBytes,
      totalFramesSent: this.totalFramesSent,
      totalBytesSent: this.totalBytesSent,
      totalFramesReplayed: this.totalFramesReplayed,
      totalBytesReplayed: this.totalBytesReplayed,
      totalReconnectAttempts: this.totalReconnectAttempts,
      totalReconnectsSucceeded: this.totalReconnectsSucceeded,
      totalFailovers: this.totalFailovers,
      totalReconnectErrors: this.totalReconnectErrors,
      totalServerNacks: this.totalServerNacks,
    });
  }

  send(payload: Uint8Array): Promise<void> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.closing) return Promise.reject(new QwpSendClosedError());
    const frame: ReplayFrame = {
      frameSequence: this.nextFrameSequence++,
      clientSequence: this.nextClientSequence++,
      payload: payload.slice(),
      ackDelivered: false,
      transmitted: false,
    };
    const publishing = this.sendTail.then(async () => {
      this.throwIfUnavailable();
      const delta = readSymbolDictionaryDelta(frame.payload);
      if (delta) {
        if (!this.deltaSymbolDictionaryEnabled) {
          throw new QwpReplayDictionaryError(
            "QWP delta symbol dictionaries are disabled because replay dictionary persistence is unavailable; encode symbols with full inline dictionaries",
          );
        }
        await this.persistSymbolDictionaryDelta(delta);
      }
      await this.store.append(frame);
      this.frames.set(frame.frameSequence, frame);
      if (this.backgroundStoreAndForward) {
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
      this.settleClosed(closeInfo);
    }
  }

  private async connectLoop(
    initialCause: unknown,
    reconnecting: boolean,
    attemptPolicy: ConnectAttemptPolicy = this.backgroundStoreAndForward
      ? "unbounded"
      : "configured",
  ): Promise<void> {
    const outageStarted = Date.now();
    const previousEndpoint = this.lastEndpoint;
    let attempt = 0;
    let backoffMs = this.initialBackoffMs;
    let lastError = initialCause;
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
      await this.waitForBackoff(jitterReconnectDelayMs(initialRetryDelayMs));
    } else if (reconnecting && backoffMs > 0) {
      await this.waitForBackoff(jitterReconnectDelayMs(backoffMs));
      backoffMs = Math.min(Math.max(backoffMs * 2, 1), this.maxBackoffMs);
    }

    while (!this.closing) {
      if (attempt > 0 && backoffMs > 0) {
        await this.waitForBackoff(jitterReconnectDelayMs(backoffMs));
        backoffMs = Math.min(Math.max(backoffMs * 2, 1), this.maxBackoffMs);
      }
      this.throwIfUnavailable();
      attempt++;
      if (reconnecting) this.totalReconnectAttempts++;
      let candidate: QwpBinaryConnection | undefined;
      try {
        candidate = await this.factory();
        this.hasEverConnected = true;
        this.connectingCandidate = candidate;
        if (this.closing) {
          await candidate.close().catch(() => undefined);
          throw new QwpSendClosedError();
        }
        const replayed = await this.replayInto(candidate);
        if (this.closing) throw new QwpSendClosedError();
        this.install(candidate, replayed);
        this.resetCatchUpCapGapEpisode();
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
        if (!this.isRetryableReconnectError(error)) throw error;
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
      if (cap !== undefined && frame.payload.byteLength > cap) {
        throw new RangeError(
          `persisted QWP frame exceeds reconnect target batch cap [size=${frame.payload.byteLength}, max=${cap}]`,
        );
      }
      replayed.push(frame);
      await this.sendPhysical(connection, frame.payload, true);
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
    if (this.wireFrames.length === 0) {
      if (response.status === QWP_STATUS.OK) return undefined;
      this.totalServerNacks++;
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
    const highestWireIndex = this.wireFrames.length - 1;
    const wireIndex = Number(
      response.sequence > BigInt(highestWireIndex)
        ? BigInt(highestWireIndex)
        : response.sequence,
    );
    const frame = this.wireFrames[wireIndex];

    if (response.status === QWP_STATUS.OK) {
      if (frame.dictionaryCatchup) return undefined;
      const covered = this.wireFrames.slice(0, wireIndex + 1);
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
      if (this.handshake.durableAckEnabled) {
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
      if (!shouldDeliver || clientTarget?.clientSequence === undefined) {
        return undefined;
      }
      return rewriteResponseSequence(payload, clientTarget.clientSequence);
    }

    this.totalServerNacks++;

    if (isRetriableIngressStatus(response.status)) {
      const exempt =
        frame.dictionaryCatchup || response.status === QWP_STATUS.NOT_WRITABLE;
      if (exempt) {
        throw new RetriableIngressNackError(
          frame.frameSequence,
          response.status,
          this.nextExemptRecycleDelay(),
          response.errorMessage,
        );
      }
      if (this.recordPoisonStrike(frame.frameSequence)) {
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
  }

  private clearPoisonThrough(frameSequence: bigint): void {
    if (
      this.poisonFrameSequence === undefined ||
      frameSequence < this.poisonFrameSequence
    ) {
      return;
    }
    this.poisonFrameSequence = undefined;
    this.poisonFirstStrikeMs = 0;
    this.poisonStrikes = 0;
  }

  private recordPoisonStrike(frameSequence: bigint): boolean {
    const now = Date.now();
    if (this.poisonFrameSequence === frameSequence) {
      this.poisonStrikes++;
    } else {
      this.poisonFrameSequence = frameSequence;
      this.poisonStrikes = 1;
      this.poisonFirstStrikeMs = now;
    }
    return (
      this.poisonStrikes >= this.maxFrameRejections &&
      now - this.poisonFirstStrikeMs >= this.poisonMinEscalationWindowMs
    );
  }

  private classifyConnectionLoss(
    cause: unknown,
    closeInfo?: QwpConnectionCloseInfo,
  ): Error {
    const orderly = closeInfo?.code === 1000 || closeInfo?.code === 1001;
    const head = orderly ? undefined : this.currentPoisonHead();
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
      return new QwpProtocolError(
        `QWP ingress frame repeatedly caused a non-orderly connection loss [frameSequence=${head.frameSequence}, strikes=${this.poisonStrikes}, ${closeDetail}]`,
      );
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

  private currentPoisonHead(): ReplayFrame | undefined {
    const progress =
      this.highestOkFrameSequence > this.acknowledgedFrameSequence
        ? this.highestOkFrameSequence
        : this.acknowledgedFrameSequence;
    return this.wireFrames.find(
      (frame) => !frame.dictionaryCatchup && frame.frameSequence > progress,
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
    await this.acknowledgeStoredFramesThrough(tail.tipSequence);
    this.recoveredDiscardTail = undefined;
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
    const connection = await this.requireConnection();
    const cap = minimumDefined(
      connection.handshake.maxBatchSizeBytes,
      this.localMaxBatchSizeBytes,
    );
    if (cap !== undefined && frame.payload.byteLength > cap) {
      throw new RangeError(
        `QWP frame exceeds reconnect target batch cap [size=${frame.payload.byteLength}, max=${cap}]`,
      );
    }
    frame.transmitted = true;
    this.wireFrames.push(frame);
    try {
      await this.sendPhysical(connection, frame.payload, false);
    } catch (error) {
      await this.requestReconnect(error, connection);
    }
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

  private emitEvent(event: Omit<QwpReconnectEvent, "timestampMs">): void {
    try {
      this.reconnectOptions.onEvent?.({ ...event, timestampMs: Date.now() });
    } catch {
      // Connection observers must not interfere with replay progress.
    }
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
    void this.closeStore().catch(() => undefined);
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

function analyzeRecoveredDiscardTail(
  records: readonly QwpIngressReplayRecord[],
): RecoveredDiscardTail | undefined {
  let boundaryIndex = -1;
  for (let index = 0; index < records.length; index++) {
    if (isRecoveredCommitBarrier(records[index].payload)) {
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

function validateRecoveredDictionary(
  records: readonly QwpIngressReplayRecord[],
  dictionary: readonly string[],
  store: QwpIngressReplayStore,
): void {
  const hasDictionaryPersistence =
    store.loadSymbolDictionary !== undefined &&
    store.appendSymbolDictionary !== undefined;
  for (const record of records) {
    const delta = readSymbolDictionaryDelta(record.payload);
    if (!delta) continue;
    if (!hasDictionaryPersistence) {
      throw new QwpReplayDictionaryError(
        "persisted QWP delta frames require a replay store with dictionary persistence",
      );
    }
    if (delta.startId + delta.entries.length > dictionary.length) {
      throw new QwpReplayDictionaryError(
        `persisted QWP frame references an incomplete symbol dictionary [startId=${delta.startId}, count=${delta.entries.length}, dictionarySize=${dictionary.length}]`,
      );
    }
    delta.entries.forEach((entry, index) => {
      const id = delta.startId + index;
      if (dictionary[id] !== entry) {
        throw new QwpReplayDictionaryError(
          `persisted QWP frame conflicts with symbol dictionary at ID ${id}`,
        );
      }
    });
  }
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
  return !(
    error instanceof QwpReplayRejectedError || error instanceof QwpProtocolError
  );
}

function isEndpointPolicyFailure(error: unknown): boolean {
  if (error instanceof QwpUpgradeError) return true;
  return (
    error instanceof QwpFailoverError &&
    error.attempts.some((attempt) => isEndpointPolicyFailure(attempt.error))
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
