import {
  decodeQwpIngressResponse,
  encodeQwpDurableAckPollFrame,
  encodeQwpIngressFrame,
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
  /**
   * Optional local ingress frame cap. Browsers cannot read WebSocket upgrade
   * headers, so browser applications should set this to the server's configured
   * QWP cap. When the server also advertises a cap, the smaller value wins.
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
}

interface PendingResponse {
  resolve: (response: QwpIngressResponse) => void;
  reject: (error: unknown) => void;
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
    const connection = options.reconnect
      ? await QwpReconnectingIngressConnection.connect(
          factory,
          options.reconnect,
          options.replayStore,
          options.maxBatchSizeBytes,
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

  sendTables(
    tables: readonly QwpTableBuffer[],
    encodeOptions: QwpIngressEncodeOptions = {},
  ): Promise<QwpIngressResponse> {
    return this.sendFrame(encodeQwpIngressFrame(tables, encodeOptions));
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
    if (
      this.maxBatchSizeBytes !== undefined &&
      frame.byteLength > this.maxBatchSizeBytes
    ) {
      this.symbolDictionary.truncate(previousSize);
      return Promise.reject(
        new QwpBatchTooLargeError(frame.byteLength, this.maxBatchSizeBytes),
      );
    }
    this.publishedMaxSymbolId = this.symbolDictionary.size - 1;
    this.deltaSymbolsPublished = true;
    try {
      return this.sendFrame(frame);
    } catch (error) {
      this.symbolDictionary.truncate(previousSize);
      this.publishedMaxSymbolId = previousSize - 1;
      throw error;
    }
  }

  sendFrame(frame: Uint8Array): Promise<QwpIngressResponse> {
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
    let pending!: PendingResponse;
    const response = new Promise<QwpIngressResponse>((resolve, reject) => {
      pending = { resolve, reject };
    });
    this.pending.set(sequence, pending);

    const sending = this.sendTail.then(async () => {
      this.throwIfUnavailable();
      await this.connection.send(frame);
    });
    this.sendTail = sending.catch((error: unknown) => {
      this.fail(error);
    });
    void sending.then(
      () => {
        if (this.pending.get(sequence) !== pending) return;
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(sequence)) return;
          pending.reject(
            new Error(`timed out waiting for QWP ACK [sequence=${sequence}]`),
          );
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
        reject(new Error("timed out waiting for QWP durable ACK"));
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
      this.applyDurableAck(response);
      this.invokeCallback(this.options.onDurableAck, response);
      return;
    }
    if (response.sequence === null) {
      throw new QwpProtocolError("QWP response is missing its wire sequence");
    }
    if (response.status === QWP_STATUS.OK) {
      this.trackDurableTargets(response);
      for (const [sequence, pending] of this.pending) {
        if (sequence > response.sequence) break;
        this.pending.delete(sequence);
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(response);
      }
      return;
    }

    const pending = this.pending.get(response.sequence);
    if (!pending) {
      // A late response after timeout, or a duplicate response, is harmless.
      return;
    }
    this.pending.delete(response.sequence);
    if (pending.timer) clearTimeout(pending.timer);
    const error = new QwpIngressNackError(response);
    pending.reject(error);
    if (
      this.deltaSymbolsPublished &&
      response.status === QWP_STATUS.DICTIONARY_GAP
    ) {
      // This wire cannot repair a missing prefix without reconnect catch-up.
      this.fail(error);
      void this.connection.close(1002, "QWP symbol dictionary gap");
    }
  }

  private invokeCallback(
    callback: ((response: QwpIngressResponse) => void) | undefined,
    response: QwpIngressResponse,
  ): void {
    if (!callback) return;
    try {
      callback(response);
    } catch {
      // Observability callbacks must not break protocol progress.
    }
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

  private applyDurableAck(response: QwpIngressResponse): void {
    for (const table of response.tables) {
      const watermark = this.durableWatermarks.get(table.name);
      if (watermark === undefined || table.sequenceTransaction > watermark) {
        this.durableWatermarks.set(table.name, table.sequenceTransaction);
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

  private fail(error: unknown): void {
    if (this.failure) return;
    this.clearDurablePoll();
    this.failure =
      error instanceof Error
        ? error
        : new Error(`QWP ingress failed: ${error}`);
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
