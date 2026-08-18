import {
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
} from "./core";
import {
  QwpBinaryConnection,
  QwpConnectionCloseInfo,
  QwpConnectionFactory,
  QwpHandshakeMetadata,
  QwpIngressReplayStore,
  QwpReconnectOptions,
} from "./transport";
import { QwpReconnectingIngressConnection } from "./internal/reconnecting-ingress-connection";

const QWP_FLAGS_OFFSET = 5;

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
   * Enables bounded reconnection and at-least-once replay of unacknowledged
   * frames. Browser replay is memory-only. Node connectors require a
   * persistent store-and-forward directory when this is enabled.
   *
   * An ACK lost during disconnect can cause a frame to be replayed after the
   * server accepted it; configure server-side deduplication when duplicates
   * are not acceptable.
   */
  reconnect?: QwpReconnectOptions;
  /** @internal Node adapter hook for persistent store-and-forward. */
  replayStore?: QwpIngressReplayStore;
  /** @internal Starts the Node persistent drainer without waiting for a server. */
  backgroundStoreAndForward?: boolean;
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
   * transports send table-less QWP commit frames. Zero keeps tracking enabled
   * but disables automatic polling.
   */
  durableAckKeepaliveMs?: number;
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
  /** Stable store-and-forward watermark; absent without reconnect/replay. */
  readonly replayPublishedFrameSequence?: bigint;
  /** Trim watermark; in durable-ACK mode it advances only after durability. */
  readonly replayAcknowledgedFrameSequence?: bigint;
  readonly pendingReplayFrames: number;
  readonly pendingReplayBytes: number;
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
  readonly metrics: QwpIngressMetrics;
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

export class QwpIngressNackError extends Error {
  constructor(readonly response: QwpIngressResponse) {
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
  const keepalive = options.durableAckKeepaliveMs;
  if (
    keepalive !== undefined &&
    (!Number.isFinite(keepalive) || keepalive < 0)
  ) {
    throw new RangeError(
      "durableAckKeepaliveMs must be a non-negative finite number",
    );
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
  private nextSequence = 0n;
  private sendTail: Promise<void> = Promise.resolve();
  private durablePollTimer?: ReturnType<typeof setTimeout>;
  private readonly localMaxBatchSizeBytes?: number;
  private readonly symbolDictionary = new QwpSymbolDictionary();
  private publishedMaxSymbolId = -1;
  private deltaSymbolsPublished = false;
  private acknowledgedSequence = -1n;
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
  private readonly receiveLoop: Promise<void>;

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
  ): Promise<QwpIngressSession> {
    validateIngressSessionOptions(options);
    if (options.replayStore && !options.reconnect) {
      throw new RangeError("a QWP replayStore requires reconnect options");
    }
    if (options.backgroundStoreAndForward && !options.replayStore) {
      throw new RangeError(
        "background QWP store-and-forward requires a replayStore",
      );
    }
    const connection = options.reconnect
      ? await QwpReconnectingIngressConnection.connect(
          factory,
          options.reconnect,
          options.replayStore,
          options.maxBatchSizeBytes,
          options.backgroundStoreAndForward,
        )
      : await factory();
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
      replayPublishedFrameSequence: transport?.publishedFrameSequence,
      replayAcknowledgedFrameSequence: transport?.acknowledgedFrameSequence,
      pendingReplayFrames: transport?.pendingReplayFrames ?? 0,
      pendingReplayBytes: transport?.pendingReplayBytes ?? 0,
      lastError: this.lastError,
    });
  }

  sendTables(
    tables: readonly QwpTableBuffer[],
    encodeOptions: QwpIngressEncodeOptions = {},
  ): Promise<QwpIngressResponse> {
    this.throwIfUnavailable();
    const cap = this.maxBatchSizeBytes;
    if (cap === undefined) {
      return this.sendFrame(encodeQwpIngressFrame(tables, encodeOptions));
    }
    let planned: PlannedIngressFrames;
    try {
      planned = planIngressFrames(tables, encodeOptions, cap);
    } catch (error) {
      if (error instanceof QwpBatchTooLargeError) return Promise.reject(error);
      throw error;
    }
    return this.sendPlannedFrames(planned.frames);
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
   */
  sendTablesDelta(
    tables: readonly QwpTableBuffer[],
    encodeOptions: Pick<
      QwpIngressEncodeOptions,
      "gorilla" | "deferCommit"
    > = {},
  ): Promise<QwpIngressResponse> {
    this.throwIfUnavailable();
    const previousSize = this.symbolDictionary.size;
    const previousPublishedMaxSymbolId = this.publishedMaxSymbolId;
    const previousDeltaSymbolsPublished = this.deltaSymbolsPublished;
    const cap = this.maxBatchSizeBytes;
    if (cap !== undefined) {
      let planned: PlannedIngressFrames;
      try {
        planned = planIngressFrames(
          tables,
          {
            ...encodeOptions,
            dictionary: this.symbolDictionary,
            confirmedMaxSymbolId: this.publishedMaxSymbolId,
          },
          cap,
        );
      } catch (error) {
        if (error instanceof QwpBatchTooLargeError)
          return Promise.reject(error);
        throw error;
      }
      this.publishedMaxSymbolId = this.symbolDictionary.size - 1;
      this.deltaSymbolsPublished = true;
      try {
        return this.sendPlannedFrames(planned.frames);
      } catch (error) {
        this.symbolDictionary.truncate(previousSize);
        this.publishedMaxSymbolId = previousPublishedMaxSymbolId;
        this.deltaSymbolsPublished = previousDeltaSymbolsPublished;
        throw error;
      }
    }

    let frame: Uint8Array;
    try {
      frame = encodeQwpIngressFrame(tables, {
        ...encodeOptions,
        dictionary: this.symbolDictionary,
        confirmedMaxSymbolId: this.publishedMaxSymbolId,
      });
    } catch (error) {
      this.symbolDictionary.truncate(previousSize);
      throw error;
    }
    this.publishedMaxSymbolId = this.symbolDictionary.size - 1;
    this.deltaSymbolsPublished = true;
    try {
      return this.sendFrame(frame);
    } catch (error) {
      this.symbolDictionary.truncate(previousSize);
      this.publishedMaxSymbolId = previousPublishedMaxSymbolId;
      this.deltaSymbolsPublished = previousDeltaSymbolsPublished;
      throw error;
    }
  }

  /** Publishes tables with the automatic connection-scoped symbol dictionary. */
  async publishTablesDelta(
    tables: readonly QwpTableBuffer[],
    encodeOptions: Pick<
      QwpIngressEncodeOptions,
      "gorilla" | "deferCommit"
    > = {},
  ): Promise<void> {
    this.throwIfUnavailable();
    const previousSize = this.symbolDictionary.size;
    const previousPublishedMaxSymbolId = this.publishedMaxSymbolId;
    const previousDeltaSymbolsPublished = this.deltaSymbolsPublished;
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
        await this.publishPlannedFrames(planned.frames);
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
    } catch (error) {
      this.symbolDictionary.truncate(previousSize);
      this.publishedMaxSymbolId = previousPublishedMaxSymbolId;
      this.deltaSymbolsPublished = previousDeltaSymbolsPublished;
      throw error;
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
    this.throwIfUnavailable();
    const ackDeferredUntilCommit =
      frame.byteLength > QWP_FLAGS_OFFSET &&
      (frame[QWP_FLAGS_OFFSET] & QWP_FLAG_DEFER_COMMIT) !== 0;
    if (
      this.maxBatchSizeBytes !== undefined &&
      frame.byteLength > this.maxBatchSizeBytes
    ) {
      return Promise.reject(
        new QwpBatchTooLargeError(frame.byteLength, this.maxBatchSizeBytes),
      );
    }
    const sequence = this.nextSequence++;
    let pending!: PendingResponse;
    const response = new Promise<QwpIngressResponse>((resolve, reject) => {
      pending = { resolve, reject, payloadBytes: frame.byteLength };
    });
    this.pending.set(sequence, pending);
    this.totalFramesPublished++;
    this.totalBytesPublished += frame.byteLength;

    const sending = this.sendTail.then(async () => {
      this.throwIfUnavailable();
      await this.connection.send(frame);
    });
    this.sendTail = sending.catch((error: unknown) => {
      this.fail(error);
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
        if (ackDeferredUntilCommit) return;
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
    return response;
  }

  private sendPlannedFrames(
    frames: readonly Uint8Array[],
  ): Promise<QwpIngressResponse> {
    const responses = frames.map((frame) => this.sendFrame(frame));
    if (responses.length === 1) return responses[0];
    return Promise.all(responses).then(mergeIngressResponses);
  }

  private async publishPlannedFrames(
    frames: readonly Uint8Array[],
  ): Promise<void> {
    for (const frame of frames) await this.publishFrame(frame);
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

  close(code = 1000, reason = ""): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeNow(code, reason);
    return this.closePromise;
  }

  private async closeNow(code: number, reason: string): Promise<void> {
    this.closing = true;
    this.clearDurablePoll();
    this.rejectAll(new QwpIngressSessionClosedError());
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
    this.invokeCallback(this.options.onResponse, response);
    if (response.status === QWP_STATUS.DURABLE_ACK) {
      this.totalDurableAcks++;
      const advanced = this.applyDurableAck(response);
      this.invokeCallback(this.options.onDurableAck, response);
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
      return;
    }

    this.totalNacks++;
    const pending = this.pending.get(response.sequence);
    if (!pending) {
      // A late response after timeout, or a duplicate response, is harmless.
      return;
    }
    this.pending.delete(response.sequence);
    if (pending.timer) clearTimeout(pending.timer);
    const error = new QwpIngressNackError(response);
    pending.reject(error);
    const dictionaryGap =
      this.deltaSymbolsPublished &&
      response.status === QWP_STATUS.DICTIONARY_GAP;
    this.recordError(error, dictionaryGap, response);
    if (dictionaryGap) {
      // This wire cannot repair a missing prefix without reconnect catch-up.
      this.fail(error, true);
      void this.connection.close(1002, "QWP symbol dictionary gap");
    }
  }

  private invokeCallback<T>(
    callback: ((event: T) => void) | undefined,
    event: T,
  ): void {
    if (!callback) return;
    try {
      callback(event);
    } catch {
      // Observability callbacks must not break protocol progress.
    }
  }

  private emitProgress(
    kind: QwpIngressProgressKind,
    sequence?: bigint,
    response?: QwpIngressResponse,
  ): void {
    this.invokeCallback(this.options.onProgress, {
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
  ): Error {
    const observed =
      error instanceof Error
        ? error
        : new Error(`QWP ingress failed: ${error}`);
    this.lastError = observed;
    this.totalErrors++;
    this.invokeCallback(this.options.onError, {
      error: observed,
      terminal,
      timestampMs: Date.now(),
      response,
      metrics: this.metrics,
    });
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
    if (this.pendingDurableTargets.size === 0) {
      this.clearDurablePoll();
    } else {
      this.scheduleDurablePoll();
    }
    return advanced;
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
        : this.sendFrame(encodeQwpDurableAckPollFrame()).then(() => undefined);
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
  }
}
