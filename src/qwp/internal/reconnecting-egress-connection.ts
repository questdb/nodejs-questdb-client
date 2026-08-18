import {
  decodeQwpEgressMessage,
  QWP_EGRESS_MESSAGE,
  QwpProtocolError,
  QwpServerInfoMessage,
} from "../core";
import {
  QWP_RECONNECT_EVENT_KIND,
  QWP_UPGRADE_ERROR_KIND,
  QwpBinaryConnection,
  QwpConnectionCloseInfo,
  QwpConnectionFactory,
  QwpEgressReplayRequiredError,
  QwpEgressReplayResetEvent,
  QwpFailoverError,
  QwpHandshakeMetadata,
  QwpReconnectEvent,
  QwpReconnectExhaustedError,
  QwpReconnectOptions,
  QwpSendClosedError,
  QwpUpgradeError,
} from "../transport";
import { QwpAsyncQueue } from "./async-queue";

type ReplayResetHandler = (
  event: QwpEgressReplayResetEvent,
) => void | Promise<void>;
type ConnectionResetHandler = (
  serverInfo: QwpServerInfoMessage,
) => void | Promise<void>;
type QueryRequestEncoder = (
  serverInfo: QwpServerInfoMessage,
  requestId: bigint,
) => Uint8Array | Promise<Uint8Array>;

class ReplayResetCallbackError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("QWP egress replay reset callback failed");
    this.name = "ReplayResetCallbackError";
    this.cause = cause;
  }
}

/**
 * Reconnects an egress wire and, only with an explicit reset handler, replays
 * the in-flight request and its control messages. Statements may therefore be
 * executed more than once when their outcome was lost with the connection.
 */
export class QwpReconnectingEgressConnection implements QwpBinaryConnection {
  private readonly messagesQueue = new QwpAsyncQueue<Uint8Array>();
  private readonly maxAttempts: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxDurationMs: number;
  private readonly resolveClosed: (info: QwpConnectionCloseInfo) => void;
  private connection?: QwpBinaryConnection;
  private connectingCandidate?: QwpBinaryConnection;
  private lastHandshake?: QwpHandshakeMetadata;
  private lastEndpoint?: string | URL;
  private initialServerInfo?: QwpServerInfoMessage;
  private currentServerInfo?: QwpServerInfoMessage;
  private outboundReplay: Uint8Array[] = [];
  private generation = 0;
  private sendTail: Promise<void> = Promise.resolve();
  private reconnectTask?: Promise<void>;
  private terminalError?: Error;
  private cancelBackoff?: () => void;
  private closing = false;
  private closedSettled = false;
  readonly messages: AsyncIterable<Uint8Array> = this.messagesQueue;
  readonly closed: Promise<QwpConnectionCloseInfo>;

  private constructor(
    private readonly factory: QwpConnectionFactory,
    private readonly reconnectOptions: QwpReconnectOptions,
    private readonly serverInfoTimeoutMs: number,
    private readonly onConnectionReset: ConnectionResetHandler,
    private readonly encodeQueryRequest: QueryRequestEncoder,
    private readonly onReplayReset?: ReplayResetHandler,
  ) {
    this.maxAttempts = reconnectOptions.maxAttempts ?? 3;
    this.initialBackoffMs = reconnectOptions.initialBackoffMs ?? 100;
    this.maxBackoffMs = reconnectOptions.maxBackoffMs ?? 5_000;
    this.maxDurationMs = reconnectOptions.maxDurationMs ?? 30_000;
    validateReconnectPolicy(
      this.maxAttempts,
      this.initialBackoffMs,
      this.maxBackoffMs,
      this.maxDurationMs,
    );
    let resolveClosed!: (info: QwpConnectionCloseInfo) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.resolveClosed = resolveClosed;
  }

  static async connect(
    factory: QwpConnectionFactory,
    reconnectOptions: QwpReconnectOptions,
    serverInfoTimeoutMs: number,
    onConnectionReset: ConnectionResetHandler,
    encodeQueryRequest: QueryRequestEncoder,
    onReplayReset?: ReplayResetHandler,
  ): Promise<QwpReconnectingEgressConnection> {
    const reconnecting = new QwpReconnectingEgressConnection(
      factory,
      reconnectOptions,
      serverInfoTimeoutMs,
      onConnectionReset,
      encodeQueryRequest,
      onReplayReset,
    );
    try {
      await reconnecting.connectLoop(undefined, false);
      return reconnecting;
    } catch (error) {
      await reconnecting.close().catch(() => undefined);
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
    const copy = payload.slice();
    const sending = this.sendTail.then(async () => {
      this.throwIfUnavailable();
      const connection = await this.requireConnection();
      const prepared = await this.prepareOutboundQuery(copy);
      this.trackOutbound(prepared);
      try {
        await connection.send(prepared);
      } catch (error) {
        await this.requestReconnect(error, connection);
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
        // Preserve the requested close result when transport shutdown races.
      }
    }
    if (connectingCandidate && connectingCandidate !== connection) {
      await connectingCandidate.close(code, reason).catch(() => undefined);
    }
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
        const iterator = candidate.messages[Symbol.asyncIterator]();
        const serverInfoPayload = await this.readServerInfo(
          iterator,
          candidate,
        );
        const serverInfo = decodeQwpEgressMessage(serverInfoPayload);
        if (serverInfo.kind !== "server-info") {
          throw new QwpProtocolError(
            "QWP egress connection did not begin with SERVER_INFO",
          );
        }
        if (reconnecting) {
          this.validateServerInfo(serverInfo, candidate);
          await this.replayInto(
            candidate,
            serverInfo,
            previousEndpoint,
            initialCause,
          );
        } else {
          this.initialServerInfo = serverInfo;
          this.currentServerInfo = serverInfo;
          this.messagesQueue.push(serverInfoPayload);
        }
        if (this.closing) throw new QwpSendClosedError();
        this.currentServerInfo = serverInfo;
        this.install(candidate, iterator);
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
        } else {
          this.emitEvent({
            kind: QWP_RECONNECT_EVENT_KIND.CONNECTED,
            attempt: 0,
            endpoint: candidate.endpoint,
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

  private install(
    connection: QwpBinaryConnection,
    iterator: AsyncIterator<Uint8Array>,
  ): void {
    this.connection = connection;
    this.lastHandshake = connection.handshake;
    this.lastEndpoint = connection.endpoint;
    const generation = ++this.generation;
    void this.pump(connection, iterator, generation);
  }

  private async pump(
    connection: QwpBinaryConnection,
    iterator: AsyncIterator<Uint8Array>,
    generation: number,
  ): Promise<void> {
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        if (this.closing || this.connection !== connection) return;
        const message = decodeQwpEgressMessage(next.value);
        if (message.kind === "server-info") {
          throw new QwpProtocolError("received duplicate QWP SERVER_INFO");
        } else if (
          message.kind === "result-end" ||
          message.kind === "exec-done" ||
          message.kind === "query-error"
        ) {
          this.outboundReplay = [];
        }
        this.messagesQueue.push(next.value);
      }
      if (this.closing || this.connection !== connection) return;
      await this.requestReconnect(
        new QwpSendClosedError(await connection.closed),
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
      if (error instanceof QwpProtocolError) {
        this.failTerminal(error);
        await connection
          .close(1002, "invalid QWP egress message")
          .catch(() => undefined);
        return;
      }
      await this.requestReconnect(error, connection).catch((reconnectError) => {
        this.failTerminal(reconnectError);
      });
    }
  }

  private async readServerInfo(
    iterator: AsyncIterator<Uint8Array>,
    connection: QwpBinaryConnection,
  ): Promise<Uint8Array> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error("timed out waiting for QWP reconnect SERVER_INFO")),
        this.serverInfoTimeoutMs,
      );
    });
    try {
      const result = await Promise.race([iterator.next(), timeout]);
      if (result.done) {
        throw new QwpSendClosedError(await connection.closed);
      }
      return result.value;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private validateServerInfo(
    serverInfo: QwpServerInfoMessage,
    connection: QwpBinaryConnection,
  ): void {
    const initial = this.initialServerInfo;
    if (!initial) {
      throw new QwpProtocolError(
        "QWP reconnect started before the initial SERVER_INFO was received",
      );
    }
    if (
      initial.clusterId &&
      serverInfo.clusterId &&
      initial.clusterId !== serverInfo.clusterId
    ) {
      throw new QwpUpgradeError(
        `QWP reconnect target belongs to a different cluster [expected=${initial.clusterId}, actual=${serverInfo.clusterId}]`,
        {
          kind: QWP_UPGRADE_ERROR_KIND.CAPABILITY_MISMATCH,
          retryable: true,
          tryNextEndpoint: true,
          url: connection.endpoint,
        },
      );
    }
  }

  private async replayInto(
    connection: QwpBinaryConnection,
    serverInfo: QwpServerInfoMessage,
    previousEndpoint: string | URL | undefined,
    cause: unknown,
  ): Promise<void> {
    if (this.outboundReplay.length === 0) {
      // A terminal response may already be queued. Let the bounded session
      // consume it before resetting connection-scoped decoder state.
      await this.messagesQueue.barrier();
      await this.onConnectionReset(serverInfo);
      return;
    }
    // An active operation will be replayed from its request. Drop raw stale
    // messages before resetting the decoded queue; waiting for a barrier here
    // can deadlock when that queue is deliberately at its client-side bound.
    this.messagesQueue.clear();
    await this.onConnectionReset(serverInfo);
    const requestId = replayRequestId(this.outboundReplay);
    if (requestId === undefined) {
      throw new QwpProtocolError(
        "QWP egress replay is missing its QUERY_REQUEST",
      );
    }
    if (!this.onReplayReset) {
      throw new QwpEgressReplayRequiredError(requestId);
    }
    try {
      await this.onReplayReset({
        requestId,
        serverInfo,
        previousEndpoint,
        endpoint: connection.endpoint,
        cause,
      });
    } catch (error) {
      throw new ReplayResetCallbackError(error);
    }
    const request = await this.encodeQueryRequest(serverInfo, requestId);
    validateEncodedRequest(request, requestId);
    const preparedRequest = request.slice();
    this.outboundReplay[0] = preparedRequest;
    for (const payload of this.outboundReplay) await connection.send(payload);
  }

  private async prepareOutboundQuery(payload: Uint8Array): Promise<Uint8Array> {
    if (payload[0] !== QWP_EGRESS_MESSAGE.QUERY_REQUEST) return payload;
    const requestId = replayRequestId([payload]);
    const serverInfo = this.currentServerInfo;
    if (requestId === undefined || !serverInfo) {
      throw new QwpProtocolError(
        "QWP QUERY_REQUEST cannot be prepared before SERVER_INFO",
      );
    }
    const encoded = await this.encodeQueryRequest(serverInfo, requestId);
    validateEncodedRequest(encoded, requestId);
    return encoded.slice();
  }

  private trackOutbound(payload: Uint8Array): void {
    switch (payload[0]) {
      case QWP_EGRESS_MESSAGE.QUERY_REQUEST:
        this.outboundReplay = [payload];
        break;
      case QWP_EGRESS_MESSAGE.CREDIT:
      case QWP_EGRESS_MESSAGE.CANCEL:
        if (this.outboundReplay.length > 0) this.outboundReplay.push(payload);
        break;
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

function replayRequestId(payloads: readonly Uint8Array[]): bigint | undefined {
  const query = payloads.find(
    (payload) => payload[0] === QWP_EGRESS_MESSAGE.QUERY_REQUEST,
  );
  if (!query || query.byteLength < 9) return undefined;
  return new DataView(
    query.buffer,
    query.byteOffset,
    query.byteLength,
  ).getBigUint64(1, true);
}

function validateEncodedRequest(
  payload: Uint8Array,
  expectedRequestId: bigint,
): void {
  const requestId = replayRequestId([payload]);
  if (requestId !== expectedRequestId) {
    throw new QwpProtocolError(
      `QWP query encoder returned the wrong request [expected=${expectedRequestId}, actual=${requestId ?? "missing"}]`,
    );
  }
}

function validateReconnectPolicy(
  maxAttempts: number,
  initialBackoffMs: number,
  maxBackoffMs: number,
  maxDurationMs: number,
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
}

function isRetryableReconnectError(error: unknown): boolean {
  if (error instanceof QwpUpgradeError) return error.retryable !== false;
  if (error instanceof QwpFailoverError) {
    return error.attempts.some((attempt) =>
      isRetryableReconnectError(attempt.error),
    );
  }
  return !(
    error instanceof QwpEgressReplayRequiredError ||
    error instanceof ReplayResetCallbackError ||
    error instanceof QwpProtocolError
  );
}
