import {
  decodeQwpIngressResponse,
  encodeQwpIngressFrame,
  QWP_STATUS,
  QwpIngressEncodeOptions,
  QwpIngressResponse,
  QwpProtocolError,
  QwpTableBuffer,
} from "./core";
import {
  QwpBinaryConnection,
  QwpConnectionCloseInfo,
  QwpConnectionFactory,
} from "./transport";

export interface QwpIngressSessionOptions {
  ackTimeoutMs?: number;
  onResponse?: (response: QwpIngressResponse) => void;
  onDurableAck?: (response: QwpIngressResponse) => void;
}

interface PendingResponse {
  resolve: (response: QwpIngressResponse) => void;
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

/**
 * Connection-scoped ingress sequencer.
 *
 * One promise is registered before each WebSocket send, preventing a fast ACK
 * from racing its waiter. Calls are serialized to preserve the server's
 * zero-based wire sequence.
 */
export class QwpIngressSession {
  private readonly pending = new Map<bigint, PendingResponse>();
  private nextSequence = 0n;
  private sendTail: Promise<void> = Promise.resolve();
  private failure?: Error;
  private closing = false;
  private readonly receiveLoop: Promise<void>;

  constructor(
    private readonly connection: QwpBinaryConnection,
    private readonly options: QwpIngressSessionOptions = {},
  ) {
    const timeout = options.ackTimeoutMs ?? 15_000;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new RangeError("ackTimeoutMs must be a positive finite number");
    }
    this.receiveLoop = this.consumeMessages();
  }

  static async connect(
    factory: QwpConnectionFactory,
    options: QwpIngressSessionOptions = {},
  ): Promise<QwpIngressSession> {
    return new QwpIngressSession(await factory(), options);
  }

  get closed(): Promise<QwpConnectionCloseInfo> {
    return this.connection.closed;
  }

  sendTables(
    tables: readonly QwpTableBuffer[],
    encodeOptions: QwpIngressEncodeOptions = {},
  ): Promise<QwpIngressResponse> {
    return this.sendFrame(encodeQwpIngressFrame(tables, encodeOptions));
  }

  sendFrame(frame: Uint8Array): Promise<QwpIngressResponse> {
    this.throwIfUnavailable();
    const sequence = this.nextSequence++;
    let pending!: PendingResponse;
    const response = new Promise<QwpIngressResponse>((resolve, reject) => {
      pending = { resolve, reject };
    });
    pending.timer = setTimeout(() => {
      if (!this.pending.delete(sequence)) return;
      pending.reject(
        new Error(`timed out waiting for QWP ACK [sequence=${sequence}]`),
      );
    }, this.options.ackTimeoutMs ?? 15_000);
    this.pending.set(sequence, pending);

    const sending = this.sendTail.then(async () => {
      this.throwIfUnavailable();
      await this.connection.send(frame);
    });
    this.sendTail = sending.catch((error: unknown) => {
      this.fail(error);
    });
    void sending.catch((error: unknown) => {
      const current = this.pending.get(sequence);
      if (current !== pending) return;
      this.pending.delete(sequence);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    });
    return response;
  }

  async close(code = 1000, reason = ""): Promise<void> {
    if (this.closing) {
      await this.connection.closed;
      return;
    }
    this.closing = true;
    this.rejectAll(new QwpIngressSessionClosedError());
    await this.sendTail;
    await this.connection.close(code, reason);
    await this.receiveLoop;
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
      this.invokeCallback(this.options.onDurableAck, response);
      return;
    }
    if (response.sequence === null) {
      throw new QwpProtocolError("QWP response is missing its wire sequence");
    }
    const pending = this.pending.get(response.sequence);
    if (!pending) {
      // A late response after timeout, or a duplicate ACK, is harmless.
      return;
    }
    this.pending.delete(response.sequence);
    if (pending.timer) clearTimeout(pending.timer);
    if (response.status === QWP_STATUS.OK) {
      pending.resolve(response);
    } else {
      pending.reject(new QwpIngressNackError(response));
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

  private throwIfUnavailable(): void {
    if (this.failure) throw this.failure;
    if (this.closing) throw new QwpIngressSessionClosedError();
  }

  private fail(error: unknown): void {
    if (this.failure) return;
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
  }
}
