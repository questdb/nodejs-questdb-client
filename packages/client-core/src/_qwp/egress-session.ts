import {
  decodeQwpEgressMessage,
  encodeQwpBinds,
  encodeQwpCancel,
  encodeQwpCredit,
  encodeQwpQueryRequest,
  QWP_COMPRESSION_CODEC,
  QWP_EGRESS_CAPABILITY,
  QWP_QUERY_FLAG_RESET_DICTIONARY,
  QWP_RESET_MASK_DICTIONARY,
  QwpBindSetter,
  QwpExecDoneMessage,
  type QwpNegotiatedEgressCompression,
  QwpProtocolError,
  QwpResultBatch,
  QwpResultBatchDecoder,
  QwpResultBatchView,
  QwpResultEndMessage,
  QwpServerInfoMessage,
} from "./_core";
import { QwpAsyncQueue } from "./_internal/async-queue";
import { QwpReconnectingEgressConnection } from "./_internal/reconnecting-egress-connection";
import {
  QwpBinaryConnection,
  QwpConnectionCloseInfo,
  QwpConnectionFactory,
  QwpEgressReplayResetEvent,
  QwpHandshakeMetadata,
  QwpReconnectOptions,
  QwpSendClosedError,
} from "./transport";

export interface QwpEgressSessionOptions {
  /** SERVER_INFO handshake deadline. Defaults to 5 seconds. */
  serverInfoTimeoutMs?: number;
  /** Default per-query send-ahead credit. Defaults to zero (unbounded). */
  initialCredit?: number | bigint;
  /** Maximum decoded batches waiting for a consumer. Defaults to 4. */
  bufferPoolSize?: number;
  /** Default per-query deadline. Zero or undefined disables query deadlines. */
  queryTimeoutMs?: number;
  /** Maximum wait for a terminal response after CANCEL. Defaults to 5 seconds. */
  cancelDrainTimeoutMs?: number;
  /**
   * Bounded failover policy. Failover and at-least-once active-query replay
   * are enabled by default; set false to keep one fixed connection.
   */
  reconnect?: QwpReconnectOptions | false;
  /**
   * Optional notification immediately before an active query is re-executed.
   * Not-yet-consumed batches are discarded automatically; callers that retain
   * an already-consumed prefix should discard it here. Omitting this callback
   * leaves replay enabled and is appropriate for idempotent consumers.
   */
  onReplayReset?: (event: QwpEgressReplayResetEvent) => void | Promise<void>;
}

export interface QwpEgressQueryOptions {
  /** Overrides session send-ahead credit. Zero explicitly disables flow control. */
  initialCredit?: number | bigint;
  /**
   * Replenishes positive initial credit by each RESULT_BATCH wire size after
   * the async iterator advances past that batch. Defaults to true.
   */
  autoCredit?: boolean;
  /** Per-query deadline overriding the session default. Zero disables it. */
  timeoutMs?: number;
  /** Sets typed positional parameters; index 0 maps to SQL placeholder `$1`. */
  binds?: QwpBindSetter;
  /** Advanced escape hatch for an already encoded bind section. */
  bindCount?: number;
  /** Advanced escape hatch for an already encoded bind section. */
  bindPayload?: Uint8Array;
  /**
   * Ask a capable server to reset its connection-scoped symbol dictionary.
   * Silently omitted when the server lacks QUERY_FLAGS for rolling upgrades.
   */
  resetDictionary?: boolean;
}

interface QwpValidatedEgressSessionOptions {
  readonly serverInfoTimeoutMs: number;
  readonly initialCredit: number | bigint;
  readonly bufferPoolSize: number;
  readonly queryTimeoutMs: number;
  readonly cancelDrainTimeoutMs: number;
}

interface QwpReplayableQueryRequest {
  readonly requestId: bigint;
  readonly sql: string;
  readonly initialCredit: number | bigint;
  readonly bindCount?: number;
  readonly bindPayload?: Uint8Array;
  readonly resetDictionary: boolean;
}

/** Default send-ahead credit used by Java and TypeScript: zero is unbounded. */
export const QWP_DEFAULT_EGRESS_INITIAL_CREDIT = 0;
/** Default wait for the initial or reconnected SERVER_INFO frame. */
export const QWP_DEFAULT_EGRESS_SERVER_INFO_TIMEOUT_MS = 5_000;
/** Default decoded result-buffer pool depth, matching the Java client. */
export const QWP_DEFAULT_EGRESS_BUFFER_POOL_SIZE = 4;

const MAX_UINT64 = 0xffffffffffffffffn;
const DEFAULT_EGRESS_RECONNECT_OPTIONS: Readonly<QwpReconnectOptions> = {
  maxAttempts: 8,
  initialBackoffMs: 50,
  maxBackoffMs: 1_000,
  maxDurationMs: 30_000,
};

function validateOptionalTimeout(
  value: number | undefined,
  name: string,
): number {
  const timeout = value ?? 0;
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return timeout;
}

function validateEgressSessionOptions(
  options: QwpEgressSessionOptions,
): QwpValidatedEgressSessionOptions {
  const serverInfoTimeoutMs =
    options.serverInfoTimeoutMs ?? QWP_DEFAULT_EGRESS_SERVER_INFO_TIMEOUT_MS;
  if (!Number.isFinite(serverInfoTimeoutMs) || serverInfoTimeoutMs <= 0) {
    throw new RangeError(
      "serverInfoTimeoutMs must be a positive finite number",
    );
  }
  return {
    serverInfoTimeoutMs,
    initialCredit: validateInitialCredit(
      options.initialCredit ?? QWP_DEFAULT_EGRESS_INITIAL_CREDIT,
      "initialCredit",
    ),
    bufferPoolSize: validateBufferPoolSize(
      options.bufferPoolSize ?? QWP_DEFAULT_EGRESS_BUFFER_POOL_SIZE,
    ),
    queryTimeoutMs: validateOptionalTimeout(
      options.queryTimeoutMs,
      "queryTimeoutMs",
    ),
    cancelDrainTimeoutMs: validatePositiveTimeout(
      options.cancelDrainTimeoutMs ?? 5_000,
      "cancelDrainTimeoutMs",
    ),
  };
}

function validateBufferPoolSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("bufferPoolSize must be a positive safe integer");
  }
  return value;
}

function validateInitialCredit(
  value: number | bigint,
  name: string,
): number | bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
    return value;
  }
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT64) {
    throw new RangeError(`${name} must fit in uint64`);
  }
  return value;
}

function validatePositiveTimeout(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}

export type QwpQueryCompletion = QwpResultEndMessage | QwpExecDoneMessage;

export class QwpEgressQueryError extends Error {
  constructor(
    readonly requestId: bigint,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "QwpEgressQueryError";
  }
}

/** A client-side query deadline expired and a QWP CANCEL was sent. */
export class QwpEgressQueryTimeoutError extends Error {
  constructor(
    readonly requestId: bigint,
    readonly timeoutMs: number,
  ) {
    super(`QWP query timed out after ${timeoutMs}ms [requestId=${requestId}]`);
    this.name = "QwpEgressQueryTimeoutError";
  }
}

/** Result iteration ended before the server completed the query. */
export class QwpEgressQueryAbandonedError extends Error {
  constructor(readonly requestId: bigint) {
    super(`QWP query result was abandoned [requestId=${requestId}]`);
    this.name = "QwpEgressQueryAbandonedError";
  }
}

/** The server did not terminate a cancelled query within the drain deadline. */
export class QwpEgressQueryCancelTimeoutError extends Error {
  constructor(
    readonly requestId: bigint,
    readonly timeoutMs: number,
  ) {
    super(
      `QWP cancelled query did not terminate after ${timeoutMs}ms [requestId=${requestId}]`,
    );
    this.name = "QwpEgressQueryCancelTimeoutError";
  }
}

export class QwpEgressSessionClosedError extends Error {
  constructor(readonly closeInfo?: QwpConnectionCloseInfo) {
    super(
      closeInfo
        ? `QWP egress connection closed [code=${closeInfo.code}, reason=${closeInfo.reason}]`
        : "QWP egress session is closed",
    );
    this.name = "QwpEgressSessionClosedError";
  }
}

interface QwpEgressQueryControl {
  cancel(requestId: bigint): Promise<void>;
  abandon(requestId: bigint): Promise<void>;
  grantCredit(
    requestId: bigint,
    additionalBytes: number | bigint,
  ): Promise<void>;
  expire(requestId: bigint, timeoutMs: number): void;
  rejectView(requestId: bigint, error: Error): Promise<void>;
}

interface QwpQueuedResultBatch {
  readonly batch: QwpResultBatch;
  readonly creditBytes: number;
}

type QwpBatchReservation = "reserved" | "retired" | "reset";

type QwpViewBatchReservation =
  | { readonly status: "reserved"; readonly slot: number }
  | { readonly status: "retired" | "reset" };

interface QwpCompletionWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/** Control handle returned by queryViews(). */
export interface QwpEgressViewQuery {
  readonly requestId: bigint;
  readonly completion: Promise<QwpQueryCompletion>;
  /** Waits without cancelling; false means only this wait timed out. */
  awaitCompletion(timeoutMs: number): Promise<boolean>;
  cancel(): Promise<void>;
  grantCredit(additionalBytes: number | bigint): Promise<void>;
  isDone(): boolean;
}

/**
 * Runs while one reusable batch view is valid. Do not retain the batch,
 * columns, or raw byte slices after the callback settles.
 */
export type QwpResultBatchViewHandler = (
  batch: QwpResultBatchView,
  query: QwpEgressViewQuery,
) => void | Promise<void>;

/** One QWP query/statement and its stream of materialized result batches. */
export class QwpEgressQuery implements AsyncIterable<QwpResultBatch> {
  private readonly batches = new QwpAsyncQueue<QwpQueuedResultBatch>();
  private readonly resolveCompletion: (value: QwpQueryCompletion) => void;
  private readonly rejectCompletion: (error: unknown) => void;
  private readonly completionWaiters = new Set<QwpCompletionWaiter>();
  private deliveredCreditBytes = 0;
  private bufferedBatchCount = 0;
  private bufferGeneration = 0;
  private readonly bufferWaiters = new Set<() => void>();
  private readonly availableViewSlots: number[];
  private viewTail: Promise<void> = Promise.resolve();
  private wireComplete = false;
  private terminal = false;
  private timeoutTimer?: ReturnType<typeof setTimeout>;
  readonly completion: Promise<QwpQueryCompletion>;

  constructor(
    readonly requestId: bigint,
    private readonly control: QwpEgressQueryControl,
    private readonly creditEnabled: boolean,
    private readonly autoCredit: boolean,
    private readonly bufferPoolSize: number,
    private readonly viewHandler?: QwpResultBatchViewHandler,
  ) {
    let resolve!: (value: QwpQueryCompletion) => void;
    let reject!: (error: unknown) => void;
    this.completion = new Promise<QwpQueryCompletion>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Consumers commonly use only `for await`; keep the parallel completion
    // rejection from becoming an unhandled promise while preserving awaitability.
    void this.completion.catch(() => undefined);
    this.resolveCompletion = resolve;
    this.rejectCompletion = reject;
    this.availableViewSlots = viewHandler
      ? Array.from({ length: bufferPoolSize }, (_, slot) => slot)
      : [];
  }

  [Symbol.asyncIterator](): AsyncIterator<QwpResultBatch> {
    if (this.viewHandler) {
      throw new Error(
        "queryViews() delivers batches through its callback and is not async-iterable",
      );
    }
    const iterator = this.batches[Symbol.asyncIterator]();
    return {
      next: async () => {
        await this.releaseDeliveredCredit();
        const result = await iterator.next();
        if (result.done) return { value: undefined, done: true };
        this.releaseBufferedBatches(1);
        this.deliveredCreditBytes = result.value.creditBytes;
        return { value: result.value.batch, done: false };
      },
      return: async () => {
        if (this.terminal) this.discardBufferedResults();
        else await this.control.abandon(this.requestId);
        return { value: undefined, done: true };
      },
    };
  }

  cancel(): Promise<void> {
    return this.control.cancel(this.requestId);
  }

  grantCredit(additionalBytes: number | bigint): Promise<void> {
    return this.control.grantCredit(this.requestId, additionalBytes);
  }

  /**
   * Waits for completion without changing the query lifecycle. A finite wait
   * returns false on expiry; the query remains active until it completes, is
   * cancelled explicitly, or its configured query deadline expires.
   */
  async awaitCompletion(timeoutMs: number): Promise<boolean> {
    const timeout = validateOptionalTimeout(timeoutMs, "completion timeoutMs");
    if (this.terminal) {
      await this.completion;
      return true;
    }
    if (timeout === 0) return false;
    return new Promise<boolean>((resolve, reject) => {
      const waiter: QwpCompletionWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve(true);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.completionWaiters.delete(waiter);
        resolve(false);
      }, timeout);
      this.completionWaiters.add(waiter);
    });
  }

  /** Whether the query has reached any terminal outcome. */
  isDone(): boolean {
    return this.terminal;
  }

  /** @internal Starts the deadline after QUERY_REQUEST reaches the transport. */
  armTimeout(timeoutMs: number): void {
    if (timeoutMs === 0 || this.terminal) return;
    this.timeoutTimer = setTimeout(() => {
      this.timeoutTimer = undefined;
      this.control.expire(this.requestId, timeoutMs);
    }, timeoutMs);
  }

  /** @internal Waits for one decoded materialized-batch slot. */
  async reserveMaterializedBatch(): Promise<QwpBatchReservation> {
    const generation = this.bufferGeneration;
    while (
      !this.terminal &&
      generation === this.bufferGeneration &&
      this.bufferedBatchCount >= this.bufferPoolSize
    ) {
      await new Promise<void>((resolve) => this.bufferWaiters.add(resolve));
    }
    if (this.terminal) return "retired";
    if (generation !== this.bufferGeneration) return "reset";
    this.bufferedBatchCount++;
    return "reserved";
  }

  /** @internal Publishes a batch after reserveMaterializedBatch(). */
  pushReserved(batch: QwpResultBatch, creditBytes: number): void {
    if (this.terminal) {
      this.releaseBufferedBatches(1);
      return;
    }
    this.batches.push({ batch, creditBytes });
  }

  /** @internal Releases a reservation when decoding fails. */
  releaseMaterializedBatch(): void {
    this.releaseBufferedBatches(1);
  }

  /** @internal Waits for one reusable zero-copy view slot. */
  async reserveViewBatch(): Promise<QwpViewBatchReservation> {
    const generation = this.bufferGeneration;
    while (
      !this.terminal &&
      generation === this.bufferGeneration &&
      this.availableViewSlots.length === 0
    ) {
      await new Promise<void>((resolve) => this.bufferWaiters.add(resolve));
    }
    if (this.terminal) return { status: "retired" };
    if (generation !== this.bufferGeneration) return { status: "reset" };
    return { status: "reserved", slot: this.availableViewSlots.shift()! };
  }

  /** @internal Queues a decoded view after reserveViewBatch(). */
  pushReservedView(
    batch: QwpResultBatchView,
    creditBytes: number,
    slot: number,
  ): void {
    if (this.terminal) {
      batch.release();
      this.releaseViewSlot(slot);
      return;
    }
    const generation = this.bufferGeneration;
    this.viewTail = this.viewTail.then(async () => {
      if (this.terminal || generation !== this.bufferGeneration) {
        batch.release();
        this.releaseViewSlot(slot);
        return;
      }
      let handlerError: Error | undefined;
      try {
        await this.viewHandler!(batch, this);
      } catch (error) {
        handlerError =
          error instanceof Error ? error : new Error(String(error));
      } finally {
        batch.release();
        this.releaseViewSlot(slot);
      }
      if (generation !== this.bufferGeneration) return;
      if (handlerError) {
        void this.control
          .rejectView(this.requestId, handlerError)
          .catch(() => undefined);
        return;
      }
      if (
        !this.autoCredit ||
        this.terminal ||
        this.wireComplete ||
        creditBytes === 0
      ) {
        return;
      }
      // Credit and cancellation sends must not hold a view slot or its drain
      // barrier: reconnect resets wait on that barrier before transport sends
      // resume. The session send tail preserves wire order and owns failures.
      void this.control
        .grantCredit(this.requestId, creditBytes)
        .catch(() => undefined);
    });
  }

  /** @internal Releases a reservation when zero-copy decoding fails. */
  releaseViewBatch(slot: number): void {
    this.releaseViewSlot(slot);
  }

  /** @internal */
  get usesViews(): boolean {
    return this.viewHandler !== undefined;
  }

  /** @internal */
  async finish(completion: QwpQueryCompletion): Promise<void> {
    this.wireComplete = true;
    if (this.viewHandler) await this.viewTail;
    if (this.terminal) return;
    this.terminal = true;
    this.wakeBufferWaiters();
    this.clearTimeout();
    this.deliveredCreditBytes = 0;
    this.batches.end();
    this.resolveCompletion(completion);
    for (const waiter of this.completionWaiters) waiter.resolve();
    this.completionWaiters.clear();
  }

  /** @internal Preserves batch/callback order before a wire query error. */
  async finishError(error: Error): Promise<void> {
    this.wireComplete = true;
    if (this.viewHandler) await this.viewTail;
    if (this.terminal) return;
    this.fail(error);
  }

  /** @internal */
  fail(error: unknown): void {
    if (this.terminal) return;
    this.terminal = true;
    this.wakeBufferWaiters();
    this.clearTimeout();
    this.deliveredCreditBytes = 0;
    this.batches.fail(error);
    this.rejectCompletion(error);
    for (const waiter of this.completionWaiters) waiter.reject(error);
    this.completionWaiters.clear();
  }

  /** @internal Discards queued results and retires the consumer immediately. */
  retire(error: Error): number {
    if (this.terminal) return 0;
    const discardedCredit = this.discardBufferedResults();
    this.fail(error);
    return discardedCredit;
  }

  /** @internal Whether the consumer has retired while the wire still drains. */
  get retired(): boolean {
    return this.terminal;
  }

  /** @internal Credit needed to discard a late batch while cancellation drains. */
  lateBatchCredit(creditBytes: number): number {
    return this.creditEnabled ? creditBytes : 0;
  }

  /** @internal */
  async resetForReplay(): Promise<void> {
    this.deliveredCreditBytes = 0;
    this.bufferGeneration++;
    this.wireComplete = false;
    this.releaseBufferedBatches(this.batches.clear().length);
    this.wakeBufferWaiters();
    await this.viewTail;
  }

  /** @internal Waits until all callback-scoped views have been released. */
  waitForViewDrain(): Promise<void> {
    return this.viewTail;
  }

  private clearTimeout(): void {
    if (!this.timeoutTimer) return;
    clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
  }

  private discardBufferedResults(): number {
    let creditBytes = this.deliveredCreditBytes;
    this.deliveredCreditBytes = 0;
    const dropped = this.batches.clear();
    this.releaseBufferedBatches(dropped.length);
    for (const queued of dropped) {
      creditBytes += queued.creditBytes;
    }
    return this.creditEnabled ? creditBytes : 0;
  }

  private releaseBufferedBatches(count: number): void {
    if (count > 0) {
      this.bufferedBatchCount = Math.max(0, this.bufferedBatchCount - count);
    }
    this.wakeBufferWaiters();
  }

  private wakeBufferWaiters(): void {
    for (const resolve of this.bufferWaiters) resolve();
    this.bufferWaiters.clear();
  }

  private releaseViewSlot(slot: number): void {
    this.availableViewSlots.push(slot);
    this.wakeBufferWaiters();
  }

  private async releaseDeliveredCredit(): Promise<void> {
    const creditBytes = this.deliveredCreditBytes;
    this.deliveredCreditBytes = 0;
    if (!this.autoCredit || this.terminal || creditBytes === 0) return;
    try {
      await this.control.grantCredit(this.requestId, creditBytes);
    } catch (error) {
      // Transport failures fail the query through the session send tail. If a
      // terminal response won the race, no replenishment is needed anymore.
      if (!this.terminal) throw error;
    }
  }
}

/**
 * Browser-safe QWP egress session.
 *
 * The server currently executes one query at a time per connection, so this
 * session deliberately rejects overlapping query calls. A completed query's
 * materialized batches may still be consumed while the next query runs.
 */
export class QwpEgressSession implements QwpEgressQueryControl {
  private readonly decoder = new QwpResultBatchDecoder();
  private readonly receiveLoop: Promise<void>;
  private readonly resolveServerInfo: (value: QwpServerInfoMessage) => void;
  private readonly rejectServerInfo: (error: unknown) => void;
  private readonly serverInfoTimer: ReturnType<typeof setTimeout>;
  private readonly defaultQueryTimeoutMs: number;
  private readonly defaultInitialCredit: number | bigint;
  private readonly bufferPoolSize: number;
  private readonly cancelDrainTimeoutMs: number;
  private readonly idleWaiters = new Set<() => void>();
  private active?: QwpEgressQuery;
  private activeRequest?: QwpReplayableQueryRequest;
  private nextRequestId = 0n;
  private sendTail: Promise<void> = Promise.resolve();
  private currentServerInfo?: QwpServerInfoMessage;
  private failure?: Error;
  private closing = false;
  private closePromise?: Promise<void>;
  private cancelDrainRequestId?: bigint;
  private cancelDrainTimer?: ReturnType<typeof setTimeout>;
  /** Initial SERVER_INFO; use serverInfo for the current post-failover snapshot. */
  readonly ready: Promise<QwpServerInfoMessage>;

  constructor(
    private readonly connection: QwpBinaryConnection,
    options: QwpEgressSessionOptions = {},
  ) {
    let validated: QwpValidatedEgressSessionOptions;
    try {
      if (
        options.reconnect &&
        !(connection instanceof QwpReconnectingEgressConnection)
      ) {
        throw new Error(
          "egress reconnect options require QwpEgressSession.connect(factory, options)",
        );
      }
      validated = validateEgressSessionOptions(options);
    } catch (error) {
      try {
        void connection
          .close(1002, "invalid QWP egress session options")
          .catch(() => undefined);
      } catch {
        // Preserve the configuration error when transport cleanup also fails.
      }
      throw error;
    }
    this.defaultQueryTimeoutMs = validated.queryTimeoutMs;
    this.defaultInitialCredit = validated.initialCredit;
    this.bufferPoolSize = validated.bufferPoolSize;
    this.cancelDrainTimeoutMs = validated.cancelDrainTimeoutMs;
    let resolve!: (value: QwpServerInfoMessage) => void;
    let reject!: (error: unknown) => void;
    this.ready = new Promise<QwpServerInfoMessage>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    void this.ready.catch(() => undefined);
    this.resolveServerInfo = resolve;
    this.rejectServerInfo = reject;
    this.serverInfoTimer = setTimeout(() => {
      const error = new Error("timed out waiting for QWP SERVER_INFO");
      this.fail(error);
      void this.connection
        .close(1002, "missing QWP SERVER_INFO")
        .catch(() => undefined);
    }, validated.serverInfoTimeoutMs);
    this.receiveLoop = this.consumeMessages();
  }

  static async connect(
    factory: QwpConnectionFactory,
    options: QwpEgressSessionOptions = {},
    /** Cancels a connection or SERVER_INFO handshake still in progress. */
    signal?: AbortSignal,
  ): Promise<QwpEgressSession> {
    const validated = validateEgressSessionOptions(options);
    const state: { session?: QwpEgressSession } = {};
    const reconnectOptions =
      options.reconnect === false
        ? undefined
        : (options.reconnect ?? DEFAULT_EGRESS_RECONNECT_OPTIONS);
    const connection = reconnectOptions
      ? await QwpReconnectingEgressConnection.connect(
          factory,
          reconnectOptions,
          validated.serverInfoTimeoutMs,
          (serverInfo) => state.session?.prepareConnectionReset(serverInfo),
          (serverInfo, requestId) => {
            const session = state.session;
            if (!session) {
              throw new QwpProtocolError(
                "QWP egress session is unavailable while encoding a query",
              );
            }
            return session.encodeActiveQueryRequest(serverInfo, requestId);
          },
          options.onReplayReset
            ? async (event) => {
                await options.onReplayReset!(event);
              }
            : undefined,
          options.reconnect !== undefined,
          signal,
        )
      : await factory(signal);
    let session: QwpEgressSession | undefined;
    const abortOpening = (): void => {
      if (session) {
        void session
          .close(1000, "QWP client closed while connecting")
          .catch(() => undefined);
      } else {
        void connection
          .close(1000, "QWP client closed while connecting")
          .catch(() => undefined);
      }
    };
    try {
      if (signal?.aborted) throw new QwpSendClosedError();
      session = new QwpEgressSession(connection, options);
      state.session = session;
      signal?.addEventListener("abort", abortOpening, { once: true });
      await session.ready;
      if (signal?.aborted) throw new QwpSendClosedError();
      return session;
    } catch (error) {
      if (state.session) {
        await state.session
          .close(1002, "missing QWP SERVER_INFO")
          .catch(() => undefined);
      } else {
        await connection
          .close(1002, "invalid QWP egress session")
          .catch(() => undefined);
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortOpening);
    }
  }

  get closed(): Promise<QwpConnectionCloseInfo> {
    return this.connection.closed;
  }

  get handshake(): QwpHandshakeMetadata {
    return this.connection.handshake;
  }

  /**
   * Cached immutable SERVER_INFO for the currently bound endpoint. Reading it
   * never initiates a connection or failover walk. It is undefined before the
   * initial bind and refreshes after every successful reconnect.
   */
  get serverInfo(): QwpServerInfoMessage | undefined {
    return this.currentServerInfo;
  }

  /** Effective codec and level echoed by the server on the active endpoint. */
  get negotiatedCompression(): QwpNegotiatedEgressCompression | undefined {
    const serverInfo = this.currentServerInfo;
    if (
      serverInfo?.compressionCodec === QWP_COMPRESSION_CODEC.ZSTD &&
      serverInfo.compressionLevel !== null
    ) {
      return { codec: "zstd", level: serverInfo.compressionLevel };
    }
    if (serverInfo?.compressionCodec === QWP_COMPRESSION_CODEC.RAW) {
      return { codec: "raw", level: 0 };
    }
    if (serverInfo?.compressionCodec !== null && serverInfo !== undefined) {
      return {
        codec: "unknown",
        level: 0,
        contentEncoding: `codec=${serverInfo.compressionCodec};level=${serverInfo.compressionLevel ?? 0}`,
      };
    }
    return this.connection.handshake.negotiatedCompression;
  }

  /** Effective Zstd level, or zero for raw or unknown negotiation. */
  get negotiatedZstdLevel(): number {
    const compression = this.negotiatedCompression;
    return compression?.codec === "zstd" ? compression.level : 0;
  }

  async query(
    sql: string,
    options: QwpEgressQueryOptions = {},
  ): Promise<QwpEgressQuery> {
    return this.startQuery(sql, options);
  }

  /**
   * Executes a query through a bounded, reusable, zero-copy batch callback.
   * Callbacks run serially and are awaited before their batch is invalidated
   * and flow-control credit is replenished. The receive loop decodes ahead
   * into the remaining reusable slots, up to bufferPoolSize.
   */
  async queryViews(
    sql: string,
    onBatch: QwpResultBatchViewHandler,
    options: QwpEgressQueryOptions = {},
  ): Promise<QwpEgressViewQuery> {
    if (typeof onBatch !== "function") {
      throw new TypeError("queryViews onBatch must be a function");
    }
    return this.startQuery(sql, options, onBatch);
  }

  private async startQuery(
    sql: string,
    options: QwpEgressQueryOptions,
    viewHandler?: QwpResultBatchViewHandler,
  ): Promise<QwpEgressQuery> {
    const timeoutMs = validateOptionalTimeout(
      options.timeoutMs ?? this.defaultQueryTimeoutMs,
      "timeoutMs",
    );
    const initialCredit = validateInitialCredit(
      options.initialCredit ?? this.defaultInitialCredit,
      "initialCredit",
    );
    if (
      options.autoCredit !== undefined &&
      typeof options.autoCredit !== "boolean"
    ) {
      throw new TypeError("autoCredit must be a boolean");
    }
    await this.ready;
    this.throwIfUnavailable();
    if (this.active) {
      throw new Error("a QWP query is already active on this connection");
    }
    const requestId = this.nextRequestId++;
    const creditEnabled =
      typeof initialCredit === "bigint"
        ? initialCredit > 0n
        : initialCredit > 0;
    const query = new QwpEgressQuery(
      requestId,
      this,
      creditEnabled,
      creditEnabled && (options.autoCredit ?? true),
      this.bufferPoolSize,
      viewHandler,
    );
    if (
      options.binds !== undefined &&
      (options.bindCount !== undefined || options.bindPayload !== undefined)
    ) {
      throw new Error(
        "typed binds cannot be mixed with raw bindCount/bindPayload",
      );
    }
    const encodedBinds = options.binds
      ? encodeQwpBinds(options.binds)
      : undefined;
    const request: QwpReplayableQueryRequest = {
      requestId,
      sql,
      initialCredit,
      bindCount: encodedBinds?.count ?? options.bindCount,
      bindPayload: (encodedBinds?.payload ?? options.bindPayload)?.slice(),
      resetDictionary: options.resetDictionary === true,
    };
    this.decoder.resetQuerySchema();
    this.active = query;
    this.activeRequest = request;
    try {
      await this.send(
        this.encodeQueryRequest(request, this.currentServerInfo!),
      );
    } catch (error) {
      this.clearActive(query);
      query.fail(error);
      throw error;
    }
    query.armTimeout(timeoutMs);
    return query;
  }

  cancel(requestId: bigint): Promise<void> {
    this.requireActive(requestId);
    return this.cancelAndDrain(requestId, 0);
  }

  abandon(requestId: bigint): Promise<void> {
    const query = this.requireActive(requestId);
    const discardedCredit = query.retire(
      new QwpEgressQueryAbandonedError(requestId),
    );
    return this.cancelAndDrain(requestId, discardedCredit);
  }

  grantCredit(
    requestId: bigint,
    additionalBytes: number | bigint,
  ): Promise<void> {
    this.requireActive(requestId);
    return this.sendWhileActive(
      requestId,
      encodeQwpCredit(requestId, additionalBytes),
    );
  }

  expire(requestId: bigint, timeoutMs: number): void {
    if (!this.active || this.active.requestId !== requestId) return;
    const discardedCredit = this.active.retire(
      new QwpEgressQueryTimeoutError(requestId, timeoutMs),
    );
    try {
      void this.cancelAndDrain(requestId, discardedCredit).catch(
        () => undefined,
      );
    } catch (error) {
      this.fail(error);
    }
  }

  async rejectView(requestId: bigint, error: Error): Promise<void> {
    const query = this.requireActive(requestId);
    const discardedCredit = query.retire(error);
    await this.cancelAndDrain(requestId, discardedCredit);
  }

  close(code = 1000, reason = ""): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeNow(code, reason);
    return this.closePromise;
  }

  /**
   * Best-effort cancellation followed by physical connection teardown for
   * facade shutdown. Unlike pooled lease return, this does not wait for the
   * server to finish draining the cancelled query.
   *
   * @internal
   */
  shutdownForClientClose(): Promise<void> {
    const active = this.active;
    if (active && !active.retired && !this.closing && !this.failure) {
      try {
        void this.connection
          .send(encodeQwpCancel(active.requestId))
          .catch(() => undefined);
      } catch {
        // Cancellation is advisory; physical teardown is authoritative.
      }
    }
    return this.close(1001, "QWP client shutting down");
  }

  /**
   * Cancels and drains an active operation before a pooled lease is returned.
   * False means the physical session is no longer safe to reuse.
   *
   * @internal
   */
  async prepareForPoolRelease(): Promise<boolean> {
    if (this.failure || this.closing) return false;
    const active = this.active;
    if (!active) return true;
    const idle = this.waitUntilIdle();
    if (!active.retired) {
      try {
        await this.abandon(active.requestId);
      } catch (error) {
        this.fail(error);
      }
    }
    await idle;
    return !this.failure && !this.closing;
  }

  private async closeNow(code: number, reason: string): Promise<void> {
    this.closing = true;
    clearTimeout(this.serverInfoTimer);
    this.clearCancelDrain();
    const error = new QwpEgressSessionClosedError();
    this.rejectServerInfo(error);
    const active = this.active;
    active?.fail(error);
    this.clearActive();
    let transportClose: Promise<void>;
    try {
      transportClose = this.connection.close(code, reason);
    } catch (closeError) {
      transportClose = Promise.reject(closeError);
    }
    const [, closeResult] = await Promise.allSettled([
      this.sendTail,
      transportClose,
      this.receiveLoop,
      active?.waitForViewDrain() ?? Promise.resolve(),
    ]);
    if (closeResult.status === "rejected") throw closeResult.reason;
  }

  private async consumeMessages(): Promise<void> {
    try {
      for await (const payload of this.connection.messages) {
        try {
          const message = decodeQwpEgressMessage(payload);
          switch (message.kind) {
            case "server-info":
              if (this.currentServerInfo) {
                throw new QwpProtocolError(
                  "received duplicate QWP SERVER_INFO",
                );
              }
              this.currentServerInfo = message;
              clearTimeout(this.serverInfoTimer);
              this.resolveServerInfo(message);
              break;
            case "cache-reset":
              // Delta-mode views alias the decoder's symbol dictionary and
              // resolve their cells lazily inside the view callback, so
              // clearing it in place mid-callback turns live SYMBOL cells into
              // undefined. Drain in-flight views first -- delivering them
              // against the dictionary they were decoded with -- exactly as the
              // client-initiated reset does through resetForReplay().
              if (this.active?.usesViews) {
                await this.active.waitForViewDrain();
              }
              this.decoder.applyCacheReset(message.resetMask);
              break;
            case "result-batch": {
              const query = this.requireActive(message.requestId);
              if (query.retired) {
                const creditBytes = query.lateBatchCredit(payload.byteLength);
                if (creditBytes > 0) {
                  void this.sendWhileActive(
                    message.requestId,
                    encodeQwpCredit(message.requestId, creditBytes),
                  ).catch(() => undefined);
                }
              } else if (query.usesViews) {
                const reservation = await query.reserveViewBatch();
                if (reservation.status === "retired") {
                  const creditBytes = query.lateBatchCredit(payload.byteLength);
                  if (creditBytes > 0) {
                    void this.sendWhileActive(
                      message.requestId,
                      encodeQwpCredit(message.requestId, creditBytes),
                    ).catch(() => undefined);
                  }
                } else if (reservation.status === "reserved") {
                  try {
                    query.pushReservedView(
                      this.decoder.decodeView(message, reservation.slot),
                      payload.byteLength,
                      reservation.slot,
                    );
                  } catch (error) {
                    this.decoder.releaseView(reservation.slot);
                    query.releaseViewBatch(reservation.slot);
                    throw error;
                  }
                }
              } else {
                const reservation = await query.reserveMaterializedBatch();
                if (reservation === "retired") {
                  const creditBytes = query.lateBatchCredit(payload.byteLength);
                  if (creditBytes > 0) {
                    void this.sendWhileActive(
                      message.requestId,
                      encodeQwpCredit(message.requestId, creditBytes),
                    ).catch(() => undefined);
                  }
                } else if (reservation === "reserved") {
                  try {
                    query.pushReserved(
                      this.decoder.decode(message),
                      payload.byteLength,
                    );
                  } catch (error) {
                    query.releaseMaterializedBatch();
                    throw error;
                  }
                }
              }
              break;
            }
            case "result-end": {
              const query = this.requireActive(message.requestId);
              this.clearCancelDrain(message.requestId);
              await query.finish(message);
              this.clearActive(query);
              break;
            }
            case "exec-done": {
              const query = this.requireActive(message.requestId);
              this.clearCancelDrain(message.requestId);
              await query.finish(message);
              this.clearActive(query);
              break;
            }
            case "query-error": {
              const query = this.requireActive(message.requestId);
              this.clearCancelDrain(message.requestId);
              await query.finishError(
                new QwpEgressQueryError(
                  message.requestId,
                  message.status,
                  message.message,
                ),
              );
              this.clearActive(query);
              break;
            }
          }
        } catch (error) {
          if (
            error instanceof QwpProtocolError &&
            this.connection instanceof QwpReconnectingEgressConnection
          ) {
            await this.connection.recoverProtocolFailure(error);
            continue;
          }
          throw error;
        }
      }
      if (!this.closing) {
        this.fail(
          new QwpEgressSessionClosedError(await this.connection.closed),
        );
      }
    } catch (error) {
      this.fail(error);
      if (error instanceof QwpProtocolError) {
        // Matches the ingress session: a connection close() that rejects must
        // not become an unhandled rejection on an error-handling path.
        void this.connection
          .close(1002, "invalid QWP egress message")
          .catch(() => undefined);
      }
    }
  }

  private requireActive(requestId: bigint): QwpEgressQuery {
    this.throwIfUnavailable();
    if (!this.active || this.active.requestId !== requestId) {
      throw new QwpProtocolError(
        `QWP response references inactive request ID ${requestId}`,
      );
    }
    return this.active;
  }

  private async prepareConnectionReset(
    serverInfo: QwpServerInfoMessage,
  ): Promise<void> {
    this.currentServerInfo = serverInfo;
    await this.active?.resetForReplay();
    this.decoder.applyCacheReset(QWP_RESET_MASK_DICTIONARY);
    this.decoder.resetQuerySchema();
  }

  private encodeActiveQueryRequest(
    serverInfo: QwpServerInfoMessage,
    requestId: bigint,
  ): Uint8Array {
    const request = this.activeRequest;
    if (!request || request.requestId !== requestId) {
      throw new QwpProtocolError(
        `QWP egress replay references inactive request ID ${requestId}`,
      );
    }
    return this.encodeQueryRequest(request, serverInfo);
  }

  private encodeQueryRequest(
    request: QwpReplayableQueryRequest,
    serverInfo: QwpServerInfoMessage,
  ): Uint8Array {
    const supportsQueryFlags =
      (serverInfo.capabilities & QWP_EGRESS_CAPABILITY.QUERY_FLAGS) !== 0;
    return encodeQwpQueryRequest({
      requestId: request.requestId,
      sql: request.sql,
      initialCredit: request.initialCredit,
      bindCount: request.bindCount,
      bindPayload: request.bindPayload,
      queryFlags:
        request.resetDictionary && supportsQueryFlags
          ? QWP_QUERY_FLAG_RESET_DICTIONARY
          : undefined,
    });
  }

  private cancelAndDrain(
    requestId: bigint,
    discardedCredit: number,
  ): Promise<void> {
    this.armCancelDrain(requestId);
    const cancelling = this.sendWhileActive(
      requestId,
      encodeQwpCancel(requestId),
    );
    if (discardedCredit === 0) return cancelling;
    return cancelling.then(() =>
      this.sendWhileActive(
        requestId,
        encodeQwpCredit(requestId, discardedCredit),
      ),
    );
  }

  private armCancelDrain(requestId: bigint): void {
    if (this.cancelDrainRequestId === requestId && this.cancelDrainTimer)
      return;
    this.clearCancelDrain();
    this.cancelDrainRequestId = requestId;
    this.cancelDrainTimer = setTimeout(() => {
      this.cancelDrainTimer = undefined;
      this.cancelDrainRequestId = undefined;
      if (!this.active || this.active.requestId !== requestId) return;
      const error = new QwpEgressQueryCancelTimeoutError(
        requestId,
        this.cancelDrainTimeoutMs,
      );
      this.fail(error);
      try {
        void this.connection
          .close(1011, "QWP cancellation drain timed out")
          .catch(() => undefined);
      } catch {
        // The typed cancellation failure remains the session's terminal error.
      }
    }, this.cancelDrainTimeoutMs);
  }

  private clearCancelDrain(requestId?: bigint): void {
    if (
      requestId !== undefined &&
      this.cancelDrainRequestId !== undefined &&
      requestId !== this.cancelDrainRequestId
    ) {
      return;
    }
    if (this.cancelDrainTimer) clearTimeout(this.cancelDrainTimer);
    this.cancelDrainTimer = undefined;
    this.cancelDrainRequestId = undefined;
  }

  private send(payload: Uint8Array): Promise<void> {
    this.throwIfUnavailable();
    const sending = this.sendTail.then(async () => {
      this.throwIfUnavailable();
      await this.connection.send(payload);
    });
    this.sendTail = sending.catch((error: unknown) => this.fail(error));
    return sending;
  }

  private sendWhileActive(
    requestId: bigint,
    payload: Uint8Array,
  ): Promise<void> {
    this.throwIfUnavailable();
    const sending = this.sendTail.then(async () => {
      this.throwIfUnavailable();
      if (!this.active || this.active.requestId !== requestId) return;
      await this.connection.send(payload);
    });
    this.sendTail = sending.catch((error: unknown) => this.fail(error));
    return sending;
  }

  private throwIfUnavailable(): void {
    if (this.failure) throw this.failure;
    if (this.closing) throw new QwpEgressSessionClosedError();
  }

  private clearActive(expected?: QwpEgressQuery): void {
    if (expected && this.active !== expected) return;
    if (!this.active) return;
    this.active = undefined;
    this.activeRequest = undefined;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private waitUntilIdle(): Promise<void> {
    if (!this.active) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private fail(error: unknown): void {
    if (this.failure) return;
    clearTimeout(this.serverInfoTimer);
    this.clearCancelDrain();
    this.failure =
      error instanceof Error ? error : new Error(`QWP egress failed: ${error}`);
    this.rejectServerInfo(this.failure);
    this.active?.fail(this.failure);
    this.clearActive();
  }
}
