import {
  decodeQwpEgressMessage,
  encodeQwpCancel,
  encodeQwpCredit,
  encodeQwpQueryRequest,
  QWP_EGRESS_CAPABILITY,
  QWP_QUERY_FLAG_RESET_DICTIONARY,
  QWP_RESET_MASK_DICTIONARY,
  QwpBindSetter,
  QwpExecDoneMessage,
  type QwpNegotiatedEgressCompression,
  QwpProtocolError,
  QwpQueryRequest,
  QwpResultBatch,
  QwpResultBatchDecoder,
  QwpResultBatchView,
  QwpResultEndMessage,
  QwpServerInfoMessage,
} from "./core";
import { QwpAsyncQueue } from "./internal/async-queue";
import { QwpReconnectingEgressConnection } from "./internal/reconnecting-egress-connection";
import {
  QwpBinaryConnection,
  QwpConnectionCloseInfo,
  QwpConnectionFactory,
  QwpEgressReplayResetEvent,
  QwpHandshakeMetadata,
  QwpReconnectOptions,
} from "./transport";

export interface QwpEgressSessionOptions {
  serverInfoTimeoutMs?: number;
  /** Default per-query send-ahead credit. Defaults to 256 KiB; zero is unbounded. */
  initialCredit?: number | bigint;
  /** Default per-query deadline. Zero or undefined disables query deadlines. */
  queryTimeoutMs?: number;
  /** Maximum wait for a terminal response after CANCEL. Defaults to 5 seconds. */
  cancelDrainTimeoutMs?: number;
  /** Enables bounded reconnects. Active operations replay only with onReplayReset. */
  reconnect?: QwpReconnectOptions;
  /**
   * Explicitly opts into at-least-once re-execution after a disconnect. The
   * query's not-yet-consumed batches are discarded before this callback, and
   * callers must discard any result prefix they already consumed.
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
  /** Ask a capable server to reset its connection-scoped symbol dictionary. */
  resetDictionary?: boolean;
}

interface QwpValidatedEgressSessionOptions {
  readonly serverInfoTimeoutMs: number;
  readonly initialCredit: number | bigint;
  readonly queryTimeoutMs: number;
  readonly cancelDrainTimeoutMs: number;
}

/** Default bounded send-ahead window used by high-level egress queries. */
export const QWP_DEFAULT_EGRESS_INITIAL_CREDIT = 256 * 1024;

const MAX_UINT64 = 0xffffffffffffffffn;

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
  const serverInfoTimeoutMs = options.serverInfoTimeoutMs ?? 15_000;
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

/** Control handle returned by queryViews(). */
export interface QwpEgressViewQuery {
  readonly requestId: bigint;
  readonly completion: Promise<QwpQueryCompletion>;
  cancel(): Promise<void>;
  grantCredit(additionalBytes: number | bigint): Promise<void>;
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
  private deliveredCreditBytes = 0;
  private terminal = false;
  private timeoutTimer?: ReturnType<typeof setTimeout>;
  readonly completion: Promise<QwpQueryCompletion>;

  constructor(
    readonly requestId: bigint,
    private readonly control: QwpEgressQueryControl,
    private readonly creditEnabled: boolean,
    private readonly autoCredit: boolean,
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

  /** @internal Starts the deadline after QUERY_REQUEST reaches the transport. */
  armTimeout(timeoutMs: number): void {
    if (timeoutMs === 0 || this.terminal) return;
    this.timeoutTimer = setTimeout(() => {
      this.timeoutTimer = undefined;
      this.control.expire(this.requestId, timeoutMs);
    }, timeoutMs);
  }

  /** @internal */
  push(batch: QwpResultBatch, creditBytes: number): void {
    if (this.terminal) return;
    this.batches.push({ batch, creditBytes });
  }

  /** @internal */
  async pushView(
    batch: QwpResultBatchView,
    creditBytes: number,
  ): Promise<void> {
    if (this.terminal) {
      batch.release();
      return;
    }
    let handlerError: Error | undefined;
    try {
      await this.viewHandler!(batch, this);
    } catch (error) {
      handlerError = error instanceof Error ? error : new Error(String(error));
    } finally {
      batch.release();
    }
    if (handlerError) {
      await this.control
        .rejectView(this.requestId, handlerError)
        .catch(() => undefined);
      return;
    }
    if (!this.autoCredit || this.terminal || creditBytes === 0) return;
    await this.control.grantCredit(this.requestId, creditBytes);
  }

  /** @internal */
  get usesViews(): boolean {
    return this.viewHandler !== undefined;
  }

  /** @internal */
  finish(completion: QwpQueryCompletion): void {
    if (this.terminal) return;
    this.terminal = true;
    this.clearTimeout();
    this.deliveredCreditBytes = 0;
    this.batches.end();
    this.resolveCompletion(completion);
  }

  /** @internal */
  fail(error: unknown): void {
    if (this.terminal) return;
    this.terminal = true;
    this.clearTimeout();
    this.deliveredCreditBytes = 0;
    this.batches.fail(error);
    this.rejectCompletion(error);
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
  resetForReplay(): void {
    this.deliveredCreditBytes = 0;
    this.batches.clear();
  }

  private clearTimeout(): void {
    if (!this.timeoutTimer) return;
    clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
  }

  private discardBufferedResults(): number {
    let creditBytes = this.deliveredCreditBytes;
    this.deliveredCreditBytes = 0;
    for (const queued of this.batches.clear()) {
      creditBytes += queued.creditBytes;
    }
    return this.creditEnabled ? creditBytes : 0;
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
  private readonly cancelDrainTimeoutMs: number;
  private readonly idleWaiters = new Set<() => void>();
  private active?: QwpEgressQuery;
  private nextRequestId = 0n;
  private sendTail: Promise<void> = Promise.resolve();
  private serverInfo?: QwpServerInfoMessage;
  private failure?: Error;
  private closing = false;
  private closePromise?: Promise<void>;
  private cancelDrainRequestId?: bigint;
  private cancelDrainTimer?: ReturnType<typeof setTimeout>;
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
  ): Promise<QwpEgressSession> {
    const validated = validateEgressSessionOptions(options);
    const state: { session?: QwpEgressSession } = {};
    const connection = options.reconnect
      ? await QwpReconnectingEgressConnection.connect(
          factory,
          options.reconnect,
          validated.serverInfoTimeoutMs,
          () => state.session?.prepareConnectionReset(),
          options.onReplayReset
            ? async (event) => {
                await options.onReplayReset!(event);
              }
            : undefined,
        )
      : await factory();
    let session: QwpEgressSession;
    try {
      session = new QwpEgressSession(connection, options);
      state.session = session;
      await session.ready;
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
    }
  }

  get closed(): Promise<QwpConnectionCloseInfo> {
    return this.connection.closed;
  }

  get handshake(): QwpHandshakeMetadata {
    return this.connection.handshake;
  }

  /** Effective codec and level echoed by the server on the active endpoint. */
  get negotiatedCompression(): QwpNegotiatedEgressCompression | undefined {
    return this.connection.handshake.negotiatedCompression;
  }

  /** Effective Zstd level, or zero for raw, unknown, or browser-hidden negotiation. */
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
   * The callback is awaited before its batch is invalidated and flow-control
   * credit is replenished.
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
    if (
      options.resetDictionary &&
      (this.serverInfo!.capabilities & QWP_EGRESS_CAPABILITY.QUERY_FLAGS) === 0
    ) {
      throw new Error("the QWP server does not support query flags");
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
      viewHandler,
    );
    this.decoder.resetQuerySchema();
    this.active = query;
    const request: QwpQueryRequest = {
      requestId,
      sql,
      initialCredit,
      binds: options.binds,
      bindCount: options.bindCount,
      bindPayload: options.bindPayload,
      queryFlags: options.resetDictionary
        ? QWP_QUERY_FLAG_RESET_DICTIONARY
        : undefined,
    };
    try {
      await this.send(encodeQwpQueryRequest(request));
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
    this.active?.fail(error);
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
    ]);
    if (closeResult.status === "rejected") throw closeResult.reason;
  }

  private async consumeMessages(): Promise<void> {
    try {
      for await (const payload of this.connection.messages) {
        const message = decodeQwpEgressMessage(payload);
        switch (message.kind) {
          case "server-info":
            if (this.serverInfo) {
              throw new QwpProtocolError("received duplicate QWP SERVER_INFO");
            }
            this.serverInfo = message;
            clearTimeout(this.serverInfoTimer);
            this.resolveServerInfo(message);
            break;
          case "cache-reset":
            this.decoder.applyCacheReset(message.resetMask);
            break;
          case "result-batch": {
            const query = this.requireActive(message.requestId);
            const batch = query.usesViews
              ? this.decoder.decodeView(message)
              : this.decoder.decode(message);
            if (query.retired) {
              if (batch instanceof QwpResultBatchView) batch.release();
              const creditBytes = query.lateBatchCredit(payload.byteLength);
              if (creditBytes > 0) {
                void this.sendWhileActive(
                  message.requestId,
                  encodeQwpCredit(message.requestId, creditBytes),
                ).catch(() => undefined);
              }
            } else if (batch instanceof QwpResultBatchView) {
              await query.pushView(batch, payload.byteLength);
            } else {
              query.push(batch, payload.byteLength);
            }
            break;
          }
          case "result-end": {
            const query = this.requireActive(message.requestId);
            this.clearActive(query);
            this.clearCancelDrain(message.requestId);
            query.finish(message);
            break;
          }
          case "exec-done": {
            const query = this.requireActive(message.requestId);
            this.clearActive(query);
            this.clearCancelDrain(message.requestId);
            query.finish(message);
            break;
          }
          case "query-error": {
            const query = this.requireActive(message.requestId);
            this.clearActive(query);
            this.clearCancelDrain(message.requestId);
            query.fail(
              new QwpEgressQueryError(
                message.requestId,
                message.status,
                message.message,
              ),
            );
            break;
          }
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
        void this.connection.close(1002, "invalid QWP egress message");
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

  private prepareConnectionReset(): void {
    this.decoder.applyCacheReset(QWP_RESET_MASK_DICTIONARY);
    this.decoder.resetQuerySchema();
    this.active?.resetForReplay();
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
