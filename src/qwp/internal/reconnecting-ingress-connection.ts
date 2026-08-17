import {
  decodeQwpIngressResponse,
  QWP_STATUS,
  QwpProtocolError,
} from "../core";
import {
  QWP_RECONNECT_EVENT_KIND,
  QwpBinaryConnection,
  QwpConnectionCloseInfo,
  QwpConnectionFactory,
  QwpFailoverError,
  QwpHandshakeMetadata,
  QwpIngressReplayRecord,
  QwpIngressReplayStore,
  QwpReconnectEvent,
  QwpReconnectExhaustedError,
  QwpReconnectOptions,
  QwpReplayRejectedError,
  QwpSendClosedError,
  QwpUpgradeError,
} from "../transport";
import { QwpAsyncQueue } from "./async-queue";

interface ReplayFrame extends QwpIngressReplayRecord {
  readonly clientSequence?: bigint;
  ackDelivered: boolean;
  transmitted: boolean;
  durableTargets?: Map<string, bigint>;
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

class QwpMemoryReplayStore implements QwpIngressReplayStore {
  private readonly records = new Map<bigint, Uint8Array>();

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
  private readonly store: QwpIngressReplayStore;
  private readonly maxAttempts: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxDurationMs: number;
  private readonly maxFrameRejections: number;
  private readonly resolveClosed: (info: QwpConnectionCloseInfo) => void;
  private connection?: QwpBinaryConnection;
  private connectingCandidate?: QwpBinaryConnection;
  private lastHandshake?: QwpHandshakeMetadata;
  private lastEndpoint?: string | URL;
  private wireFrames: ReplayFrame[] = [];
  private nextFrameSequence = 0n;
  private nextClientSequence = 0n;
  private rejectedFrameSequence?: bigint;
  private rejectionCount = 0;
  private generation = 0;
  private sendTail: Promise<void> = Promise.resolve();
  private reconnectTask?: Promise<void>;
  private terminalError?: Error;
  private cancelBackoff?: () => void;
  private closing = false;
  private closedSettled = false;
  readonly messages: AsyncIterable<Uint8Array> = this.messagesQueue;
  readonly closed: Promise<QwpConnectionCloseInfo>;
  ping?: () => Promise<void>;

  private constructor(
    private readonly factory: QwpConnectionFactory,
    private readonly reconnectOptions: QwpReconnectOptions,
    store: QwpIngressReplayStore,
    records: readonly QwpIngressReplayRecord[],
  ) {
    this.store = store;
    this.maxAttempts = reconnectOptions.maxAttempts ?? 3;
    this.initialBackoffMs = reconnectOptions.initialBackoffMs ?? 100;
    this.maxBackoffMs = reconnectOptions.maxBackoffMs ?? 5_000;
    this.maxDurationMs = reconnectOptions.maxDurationMs ?? 30_000;
    this.maxFrameRejections = reconnectOptions.maxFrameRejections ?? 4;
    validateReconnectPolicy(
      this.maxAttempts,
      this.initialBackoffMs,
      this.maxBackoffMs,
      this.maxDurationMs,
      this.maxFrameRejections,
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
    this.nextFrameSequence = previous + 1n;
  }

  static async connect(
    factory: QwpConnectionFactory,
    reconnectOptions: QwpReconnectOptions,
    replayStore?: QwpIngressReplayStore,
  ): Promise<QwpReconnectingIngressConnection> {
    const store = replayStore ?? new QwpMemoryReplayStore();
    let connection: QwpReconnectingIngressConnection | undefined;
    try {
      const records = await store.load();
      connection = new QwpReconnectingIngressConnection(
        factory,
        reconnectOptions,
        store,
        [...records].sort((a, b) =>
          a.frameSequence < b.frameSequence
            ? -1
            : a.frameSequence > b.frameSequence
              ? 1
              : 0,
        ),
      );
      await connection.connectLoop(undefined, false);
      return connection;
    } catch (error) {
      await connection?.close().catch(() => undefined);
      if (!connection) await store.close().catch(() => undefined);
      throw error;
    }
  }

  get handshake(): QwpHandshakeMetadata {
    if (!this.lastHandshake)
      throw new Error("QWP connection is not established");
    return this.lastHandshake;
  }

  get endpoint(): string | URL | undefined {
    return this.lastEndpoint;
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
    const sending = this.sendTail.then(async () => {
      this.throwIfUnavailable();
      await this.store.append(frame);
      this.frames.set(frame.frameSequence, frame);
      try {
        await this.transmit(frame);
      } catch (error) {
        this.failTerminal(error);
        throw error;
      }
    });
    this.sendTail = sending.catch(() => undefined);
    return sending;
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
    await this.store.close();
    this.settleClosed(closeInfo);
  }

  private async connectLoop(
    initialCause: unknown,
    reconnecting: boolean,
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

    if (
      initialCause instanceof RetriableIngressNackError &&
      initialCause.retryDelayMs > 0
    ) {
      await this.waitForBackoff(initialCause.retryDelayMs);
    }

    while (!this.closing) {
      if (attempt > 0 && backoffMs > 0) {
        await this.waitForBackoff(backoffMs);
        backoffMs = Math.min(Math.max(backoffMs * 2, 1), this.maxBackoffMs);
      }
      this.throwIfUnavailable();
      attempt++;
      let candidate: QwpBinaryConnection | undefined;
      try {
        candidate = await this.factory();
        this.connectingCandidate = candidate;
        if (this.closing) {
          await candidate.close().catch(() => undefined);
          throw new QwpSendClosedError();
        }
        const replayed = await this.replayInto(candidate);
        if (this.closing) throw new QwpSendClosedError();
        this.install(candidate, replayed);
        this.connectingCandidate = undefined;
        if (reconnecting) {
          this.emitEvent({
            kind:
              previousEndpoint !== undefined &&
              String(previousEndpoint) !== String(candidate.endpoint)
                ? QWP_RECONNECT_EVENT_KIND.FAILED_OVER
                : QWP_RECONNECT_EVENT_KIND.RECONNECTED,
            attempt,
            endpoint: candidate.endpoint,
            previousEndpoint,
          });
        }
        return;
      } catch (error) {
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
        if (!isRetryableReconnectError(error)) throw error;
        const attemptsExhausted =
          this.maxAttempts > 0 && attempt >= this.maxAttempts;
        const durationExhausted =
          this.maxDurationMs > 0 &&
          Date.now() - outageStarted >= this.maxDurationMs;
        if (attemptsExhausted || durationExhausted) {
          throw new QwpReconnectExhaustedError(attempt, lastError);
        }
      }
    }
    throw new QwpSendClosedError();
  }

  private async replayInto(
    connection: QwpBinaryConnection,
  ): Promise<ReplayFrame[]> {
    const replayed: ReplayFrame[] = [];
    const cap = connection.handshake.maxBatchSizeBytes;
    this.durableWatermarks.clear();
    for (const frame of this.frames.values()) {
      if (!frame.transmitted) continue;
      frame.durableTargets = undefined;
      if (cap !== undefined && frame.payload.byteLength > cap) {
        throw new RangeError(
          `persisted QWP frame exceeds reconnect target batch cap [size=${frame.payload.byteLength}, max=${cap}]`,
        );
      }
      replayed.push(frame);
      await connection.send(frame.payload);
    }
    return replayed;
  }

  private install(
    connection: QwpBinaryConnection,
    wireFrames: ReplayFrame[],
  ): void {
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
        if (this.closing || this.connection !== connection) return;
        const translated = await this.translateResponse(payload);
        if (translated) this.messagesQueue.push(translated);
        if (this.terminalError) return;
      }
      if (this.closing || this.connection !== connection) return;
      const info = await connection.closed;
      await this.requestReconnect(
        new QwpSendClosedError(info),
        connection,
      ).catch((reconnectError) => this.failTerminal(reconnectError));
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
      await this.requestReconnect(error, connection).catch((reconnectError) => {
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
    if (
      response.sequence < 0n ||
      response.sequence > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new QwpProtocolError(
        `QWP response sequence is outside the safe range: ${response.sequence}`,
      );
    }
    const wireIndex = Number(response.sequence);
    const frame = this.wireFrames[wireIndex];
    if (!frame) return undefined;

    if (response.status === QWP_STATUS.OK) {
      const covered = this.wireFrames.slice(0, wireIndex + 1);
      const clientTarget = findLastClientFrame(covered);
      const shouldDeliver = covered.some(
        (candidate) =>
          candidate.clientSequence !== undefined && !candidate.ackDelivered,
      );
      for (const candidate of covered) candidate.ackDelivered = true;
      if (
        this.rejectedFrameSequence !== undefined &&
        frame.frameSequence >= this.rejectedFrameSequence
      ) {
        this.rejectedFrameSequence = undefined;
        this.rejectionCount = 0;
      }
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

    if (isRetriableIngressStatus(response.status)) {
      const sameFrame = this.rejectedFrameSequence === frame.frameSequence;
      this.rejectedFrameSequence = frame.frameSequence;
      this.rejectionCount = sameFrame ? this.rejectionCount + 1 : 1;
      const notWritable = response.status === QWP_STATUS.NOT_WRITABLE;
      if (!notWritable && this.rejectionCount >= this.maxFrameRejections) {
        throw new QwpReplayRejectedError(
          frame.frameSequence,
          response.status,
          `frame remained rejected after ${this.rejectionCount} attempts${
            response.errorMessage ? `: ${response.errorMessage}` : ""
          }`,
        );
      }
      const exponent = notWritable
        ? Math.max(this.rejectionCount - 2, 0)
        : this.rejectionCount - 1;
      const retryDelayMs =
        notWritable && this.rejectionCount === 1
          ? 0
          : cappedExponentialBackoff(
              this.initialBackoffMs,
              this.maxBackoffMs,
              exponent,
            );
      throw new RetriableIngressNackError(
        frame.frameSequence,
        response.status,
        retryDelayMs,
        response.errorMessage,
      );
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
      if (!frame.durableTargets) break;
      if (!areTargetsCovered(frame.durableTargets, this.durableWatermarks)) {
        break;
      }
      lastCovered = frame.frameSequence;
    }
    if (lastCovered !== undefined) await this.acknowledgeThrough(lastCovered);
  }

  private async acknowledgeThrough(frameSequence: bigint): Promise<void> {
    await this.store.acknowledgeThrough(frameSequence);
    for (const sequence of this.frames.keys()) {
      if (sequence > frameSequence) break;
      this.frames.delete(sequence);
    }
  }

  private async transmit(frame: ReplayFrame): Promise<void> {
    const connection = await this.requireConnection();
    const cap = connection.handshake.maxBatchSizeBytes;
    if (cap !== undefined && frame.payload.byteLength > cap) {
      throw new RangeError(
        `QWP frame exceeds reconnect target batch cap [size=${frame.payload.byteLength}, max=${cap}]`,
      );
    }
    frame.transmitted = true;
    this.wireFrames.push(frame);
    try {
      await connection.send(frame.payload);
    } catch (error) {
      await this.requestReconnect(error, connection);
    }
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

    this.connection = undefined;
    void failedConnection.close().catch(() => undefined);
    const reconnecting = this.connectLoop(cause, true);
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

  private emitEvent(event: QwpReconnectEvent): void {
    try {
      this.reconnectOptions.onEvent?.(event);
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
    void this.connection
      ?.close(1011, "QWP reconnect failed")
      .catch(() => undefined);
  }

  private settleClosed(info: QwpConnectionCloseInfo): void {
    if (this.closedSettled) return;
    this.closedSettled = true;
    this.resolveClosed(info);
  }
}

function validateReconnectPolicy(
  maxAttempts: number,
  initialBackoffMs: number,
  maxBackoffMs: number,
  maxDurationMs: number,
  maxFrameRejections: number,
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
  return !(error instanceof QwpReplayRejectedError);
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
