import {
  decodeQwpEgressMessage,
  encodeQwpCancel,
  encodeQwpCredit,
  encodeQwpQueryRequest,
  QWP_EGRESS_CAPABILITY,
  QWP_QUERY_FLAG_RESET_DICTIONARY,
  QwpExecDoneMessage,
  QwpProtocolError,
  QwpQueryRequest,
  QwpResultBatch,
  QwpResultBatchDecoder,
  QwpResultEndMessage,
  QwpServerInfoMessage,
} from "./core";
import { QwpAsyncQueue } from "./internal/async-queue";
import {
  QwpBinaryConnection,
  QwpConnectionCloseInfo,
  QwpConnectionFactory,
} from "./transport";

export interface QwpEgressSessionOptions {
  serverInfoTimeoutMs?: number;
}

export interface QwpEgressQueryOptions {
  /** Zero means the server may stream without credit accounting. */
  initialCredit?: number | bigint;
  bindCount?: number;
  /** Pre-encoded positional bind payload. */
  bindPayload?: Uint8Array;
  /** Ask a capable server to reset its connection-scoped symbol dictionary. */
  resetDictionary?: boolean;
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
  grantCredit(
    requestId: bigint,
    additionalBytes: number | bigint,
  ): Promise<void>;
}

/** One QWP query/statement and its stream of materialized result batches. */
export class QwpEgressQuery implements AsyncIterable<QwpResultBatch> {
  private readonly batches = new QwpAsyncQueue<QwpResultBatch>();
  private readonly resolveCompletion: (value: QwpQueryCompletion) => void;
  private readonly rejectCompletion: (error: unknown) => void;
  readonly completion: Promise<QwpQueryCompletion>;

  constructor(
    readonly requestId: bigint,
    private readonly control: QwpEgressQueryControl,
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
    return this.batches[Symbol.asyncIterator]();
  }

  cancel(): Promise<void> {
    return this.control.cancel(this.requestId);
  }

  grantCredit(additionalBytes: number | bigint): Promise<void> {
    return this.control.grantCredit(this.requestId, additionalBytes);
  }

  /** @internal */
  push(batch: QwpResultBatch): void {
    this.batches.push(batch);
  }

  /** @internal */
  finish(completion: QwpQueryCompletion): void {
    this.batches.end();
    this.resolveCompletion(completion);
  }

  /** @internal */
  fail(error: unknown): void {
    this.batches.fail(error);
    this.rejectCompletion(error);
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
  private active?: QwpEgressQuery;
  private nextRequestId = 0n;
  private sendTail: Promise<void> = Promise.resolve();
  private serverInfo?: QwpServerInfoMessage;
  private failure?: Error;
  private closing = false;
  readonly ready: Promise<QwpServerInfoMessage>;

  constructor(
    private readonly connection: QwpBinaryConnection,
    options: QwpEgressSessionOptions = {},
  ) {
    const timeout = options.serverInfoTimeoutMs ?? 15_000;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new RangeError(
        "serverInfoTimeoutMs must be a positive finite number",
      );
    }
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
      this.fail(new Error("timed out waiting for QWP SERVER_INFO"));
    }, timeout);
    this.receiveLoop = this.consumeMessages();
  }

  static async connect(
    factory: QwpConnectionFactory,
    options: QwpEgressSessionOptions = {},
  ): Promise<QwpEgressSession> {
    const session = new QwpEgressSession(await factory(), options);
    try {
      await session.ready;
      return session;
    } catch (error) {
      await session
        .close(1002, "missing QWP SERVER_INFO")
        .catch(() => undefined);
      throw error;
    }
  }

  get closed(): Promise<QwpConnectionCloseInfo> {
    return this.connection.closed;
  }

  async query(
    sql: string,
    options: QwpEgressQueryOptions = {},
  ): Promise<QwpEgressQuery> {
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
    const query = new QwpEgressQuery(requestId, this);
    this.decoder.resetQuerySchema();
    this.active = query;
    const request: QwpQueryRequest = {
      requestId,
      sql,
      initialCredit: options.initialCredit,
      bindCount: options.bindCount,
      bindPayload: options.bindPayload,
      queryFlags: options.resetDictionary
        ? QWP_QUERY_FLAG_RESET_DICTIONARY
        : undefined,
    };
    try {
      await this.send(encodeQwpQueryRequest(request));
    } catch (error) {
      if (this.active === query) this.active = undefined;
      query.fail(error);
      throw error;
    }
    return query;
  }

  cancel(requestId: bigint): Promise<void> {
    this.requireActive(requestId);
    return this.send(encodeQwpCancel(requestId));
  }

  grantCredit(
    requestId: bigint,
    additionalBytes: number | bigint,
  ): Promise<void> {
    this.requireActive(requestId);
    return this.send(encodeQwpCredit(requestId, additionalBytes));
  }

  async close(code = 1000, reason = ""): Promise<void> {
    if (this.closing) {
      await this.connection.closed;
      return;
    }
    this.closing = true;
    clearTimeout(this.serverInfoTimer);
    const error = new QwpEgressSessionClosedError();
    this.rejectServerInfo(error);
    this.active?.fail(error);
    this.active = undefined;
    await this.sendTail;
    await this.connection.close(code, reason);
    await this.receiveLoop;
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
            query.push(this.decoder.decode(message));
            break;
          }
          case "result-end": {
            const query = this.requireActive(message.requestId);
            this.active = undefined;
            query.finish(message);
            break;
          }
          case "exec-done": {
            const query = this.requireActive(message.requestId);
            this.active = undefined;
            query.finish(message);
            break;
          }
          case "query-error": {
            const query = this.requireActive(message.requestId);
            this.active = undefined;
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

  private send(payload: Uint8Array): Promise<void> {
    this.throwIfUnavailable();
    const sending = this.sendTail.then(async () => {
      this.throwIfUnavailable();
      await this.connection.send(payload);
    });
    this.sendTail = sending.catch((error: unknown) => this.fail(error));
    return sending;
  }

  private throwIfUnavailable(): void {
    if (this.failure) throw this.failure;
    if (this.closing) throw new QwpEgressSessionClosedError();
  }

  private fail(error: unknown): void {
    if (this.failure) return;
    clearTimeout(this.serverInfoTimer);
    this.failure =
      error instanceof Error ? error : new Error(`QWP egress failed: ${error}`);
    this.rejectServerInfo(this.failure);
    this.active?.fail(this.failure);
    this.active = undefined;
  }
}
