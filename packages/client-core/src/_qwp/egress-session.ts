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
  QWP_STATUS,
  QwpBindSetter,
  QwpExecDoneMessage,
  type QwpNegotiatedEgressCompression,
  QwpProtocolError,
  QwpResultBatch,
  QwpResultBatchDecoder,
  type QwpResultBatchMessage,
  QwpResultBatchView,
  QwpResultEndMessage,
  QwpServerInfoMessage,
} from "./_core";
import { QwpAsyncQueue } from "./_internal/async-queue";
import { validateQwpMaxBatchRows } from "./_internal/egress-limits";
import { monotonicNowMs } from "./_internal/monotonic-clock";
import {
  QWP_DEFAULT_EGRESS_RECONNECT_OPTIONS,
  QwpReconnectingEgressConnection,
} from "./_internal/reconnecting-egress-connection";
import { validateQwpEgressReconnectBackoffs } from "./_internal/reconnect-backoff";
import {
  exceedsQwpTimerCeiling,
  QWP_MAX_TIMER_DELAY_MS,
} from "./_internal/timer-bounds";
import {
  QwpConnectionCloseInfo,
  QwpEgressReconnectOptions,
  QwpEgressReplayResetEvent,
  QwpHandshakeMetadata,
  QwpSendClosedError,
} from "./transport";
import type {
  QwpBinaryConnection,
  QwpConnectionFactory,
} from "./_internal/binary-connection";

/** Immutable notification-inbox counters for an egress session. */
export interface QwpEgressMetrics {
  readonly deliveredConnectionNotifications: number;
  readonly droppedConnectionNotifications: number;
}

/**
 * Flow control, deadlines and failover of a query session. Each runtime's
 * egress options include them; neither package root exports this interface on
 * its own.
 */
export interface QwpEgressSessionOptions {
  /**
   * SERVER_INFO handshake deadline. Defaults to 5 seconds. Capped at
   * 2,147,483,647ms (the host timer ceiling); a larger value throws a
   * `RangeError`.
   */
  serverInfoTimeoutMs?: number;
  /** Default per-query send-ahead credit. Defaults to zero (unbounded). */
  initialCredit?: number | bigint;
  /** Maximum decoded batches waiting for a consumer. Defaults to 4. */
  bufferPoolSize?: number;
  /**
   * Default per-query timeout, measured from the `query()` call. Zero or
   * undefined disables query timeouts. Once it expires no further batch is
   * delivered and the query is cancelled; see
   * {@link QwpEgressQueryOptions.timeoutMs} for how the outcome is reported.
   * The connect-string key is `query_timeout_ms`. Capped at 2,147,483,647ms
   * (the host timer ceiling); a larger value throws a `RangeError`.
   */
  queryTimeoutMs?: number;
  /**
   * Maximum wait for a terminal response after CANCEL, and the grace period of
   * a query timeout: how long an expired query may take to end before its
   * caller is released, and how long its connection may then take to drain
   * it. Defaults to 5 seconds. Capped at 2,147,483,647ms (the host timer
   * ceiling); a larger value throws a `RangeError`.
   */
  cancelDrainTimeoutMs?: number;
  /**
   * Rejects a RESULT_BATCH declaring more rows than this. The connect helpers
   * default it to the `maxBatchRows` they put on the wire, so the request the
   * client makes is also the bound it enforces; decoder scratch is sized from
   * the declared row count and retained per pool slot, so an answer above the
   * request would set this session's memory floor for its lifetime.
   */
  maxBatchRows?: number;
  /**
   * Bounded failover policy. Failover and at-least-once active-query replay
   * are enabled by default; set false to keep one fixed connection.
   */
  reconnect?: QwpEgressReconnectOptions | false;
  /**
   * Bounded inbox depth for `reconnect.onEvent`. Defaults to 64, matching
   * ingress. Overflow drops the oldest pending notification.
   */
  connectionListenerInboxCapacity?: number;
  /**
   * Default notification immediately before an active query is re-executed.
   * Not-yet-consumed batches are discarded automatically; callers that retain
   * an already-consumed prefix should discard it here. A query's own
   * onReplayReset overrides this callback, which is important for pooled
   * sessions whose request IDs may overlap.
   */
  onReplayReset?: (event: QwpEgressReplayResetEvent) => void | Promise<void>;
}

export interface QwpEgressQueryOptions {
  /**
   * Notification before this query is replayed after failover. Use it to clear
   * results already consumed from the old connection. Overrides the session's
   * onReplayReset for this query; the callback is awaited before replay.
   */
  onReplayReset?: (event: QwpEgressReplayResetEvent) => void | Promise<void>;
  /** Overrides session send-ahead credit. Zero explicitly disables flow control. */
  initialCredit?: number | bigint;
  /**
   * Replenishes positive initial credit by each RESULT_BATCH wire size after
   * the async iterator advances past that batch. Defaults to true.
   */
  autoCredit?: boolean;
  /**
   * Per-query timeout overriding the session default; zero disables it.
   *
   * It bounds the whole query, measured from the `query()` call: waiting for a
   * previous query to drain, any reconnect, server execution, and the time
   * spent consuming results, which is not interrupted. Once it expires no
   * further batch is delivered and the query is cancelled. The outcome is the
   * server's answer: a statement that completed, or a result that ended with
   * nothing withheld, still succeeds; otherwise iteration and `completion`
   * reject with {@link QwpEgressQueryTimeoutError}. A cancellation the
   * application requested before the timeout is reported as such. If the
   * server has not ended the query within `cancelDrainTimeoutMs`, or the
   * connection is lost, the timeout is reported at once and the query is not
   * replayed. Capped at 2,147,483,647ms (the host timer ceiling); a larger
   * value throws a `RangeError`.
   */
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
  readonly maxBatchRows?: number;
  readonly connectionListenerInboxCapacity: number;
}

interface QwpReplayableQueryRequest {
  readonly requestId: bigint;
  readonly sql: string;
  initialCredit: number | bigint;
  readonly bindCount?: number;
  readonly bindPayload?: Uint8Array;
  readonly resetDictionary: boolean;
  readonly onReplayReset?: QwpEgressQueryOptions["onReplayReset"];
}

/** Default send-ahead credit used by Java and TypeScript: zero is unbounded. */
export const QWP_DEFAULT_EGRESS_INITIAL_CREDIT = 0;
/** Default wait for the initial or reconnected SERVER_INFO frame. */
export const QWP_DEFAULT_EGRESS_SERVER_INFO_TIMEOUT_MS = 5_000;
/** Default decoded result-buffer pool depth, matching the Java client. */
export const QWP_DEFAULT_EGRESS_BUFFER_POOL_SIZE = 4;

const MAX_UINT64 = 0xffffffffffffffffn;
/** No RESULT_BATCH has been decoded yet; batch sequences start at zero. */
const NO_DECODED_BATCH = -1n;
function validateOptionalTimeout(
  value: number | undefined,
  name: string,
): number {
  const timeout = value ?? 0;
  if (
    !Number.isFinite(timeout) ||
    timeout < 0 ||
    exceedsQwpTimerCeiling(timeout)
  ) {
    throw new RangeError(
      `${name} must be a non-negative finite number no greater than ${QWP_MAX_TIMER_DELAY_MS}`,
    );
  }
  return timeout;
}

function validateEgressSessionOptions(
  options: QwpEgressSessionOptions,
): QwpValidatedEgressSessionOptions {
  validateQwpEgressReconnectBackoffs(options.reconnect);
  const serverInfoTimeoutMs =
    options.serverInfoTimeoutMs ?? QWP_DEFAULT_EGRESS_SERVER_INFO_TIMEOUT_MS;
  if (
    !Number.isFinite(serverInfoTimeoutMs) ||
    serverInfoTimeoutMs <= 0 ||
    exceedsQwpTimerCeiling(serverInfoTimeoutMs)
  ) {
    throw new RangeError(
      `serverInfoTimeoutMs must be a positive finite number no greater than ${QWP_MAX_TIMER_DELAY_MS}`,
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
    maxBatchRows: validateQwpMaxBatchRows(options.maxBatchRows),
    connectionListenerInboxCapacity: validateInboxCapacity(
      options.connectionListenerInboxCapacity ?? 64,
    ),
  };
}

function validateInboxCapacity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(
      "connectionListenerInboxCapacity must be a positive safe integer",
    );
  }
  return value;
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
  if (!Number.isFinite(value) || value <= 0 || exceedsQwpTimerCeiling(value)) {
    throw new RangeError(
      `${name} must be a positive finite number no greater than ${QWP_MAX_TIMER_DELAY_MS}`,
    );
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

/**
 * The query ran past its timeout (`queryTimeoutMs` or the per-query
 * `timeoutMs`) and was cancelled. Reported once the server has ended the
 * query, or after the grace period if it has not.
 */
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

/**
 * The server did not terminate a cancelled query within the drain deadline,
 * so the session gave up on the connection.
 */
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
    replayOnReconnect?: boolean,
    acceptWhenReconnectStarts?: boolean,
  ): Promise<void>;
  /** The query's timeout expired. */
  expire(requestId: bigint): void;
  /** An expired query has not ended within the grace period. */
  expireGrace(requestId: bigint): void;
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

/** Query operations that are safe while a reusable batch callback is active. */
export type QwpEgressViewCallbackControl = Omit<
  QwpEgressViewQuery,
  "completion"
>;

/**
 * Runs while one reusable batch view is valid. Do not retain the batch,
 * columns, or raw byte slices after the callback settles.
 */
export type QwpResultBatchViewHandler = (
  batch: QwpResultBatchView,
  query: QwpEgressViewCallbackControl,
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
  private readonly viewControl?: QwpEgressViewCallbackControl;
  private viewTail: Promise<void> = Promise.resolve();
  private decodedBatchCount = 0n;
  // Sequences are zero-based, so a one-batch response ends at 0 and the count
  // is 1. Comparing RESULT_END.finalSequence with the count rejected every
  // ordinary response: QuestDB sends the sequence of the last RESULT_BATCH it
  // emitted, not how many it emitted.
  private lastDecodedBatchSequence = NO_DECODED_BATCH;
  private decodedRowCount = 0n;
  private wireComplete = false;
  private terminal = false;
  // Set when the timeout expires. From then on no result batch reaches the
  // consumer, while the outcome still waits for the server's terminal response:
  // a statement that completed has taken effect and is reported as done.
  private deadlineReached = false;
  // A batch was kept from the consumer after the timeout expired, so a
  // RESULT_END that follows no longer closes a complete result.
  private withheldBatch = false;
  private cancelledByApplication = false;
  private cancelClaimed = false;
  // The deadline, then the grace period after it. One at a time.
  private timeoutTimer?: ReturnType<typeof setTimeout>;
  readonly completion: Promise<QwpQueryCompletion>;

  constructor(
    readonly requestId: bigint,
    private readonly control: QwpEgressQueryControl,
    private readonly creditEnabled: boolean,
    private readonly autoCredit: boolean,
    private readonly bufferPoolSize: number,
    private readonly timeoutMs: number,
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
    this.viewControl = viewHandler
      ? Object.freeze({
          requestId: this.requestId,
          awaitCompletion: (timeoutMs: number) =>
            this.awaitCompletion(timeoutMs),
          cancel: () => this.cancel(),
          grantCredit: (additionalBytes: number | bigint) =>
            this.grantCredit(additionalBytes),
          isDone: () => this.isDone(),
        })
      : undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<QwpResultBatch> {
    if (this.viewHandler) {
      throw new Error(
        "queryViews() delivers batches through its callback and is not async-iterable",
      );
    }
    const iterator = this.batches[Symbol.asyncIterator]();
    let nextTail: Promise<void> = Promise.resolve();
    return {
      next: () => {
        const next = nextTail.then(async () => {
          await this.releaseDeliveredCredit();
          const result = await iterator.next();
          if (result.done) return { value: undefined, done: true } as const;
          this.releaseBufferedBatches(1);
          this.deliveredCreditBytes = result.value.creditBytes;
          return { value: result.value.batch, done: false } as const;
        });
        nextTail = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
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
    // Replayable, and accepted as soon as a reconnect owns it. Both arguments
    // matter: the grant is recorded in the replayable request before its frame
    // is sent, so without the replay-supersession handling the replacement
    // received the same window twice -- once in the replayed request and again
    // in this CREDIT frame -- and without early acceptance a caller inside a
    // result-view callback waits for a reconnect that first drains it.
    return this.control.grantCredit(
      this.requestId,
      additionalBytes,
      true,
      true,
    );
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

  /** @internal Starts the timeout with what remains of its budget. */
  armDeadline(remainingMs: number): void {
    this.armTimer(remainingMs, () => this.control.expire(this.requestId));
  }

  /** @internal Bounds how long an expired query may take to end. */
  armGrace(graceMs: number): void {
    this.armTimer(graceMs, () => this.control.expireGrace(this.requestId));
  }

  /** @internal Whether the timeout has expired; results are withheld. */
  get pastDeadline(): boolean {
    return this.deadlineReached;
  }

  /** @internal Whether the application cancelled before the timeout. */
  get cancelledByUser(): boolean {
    return this.cancelledByApplication;
  }

  /** @internal Records an application cancel, which outranks the timeout. */
  markCancelledByUser(): void {
    this.cancelledByApplication = true;
  }

  /**
   * @internal Claims this request's single CANCEL. False once one has been
   * sent: the server ignores a second, so it would only cost a frame.
   */
  claimCancel(): boolean {
    if (this.cancelClaimed) return false;
    this.cancelClaimed = true;
    return true;
  }

  /** @internal The error reporting that this query ran out of time. */
  timeoutError(): QwpEgressQueryTimeoutError {
    return new QwpEgressQueryTimeoutError(this.requestId, this.timeoutMs);
  }

  /**
   * @internal Called when the timeout expires. No further batch reaches the
   * consumer: queued ones are dropped. Returns the flow-control credit they
   * held, which the server needs back to stream on toward its terminal.
   */
  withholdResults(): number {
    if (this.terminal || this.deadlineReached) return 0;
    this.deadlineReached = true;
    // Also wakes a receive loop parked on a full slot pool, which then drops
    // the batch it holds instead of queueing it.
    return this.discardBufferedResults();
  }

  /** @internal Waits for one decoded materialized-batch slot. */
  async reserveMaterializedBatch(): Promise<QwpBatchReservation> {
    const generation = this.bufferGeneration;
    while (
      !this.terminal &&
      !this.deadlineReached &&
      generation === this.bufferGeneration &&
      this.bufferedBatchCount >= this.bufferPoolSize
    ) {
      await new Promise<void>((resolve) => this.bufferWaiters.add(resolve));
    }
    if (this.terminal || this.deadlineReached) return "retired";
    if (generation !== this.bufferGeneration) return "reset";
    this.bufferedBatchCount++;
    return "reserved";
  }

  /** @internal Publishes a batch after reserveMaterializedBatch(). */
  pushReserved(batch: QwpResultBatch, creditBytes: number): void {
    if (this.terminal || this.deadlineReached) {
      if (!this.terminal) this.withheldBatch = true;
      this.releaseBufferedBatches(1);
      return;
    }
    this.countDecodedBatch(batch.batchSequence, batch.rowCount);
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
      !this.deadlineReached &&
      generation === this.bufferGeneration &&
      this.availableViewSlots.length === 0
    ) {
      await new Promise<void>((resolve) => this.bufferWaiters.add(resolve));
    }
    if (this.terminal || this.deadlineReached) return { status: "retired" };
    if (generation !== this.bufferGeneration) return { status: "reset" };
    return { status: "reserved", slot: this.availableViewSlots.shift()! };
  }

  /** @internal Queues a decoded view after reserveViewBatch(). */
  pushReservedView(
    batch: QwpResultBatchView,
    creditBytes: number,
    slot: number,
  ): void {
    if (this.terminal || this.deadlineReached) {
      if (!this.terminal) this.withheldBatch = true;
      batch.release();
      this.releaseViewSlot(slot);
      return;
    }
    this.countDecodedBatch(batch.batchSequence, batch.rowCount);
    const generation = this.bufferGeneration;
    this.viewTail = this.viewTail.then(async () => {
      if (this.terminal || generation !== this.bufferGeneration) {
        batch.release();
        this.releaseViewSlot(slot);
        return;
      }
      if (this.deadlineReached) {
        // Decoded ahead before the timeout expired, so it is dropped unread.
        // Its credit still goes back: the server streams on toward the
        // terminal response the outcome waits for.
        this.withheldBatch = true;
        batch.release();
        this.releaseViewSlot(slot);
        if (this.creditEnabled && !this.wireComplete && creditBytes > 0) {
          this.returnCredit(creditBytes);
        }
        return;
      }
      let handlerError: Error | undefined;
      try {
        await this.viewHandler!(batch, this.viewControl!);
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
      this.returnCredit(creditBytes);
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
    if (completion.kind === "result-end") {
      if (this.withheldBatch) {
        // Rows were kept from the consumer once the timeout expired, so what
        // it received is not the whole result. A statement's EXEC_DONE has no
        // rows to withhold and is reported as done: it has taken effect.
        this.fail(this.timeoutError());
        return;
      }
      if (
        completion.finalSequence !== this.expectedFinalSequence ||
        completion.totalRows !== this.decodedRowCount
      ) {
        throw new QwpProtocolError(
          `QWP RESULT_END totals do not match decoded results [requestId=${this.requestId}, finalSequence=${completion.finalSequence}, expectedFinalSequence=${this.expectedFinalSequence}, decodedBatches=${this.decodedBatchCount}, totalRows=${completion.totalRows}, decodedRows=${this.decodedRowCount}]`,
        );
      }
    }
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
  async finishError(error: QwpEgressQueryError): Promise<void> {
    this.wireComplete = true;
    if (this.viewHandler) await this.viewTail;
    if (this.terminal) return;
    // The server honoured the CANCEL the timeout sent. A cancel the application
    // asked for first is still reported as its own.
    this.fail(
      this.deadlineReached &&
        !this.cancelledByApplication &&
        error.status === QWP_STATUS.CANCELLED
        ? this.timeoutError()
        : error,
    );
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

  /**
   * @internal Records a batch dropped unread because the consumer has retired
   * or the timeout has expired, and returns the credit to restore for it.
   */
  dropLateBatch(creditBytes: number): number {
    if (this.deadlineReached && !this.terminal) this.withheldBatch = true;
    return this.creditEnabled ? creditBytes : 0;
  }

  /** @internal */
  async resetForReplay(): Promise<void> {
    this.deliveredCreditBytes = 0;
    this.bufferGeneration++;
    this.decodedBatchCount = 0n;
    this.lastDecodedBatchSequence = NO_DECODED_BATCH;
    this.decodedRowCount = 0n;
    this.wireComplete = false;
    this.releaseBufferedBatches(this.batches.clear().length);
    this.wakeBufferWaiters();
    await this.viewTail;
  }

  /** @internal Waits until all callback-scoped views have been released. */
  waitForViewDrain(): Promise<void> {
    return this.viewTail;
  }

  /**
   * The sequence RESULT_END must carry for the batches decoded so far.
   *
   * Every query response carries at least one RESULT_BATCH -- batch 0 holds the
   * schema, so the server's empty-cursor shortcut is guarded on a sequence
   * above zero -- but a peer that ends a stream without one has no negative
   * sequence to send. Zero is the only value it can spell, so accept it there
   * and let the row totals below carry the integrity check.
   */
  private get expectedFinalSequence(): bigint {
    return this.lastDecodedBatchSequence === NO_DECODED_BATCH
      ? 0n
      : this.lastDecodedBatchSequence;
  }

  private countDecodedBatch(batchSequence: bigint, rowCount: number): void {
    this.decodedBatchCount++;
    this.lastDecodedBatchSequence = batchSequence;
    this.decodedRowCount += BigInt(rowCount);
  }

  private clearTimeout(): void {
    if (!this.timeoutTimer) return;
    clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
  }

  private armTimer(delayMs: number, onExpiry: () => void): void {
    this.clearTimeout();
    if (this.terminal) return;
    this.timeoutTimer = setTimeout(() => {
      this.timeoutTimer = undefined;
      onExpiry();
    }, delayMs);
  }

  private returnCredit(creditBytes: number): void {
    try {
      void this.control
        .grantCredit(this.requestId, creditBytes, false)
        .catch(() => undefined);
    } catch {
      // The query is no longer active on the session; nothing is owed.
    }
  }

  private discardBufferedResults(): number {
    let creditBytes = this.deliveredCreditBytes;
    this.deliveredCreditBytes = 0;
    const dropped = this.batches.clear();
    if (dropped.length > 0 && this.deadlineReached) this.withheldBatch = true;
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
      await this.control.grantCredit(this.requestId, creditBytes, false);
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
 * session deliberately rejects a query issued while another is still running.
 * A query whose caller has already been released -- abandoned, or past its
 * timeout -- may still be draining on the connection; a new query waits for
 * that rather than failing. A completed query's materialized batches may
 * still be consumed while the next query runs.
 */
const QWP_EGRESS_SESSION_CONSTRUCTOR = Symbol("QWP egress session constructor");

const QUERY_TIMED_OUT = Symbol("QWP query timed out");

/** Settles once the query's own timeout has released its consumer. */
function endedByTimeout(
  query: QwpEgressQuery,
): Promise<typeof QUERY_TIMED_OUT> {
  return new Promise((resolve) => {
    query.completion.catch((error: unknown) => {
      if (error instanceof QwpEgressQueryTimeoutError) resolve(QUERY_TIMED_OUT);
    });
  });
}

/**
 * The steps a reconnecting connection runs on its session to replay the active
 * query onto a new connection. They are the session's private methods, so its
 * constructor fills these in for the function that opened the connection.
 */
interface QwpEgressReplayHooks {
  prepareConnectionReset?: (serverInfo: QwpServerInfoMessage) => Promise<void>;
  encodeActiveQueryRequest?: (
    serverInfo: QwpServerInfoMessage,
    requestId: bigint,
  ) => Uint8Array;
  notifyReplayReset?: (event: QwpEgressReplayResetEvent) => Promise<void>;
  onConnectionLost?: () => void;
}

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
  /**
   * Set while a reconnecting transport is without a connection. A query that
   * no longer needs a server -- its timeout expired, its consumer is gone --
   * then ends at once instead of waiting out a drain bound, and is not replayed.
   */
  private connectionLost = false;
  /**
   * The active query ended with the lost connection and will not be replayed.
   * It stays active, absorbing whatever the old connection had queued, until
   * the replacement connection is up.
   */
  private activeDetached = false;
  /**
   * Counts manual credit grants recorded in the replayable request, and the
   * last count a replay encoded. A grant reaches the next connection through
   * the replayed QUERY_REQUEST or through its own CREDIT frame, and comparing
   * the two is what keeps it from arriving twice or not at all.
   */
  private manualCreditEpoch = 0;
  private replayedCredit: { requestId?: bigint; epoch: number } = { epoch: 0 };
  /** Initial SERVER_INFO; use serverInfo for the current post-failover snapshot. */
  readonly ready: Promise<QwpServerInfoMessage>;

  /**
   * Query sessions come from connectQwpNodeEgress(), connectQwpBrowserEgress()
   * and the pooled clients; this constructor takes a token only the internal
   * factories hold.
   *
   * @internal
   * @hidden
   */
  constructor(
    token: typeof QWP_EGRESS_SESSION_CONSTRUCTOR,
    private readonly connection: QwpBinaryConnection,
    options: QwpEgressSessionOptions = {},
    replayHooks?: QwpEgressReplayHooks,
  ) {
    if (token !== QWP_EGRESS_SESSION_CONSTRUCTOR) {
      throw new TypeError(
        "QWP egress sessions must be created by connectQwpNodeEgress(), connectQwpBrowserEgress() or a QWP client",
      );
    }
    let validated: QwpValidatedEgressSessionOptions;
    try {
      if (
        options.reconnect &&
        !(connection instanceof QwpReconnectingEgressConnection)
      ) {
        throw new Error(
          "egress reconnect options require a reconnecting connection; open the session with connectQwpEgressSession()",
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
    this.decoder.maxBatchRows = validated.maxBatchRows;
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
    if (replayHooks) {
      replayHooks.prepareConnectionReset = (serverInfo) =>
        this.prepareConnectionReset(serverInfo);
      replayHooks.encodeActiveQueryRequest = (serverInfo, requestId) =>
        this.encodeActiveQueryRequest(serverInfo, requestId);
      replayHooks.notifyReplayReset = (event) =>
        this.notifyReplayReset(event, options.onReplayReset);
      replayHooks.onConnectionLost = () => this.handleConnectionLost();
    }
  }

  get closed(): Promise<QwpConnectionCloseInfo> {
    return this.connection.closed;
  }

  get handshake(): QwpHandshakeMetadata {
    return this.connection.handshake;
  }

  /**
   * Immutable notification-inbox counters for this session's reconnect
   * observer, the egress counterpart of `QwpSender.metrics.ingress`.
   *
   * A `reconnect.onEvent` observer runs on a bounded inbox that drops its
   * oldest pending entry under overflow, exactly as ingress does. Nothing
   * reported those drops, and no gap in the delivered stream reveals them
   * either, because `attempt` resets to one on every success: six outages that
   * discarded eleven events were indistinguishable from a healthy two. A
   * non-zero drop count means the observer is not keeping up.
   */
  get metrics(): QwpEgressMetrics {
    const inbox = this.connection.getEgressMetrics?.();
    return Object.freeze({
      deliveredConnectionNotifications:
        inbox?.deliveredConnectionNotifications ?? 0,
      droppedConnectionNotifications:
        inbox?.droppedConnectionNotifications ?? 0,
    });
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
    // The timeout runs from this call: waiting for SERVER_INFO, for a previous
    // query to drain and for the request to leave all count against it.
    const deadline = timeoutMs > 0 ? monotonicNowMs() + timeoutMs : undefined;
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
    if (
      options.onReplayReset !== undefined &&
      typeof options.onReplayReset !== "function"
    ) {
      throw new TypeError("onReplayReset must be a function");
    }
    await this.waitToStart(timeoutMs, deadline);
    this.throwIfUnavailable();
    if (this.active) {
      throw new Error("a QWP query is already active on this connection");
    }
    const remainingMs =
      deadline === undefined ? 0 : deadline - monotonicNowMs();
    if (deadline !== undefined && remainingMs <= 0) {
      // Spent before the request was sent, so nothing reached the wire.
      throw new QwpEgressQueryTimeoutError(this.nextRequestId++, timeoutMs);
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
      timeoutMs,
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
      onReplayReset: options.onReplayReset,
    };
    this.decoder.resetQuerySchema();
    this.active = query;
    this.activeRequest = request;
    if (deadline !== undefined) query.armDeadline(remainingMs);
    let sending: Promise<void>;
    try {
      sending = this.sendQueryRequest(
        this.encodeQueryRequest(request, this.currentServerInfo!),
        () => this.active !== query,
      );
    } catch (error) {
      this.clearActive(query);
      query.fail(error);
      throw error;
    }
    // The timeout can end the query while its request still waits -- behind a
    // reconnect, say -- and the caller is released then, not when it is sent.
    const outcome = await Promise.race([
      sending.then(
        () => undefined,
        (error: unknown) => ({ error }),
      ),
      endedByTimeout(query),
    ]);
    if (outcome === QUERY_TIMED_OUT) {
      await query.completion;
    } else if (outcome) {
      this.clearActive(query);
      query.fail(outcome.error);
      throw outcome.error;
    }
    return query;
  }

  /**
   * Waits for SERVER_INFO, and for a query whose caller has been released --
   * abandoned, or past its timeout -- to drain from the connection, within the
   * new query's own timeout. A query still running is not waited for: its
   * consumer may be the very code starting this one.
   */
  private async waitToStart(
    timeoutMs: number,
    deadline: number | undefined,
  ): Promise<void> {
    if (this.currentServerInfo !== undefined && !this.active?.isDone()) {
      return;
    }
    const startable = (async () => {
      await this.ready;
      while (this.active?.isDone() && !this.failure && !this.closing) {
        await this.waitUntilIdle();
      }
    })();
    if (deadline === undefined) return startable;
    void startable.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new QwpEgressQueryTimeoutError(this.nextRequestId++, timeoutMs),
          ),
        Math.max(0, deadline - monotonicNowMs()),
      );
    });
    try {
      await Promise.race([startable, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  cancel(requestId: bigint): Promise<void> {
    const query = this.requireActive(requestId);
    // Past its timeout, or with its consumer gone, the query is already being
    // cancelled, and the server would ignore a second CANCEL.
    if (query.isDone() || query.pastDeadline) return Promise.resolve();
    query.markCancelledByUser();
    // Without a connection the CANCEL follows the replayed request, and its
    // drain bound starts with the replacement connection.
    if (!this.connectionLost) this.armCancelDrain(requestId);
    return this.sendCancel(query, 0);
  }

  abandon(requestId: bigint): Promise<void> {
    const query = this.requireActive(requestId);
    const discardedCredit = query.retire(
      new QwpEgressQueryAbandonedError(requestId),
    );
    return this.drainRetired(query, discardedCredit);
  }

  grantCredit(
    requestId: bigint,
    additionalBytes: number | bigint,
    replayOnReconnect = true,
    acceptWhenReconnectStarts = false,
  ): Promise<void> {
    this.requireActive(requestId);
    const payload = encodeQwpCredit(requestId, additionalBytes);
    if (!replayOnReconnect) {
      return this.sendWhileActive(requestId, payload);
    }
    const additional = BigInt(additionalBytes);
    return this.sendWhileActive(
      requestId,
      payload,
      () => {
        const request = this.activeRequest;
        if (!request || request.requestId !== requestId) return;
        this.manualCreditEpoch++;
        const total = BigInt(request.initialCredit) + additional;
        // QUERY_REQUEST carries one uint64 initial-credit field. Saturating is
        // lossless for any representable result stream and avoids dropping all
        // successfully granted manual credit merely because several grants
        // were used before a failover. Apply before the physical CREDIT send:
        // that send itself may be what starts the replay.
        request.initialCredit = total > MAX_UINT64 ? MAX_UINT64 : total;
      },
      acceptWhenReconnectStarts,
    );
  }

  /**
   * The query ran out of time. No further batch reaches its consumer and it is
   * cancelled, but the outcome waits for the server's terminal response, up to
   * one grace period: a statement that completed has taken effect, and
   * reporting it as timed out would invite a retry that applies it twice.
   */
  expire(requestId: bigint): void {
    const query = this.active;
    if (!query || query.requestId !== requestId || query.isDone()) return;
    const discardedCredit = query.withholdResults();
    try {
      if (this.connectionLost) {
        // Nothing can answer on a connection that is gone.
        this.settleLostQuery();
      } else if (query.cancelledByUser) {
        // Its own CANCEL is draining under the cancel bound, and the outcome
        // is reported as that cancellation.
        void this.sendCredit(query, discardedCredit).catch(() => undefined);
        return;
      } else {
        void this.sendCancel(query, discardedCredit).catch(() => undefined);
      }
      if (!query.isDone()) query.armGrace(this.cancelDrainTimeoutMs);
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * An expired query has not ended within the grace period. Its caller is
   * released with the timeout, while the connection drains the query for up
   * to one more period before the session gives up on it.
   */
  expireGrace(requestId: bigint): void {
    const query = this.active;
    if (!query || query.requestId !== requestId || query.isDone()) return;
    query.retire(query.timeoutError());
    try {
      void this.drainRetired(query, 0).catch(() => undefined);
    } catch (error) {
      this.fail(error);
    }
  }

  async rejectView(requestId: bigint, error: Error): Promise<void> {
    const query = this.requireActive(requestId);
    const discardedCredit = query.retire(error);
    await this.drainRetired(query, discardedCredit);
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
    if (
      active &&
      !active.retired &&
      !this.closing &&
      !this.failure &&
      active.claimCancel()
    ) {
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
    // Bounded by the same ceiling close() uses. The CANCEL this sends waits
    // for a live connection, so a reconnect can hold it -- and that reconnect
    // first drains the result-view callback, which is exactly what a lease
    // return may be waiting behind. Unbounded, one stalled callback kept a
    // pool slot leased for the whole outage and every other borrower timed
    // out; the session is simply discarded instead.
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const drainDeadline = new Promise<void>((resolve) => {
      drainTimer = setTimeout(resolve, this.cancelDrainTimeoutMs);
      (drainTimer as { unref?: () => void }).unref?.();
    });
    try {
      if (!active.retired) {
        const abandoning = this.abandon(active.requestId).catch(
          (error: unknown) => this.fail(error),
        );
        await Promise.race([abandoning, drainDeadline]);
      }
      await Promise.race([idle, drainDeadline]);
    } finally {
      clearTimeout(drainTimer);
    }
    // A query still active here means the drain deadline won, so this physical
    // session is no longer safe to hand to the next borrower.
    return !this.failure && !this.closing && this.active === undefined;
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
    // Everything above already cleared this session's deadlines -- the
    // SERVER_INFO timer, the cancel drain, and the active query's own timeout
    // -- so nothing below is bounded by anything except this race.
    //
    // Three of these four entries can be held open by a queryViews() batch
    // callback: waitForViewDrain() is the promise chain that awaits the
    // handler, and the receive loop parks on the same chain in finish(),
    // finishError() and the cache-reset branch. A handler that resolves slowly
    // delayed close() by its full duration and one that never resolved made
    // close() never resolve at all, so a SIGTERM shutdown hung with the socket
    // already closed. Bound them by cancelDrainTimeoutMs, which is already the
    // documented ceiling on draining a closing query session.
    //
    // Releasing early is safe here in a way it is not on the live-session
    // paths: the decoder is per-session and dies with it, this method never
    // resets the query schema, and pooled reuse drains through
    // prepareForPoolRelease() instead, which is a separate and already bounded
    // path. A handler still running past this point merely reads buffers
    // nobody will touch again; control.isDone() is its cooperative signal.
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const drainDeadline = new Promise<void>((resolve) => {
      drainTimer = setTimeout(resolve, this.cancelDrainTimeoutMs);
      // Never hold the runtime open just to abandon a callback.
      (drainTimer as { unref?: () => void }).unref?.();
    });
    const bounded = (pending: Promise<unknown>): Promise<unknown> =>
      Promise.race([pending, drainDeadline]);
    try {
      const [, closeResult] = await Promise.allSettled([
        bounded(this.sendTail),
        // Bounded for the same reason as the rest: a reconnecting transport
        // joins its in-flight reconnect while closing, and that reconnect can
        // be parked on the very view callback this deadline exists to abandon.
        // The socket is already closed by then, so the remaining wait only
        // delays the caller's shutdown.
        bounded(transportClose),
        bounded(this.receiveLoop),
        bounded(active?.waitForViewDrain() ?? Promise.resolve()),
      ]);
      if (closeResult.status === "rejected") throw closeResult.reason;
    } finally {
      clearTimeout(drainTimer);
    }
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
              if (query.retired || query.pastDeadline) {
                this.discardBatch(query, message, payload);
              } else if (query.usesViews) {
                const reservation = await query.reserveViewBatch();
                if (reservation.status === "retired") {
                  this.discardBatch(query, message, payload);
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
                  this.discardBatch(query, message, payload);
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
              await query.finish(message);
              this.clearCancelDrain(message.requestId);
              this.acceptReconnectingTerminal(message.requestId);
              this.clearActive(query);
              break;
            }
            case "exec-done": {
              const query = this.requireActive(message.requestId);
              await query.finish(message);
              this.clearCancelDrain(message.requestId);
              this.acceptReconnectingTerminal(message.requestId);
              this.clearActive(query);
              break;
            }
            case "query-error": {
              const query = this.requireActive(message.requestId);
              await query.finishError(
                new QwpEgressQueryError(
                  message.requestId,
                  message.status,
                  message.message,
                ),
              );
              this.clearCancelDrain(message.requestId);
              this.acceptReconnectingTerminal(message.requestId);
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

  private acceptReconnectingTerminal(requestId: bigint): void {
    if (this.connection instanceof QwpReconnectingEgressConnection) {
      this.connection.acceptTerminal(requestId);
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

  /**
   * Drops a RESULT_BATCH whose query is no longer taking rows, returning its
   * credit so the server keeps draining.
   *
   * The rows go, but the delta symbol dictionary the batch carries does not:
   * it is connection-scoped and cumulative, so a skipped chunk desynchronises
   * every later query on the same session.
   */
  private discardBatch(
    query: QwpEgressQuery,
    message: QwpResultBatchMessage,
    payload: Uint8Array,
  ): void {
    this.decoder.absorbDictionary(message);
    const creditBytes = query.dropLateBatch(payload.byteLength);
    if (creditBytes > 0) {
      void this.sendWhileActive(
        message.requestId,
        encodeQwpCredit(message.requestId, creditBytes),
      ).catch(() => undefined);
    }
  }

  private async prepareConnectionReset(
    serverInfo: QwpServerInfoMessage,
  ): Promise<void> {
    this.currentServerInfo = serverInfo;
    // From here on the replacement connection carries the active query, if
    // any, so a query ending now drains on it rather than being dropped.
    this.connectionLost = false;
    const query = this.active;
    if (query && this.activeDetached) {
      // It ended with the old connection and is not replayed. Its last view
      // callback still reads the dictionary reset below, so let it finish.
      await query.waitForViewDrain();
      this.clearActive(query);
    } else if (query) {
      await query.resetForReplay();
      this.boundReplayedQuery(query);
    }
    this.decoder.applyCacheReset(QWP_RESET_MASK_DICTIONARY);
    this.decoder.resetQuerySchema();
  }

  /**
   * The reconnecting transport lost its connection and is replacing it.
   * Nothing drains without a connection, so the cancel bound stops here and
   * restarts on the replacement for a query that is replayed.
   */
  private handleConnectionLost(): void {
    this.connectionLost = true;
    this.clearCancelDrain();
    this.settleLostQuery();
  }

  /**
   * Ends the active query on a lost connection once it no longer needs a
   * server: its timeout has expired or its consumer has retired. Replaying it
   * would run it again only to cancel it, so it leaves the replay and is
   * cleared when the replacement connection is up. A query still running is
   * replayed as before.
   */
  private settleLostQuery(): void {
    const query = this.active;
    const connection = this.connection;
    if (
      !query ||
      !this.connectionLost ||
      this.activeDetached ||
      !(connection instanceof QwpReconnectingEgressConnection)
    ) {
      return;
    }
    if (!query.isDone() && !query.pastDeadline) return;
    // Its terminal response arrived before the connection went, and decides.
    if (connection.hasPendingTerminal(query.requestId)) return;
    // A no-op for a consumer that has already retired.
    query.retire(query.timeoutError());
    this.clearCancelDrain(query.requestId);
    this.activeDetached = true;
    connection.dropReplay(query.requestId);
  }

  /**
   * Restarts the bound on a replayed query that is being cancelled. A CANCEL
   * already sent travels with the replay; one that was not is sent now.
   */
  private boundReplayedQuery(query: QwpEgressQuery): void {
    if (this.active !== query) return;
    if (query.isDone() || query.cancelledByUser) {
      this.armCancelDrain(query.requestId);
    } else if (query.pastDeadline) {
      query.armGrace(this.cancelDrainTimeoutMs);
    } else {
      return;
    }
    try {
      void this.sendCancel(query, 0).catch(() => undefined);
    } catch {
      // The session failed meanwhile; that failure is what the caller sees.
    }
  }

  private async notifyReplayReset(
    event: QwpEgressReplayResetEvent,
    defaultCallback?: QwpEgressSessionOptions["onReplayReset"],
  ): Promise<void> {
    const request = this.activeRequest;
    if (!request || request.requestId !== event.requestId) {
      throw new QwpProtocolError(
        `QWP egress replay references inactive request ID ${event.requestId}`,
      );
    }
    await (request.onReplayReset ?? defaultCallback)?.(event);
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
    // Recorded synchronously with the read below: every manual grant folded
    // into this request before now travels with the replay, so its own CREDIT
    // frame must not also reach the replacement connection.
    this.replayedCredit = { requestId, epoch: this.manualCreditEpoch };
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

  /**
   * Cancels a query whose consumer has retired and bounds the wait for its
   * terminal response, so the connection can serve the next query. On a lost
   * connection there is nothing to wait for, and the query is not replayed.
   */
  private drainRetired(
    query: QwpEgressQuery,
    discardedCredit: number,
  ): Promise<void> {
    if (this.connectionLost) {
      this.settleLostQuery();
      return Promise.resolve();
    }
    this.armCancelDrain(query.requestId);
    return this.sendCancel(query, discardedCredit);
  }

  /** Sends the request's one CANCEL, then credit for batches it dropped. */
  private sendCancel(
    query: QwpEgressQuery,
    discardedCredit: number,
  ): Promise<void> {
    const requestId = query.requestId;
    const cancelling = query.claimCancel()
      ? this.sendWhileActive(requestId, encodeQwpCancel(requestId))
      : Promise.resolve();
    if (discardedCredit === 0) return cancelling;
    return cancelling.then(() => this.sendCredit(query, discardedCredit));
  }

  private sendCredit(
    query: QwpEgressQuery,
    creditBytes: number,
  ): Promise<void> {
    if (creditBytes === 0) return Promise.resolve();
    return this.sendWhileActive(
      query.requestId,
      encodeQwpCredit(query.requestId, creditBytes),
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

  /**
   * Sends a QUERY_REQUEST, or drops it if its query has ended before it
   * leaves -- its timeout expired while a reconnect held the request.
   */
  private sendQueryRequest(
    payload: Uint8Array,
    withdrawn: () => boolean,
  ): Promise<void> {
    this.throwIfUnavailable();
    const sending = this.sendTail.then(async () => {
      this.throwIfUnavailable();
      if (withdrawn()) return;
      if (this.connection instanceof QwpReconnectingEgressConnection) {
        await this.connection.sendWithdrawable(payload, withdrawn);
      } else {
        await this.connection.send(payload);
      }
    });
    this.sendTail = sending.catch((error: unknown) => this.fail(error));
    return sending;
  }

  private sendWhileActive(
    requestId: bigint,
    payload: Uint8Array,
    onSending?: () => void,
    replayableCredit = false,
  ): Promise<void> {
    this.throwIfUnavailable();
    const sending = this.sendTail.then(async () => {
      this.throwIfUnavailable();
      // A detached query left with its connection; the replacement does not
      // know its request, so its CANCEL and CREDIT frames have nowhere to go.
      if (
        !this.active ||
        this.active.requestId !== requestId ||
        this.activeDetached
      ) {
        return;
      }
      onSending?.();
      if (
        replayableCredit &&
        this.connection instanceof QwpReconnectingEgressConnection
      ) {
        // Read after onSending(), so it names this grant. The transport drops
        // the frame only once a replay has encoded that same grant into the
        // replacement request; sending both would grant the window twice, and
        // dropping it without a replay would lose it.
        const grantEpoch = this.manualCreditEpoch;
        await this.connection.sendReplayableCredit(
          payload,
          () =>
            this.replayedCredit.requestId === requestId &&
            this.replayedCredit.epoch >= grantEpoch,
        );
      } else {
        await this.connection.send(payload);
      }
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
    this.activeDetached = false;
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

/**
 * Opens a query session over a connection factory. Unless `reconnect` is false
 * it reconnects across endpoints and replays the active query on the new
 * connection.
 *
 * @internal The runtime adapters' egress connectors call it. Neither package
 * root exports it: applications open query sessions with
 * connectQwpNodeEgress(), connectQwpBrowserEgress() or a pooled client.
 */
export async function connectQwpEgressSession(
  factory: QwpConnectionFactory,
  options: QwpEgressSessionOptions = {},
  /** Cancels a connection or SERVER_INFO handshake still in progress. */
  signal?: AbortSignal,
): Promise<QwpEgressSession> {
  const validated = validateEgressSessionOptions(options);
  // Filled in by the session's constructor. Until it has run there is no
  // query to replay, so a reset is a no-op and a replay is a protocol fault.
  const replayHooks: QwpEgressReplayHooks = {};
  const reconnectOptions =
    options.reconnect === false
      ? undefined
      : // Spread, not `??`: tuning one field must not discard the rest.
        { ...QWP_DEFAULT_EGRESS_RECONNECT_OPTIONS, ...options.reconnect };
  const connection = reconnectOptions
    ? await QwpReconnectingEgressConnection.connect(
        factory,
        reconnectOptions,
        validated.serverInfoTimeoutMs,
        (serverInfo) => replayHooks.prepareConnectionReset?.(serverInfo),
        (serverInfo, requestId) => {
          if (!replayHooks.encodeActiveQueryRequest) {
            throw new QwpProtocolError(
              "QWP egress session is unavailable while encoding a query",
            );
          }
          return replayHooks.encodeActiveQueryRequest(serverInfo, requestId);
        },
        async (event) => {
          if (!replayHooks.notifyReplayReset) {
            throw new QwpProtocolError(
              "QWP egress session is unavailable during query replay",
            );
          }
          await replayHooks.notifyReplayReset(event);
        },
        () => replayHooks.onConnectionLost?.(),
        options.reconnect !== undefined,
        signal,
        validated.connectionListenerInboxCapacity,
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
    session = new QwpEgressSession(
      QWP_EGRESS_SESSION_CONSTRUCTOR,
      connection,
      options,
      replayHooks,
    );
    signal?.addEventListener("abort", abortOpening, { once: true });
    await session.ready;
    if (signal?.aborted) throw new QwpSendClosedError();
    return session;
  } catch (error) {
    if (session) {
      await session
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

/**
 * Wraps one fixed connection in a query session that does not reconnect.
 *
 * @internal Tests drive sessions over fake connections with it; the adapters
 * open theirs with connectQwpEgressSession().
 */
export function createQwpEgressSession(
  connection: QwpBinaryConnection,
  options: QwpEgressSessionOptions = {},
): QwpEgressSession {
  return new QwpEgressSession(
    QWP_EGRESS_SESSION_CONSTRUCTOR,
    connection,
    options,
  );
}
