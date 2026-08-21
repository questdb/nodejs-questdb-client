import { createSocket, type Socket } from "node:dgram";
import {
  encodeQwpIngressFrame,
  type QwpIngressEncodeOptions,
  type QwpIngressResponse,
  type QwpTableBuffer,
} from "../qwp/core";
import type { QwpSenderSession } from "../qwp/sender";

const DEFAULT_QWP_UDP_PORT = 9007;
const DEFAULT_MAX_DATAGRAM_SIZE = 1_400;

/** Minimal injectable UDP socket surface used by the Node QWP sender. */
export interface QwpNodeUdpSocketLike {
  bind(port: number, address: string, callback: () => void): void;
  send(
    message: Uint8Array,
    port: number,
    address: string,
    callback: (error: Error | null, bytes: number) => void,
  ): void;
  close(callback: () => void): void;
  on(event: "error", listener: (error: Error) => void): unknown;
  setMulticastTTL(ttl: number): number;
  setMulticastInterface(multicastInterface: string): void;
}

export interface QwpNodeUdpOptions {
  /** Destination hostname or IPv4 address. */
  host: string;
  /** Destination port. Defaults to the Java QWP UDP port, 9007. */
  port?: number;
  /** Maximum encoded datagram size. Defaults to 1400 bytes. */
  maxDatagramSize?: number;
  /** IPv4 multicast TTL from 0 through 255. Defaults to 0. */
  multicastTtl?: number;
  /** Optional local IPv4 interface used for multicast traffic. */
  multicastInterface?: string;
  /** Receives isolated local socket errors; UDP has no server acknowledgement. */
  onError?: (error: Error) => void;
  /** @internal Test hook. */
  socketFactory?: () => QwpNodeUdpSocketLike;
}

export interface QwpNodeUdpMetrics {
  readonly publishedDatagramSequence: bigint;
  readonly totalDatagramsSent: number;
  readonly totalBytesSent: number;
  readonly totalSendErrors: number;
  readonly closed: boolean;
}

/** A single encoded row cannot fit into the configured UDP datagram. */
export class QwpUdpDatagramTooLargeError extends Error {
  constructor(
    readonly maxDatagramSize: number,
    readonly datagramSize: number,
    readonly tableName: string,
    readonly row: number,
  ) {
    super(
      `single QWP row exceeds maximum UDP datagram size [maxDatagramSize=${maxDatagramSize}, datagramSize=${datagramSize}, table=${tableName}, row=${row}]`,
    );
    this.name = "QwpUdpDatagramTooLargeError";
  }
}

/**
 * Node-only, fire-and-forget QWP v1 ingress session over IPv4 UDP.
 *
 * Each datagram is self-contained: it carries one table, an inline schema and
 * local symbol dictionaries. There are no ACKs, retries, transactions,
 * authentication, compression, or store-and-forward semantics.
 */
export class QwpNodeUdpSession implements QwpSenderSession {
  readonly maxBatchSizeBytes: number;
  private readonly host: string;
  private readonly port: number;
  private readonly multicastTtl: number;
  private readonly multicastInterface?: string;
  private readonly onError?: (error: Error) => void;
  private readonly socket: QwpNodeUdpSocketLike;
  private bindReject?: (error: Error) => void;
  private closePromise?: Promise<void>;
  private bound = false;
  private closing = false;
  private closed = false;
  private sequence = -1n;
  private totalDatagramsSent = 0;
  private totalBytesSent = 0;
  private totalSendErrors = 0;

  private constructor(options: QwpNodeUdpOptions) {
    this.host = validateHost(options.host);
    this.port = validatePort(options.port ?? DEFAULT_QWP_UDP_PORT);
    this.maxBatchSizeBytes = validatePositiveInteger(
      options.maxDatagramSize ?? DEFAULT_MAX_DATAGRAM_SIZE,
      "maxDatagramSize",
    );
    this.multicastTtl = validateTtl(options.multicastTtl ?? 0);
    this.multicastInterface = options.multicastInterface?.trim() || undefined;
    this.onError = options.onError;
    this.socket =
      options.socketFactory?.() ?? socketAdapter(createSocket("udp4"));
    this.socket.on("error", (error) => this.handleSocketError(error));
  }

  static async connect(options: QwpNodeUdpOptions): Promise<QwpNodeUdpSession> {
    const session = new QwpNodeUdpSession(options);
    try {
      await session.bind();
      return session;
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
  }

  get publishedFrameSequence(): bigint {
    return this.sequence;
  }

  get acknowledgedFrameSequence(): bigint {
    // UDP has no remote ACK. Treat successful local handoff as the only
    // available watermark so the shared high-level sender can close cleanly.
    return this.sequence;
  }

  get udpMetrics(): QwpNodeUdpMetrics {
    return Object.freeze({
      publishedDatagramSequence: this.sequence,
      totalDatagramsSent: this.totalDatagramsSent,
      totalBytesSent: this.totalBytesSent,
      totalSendErrors: this.totalSendErrors,
      closed: this.closed,
    });
  }

  // Not `async`: validation and encoding must run synchronously, before the
  // returned promise exists. The high-level sender transfers row ownership as
  // soon as a flush reaches the transport, so a batch that cannot be encoded
  // has to fail the flush before that transfer -- the same contract
  // planIngressFrames gives the WebSocket path by throwing out of
  // sendTablesWithPublication. Only the sends themselves are deferred, and a
  // failed send is fire-and-forget by design.
  sendTables(
    tables: readonly QwpTableBuffer[],
    options: QwpIngressEncodeOptions = {},
  ): Promise<QwpIngressResponse> {
    this.assertOpen();
    if (options.deferCommit) {
      throw new Error(
        "QWP UDP does not support transactions or deferred commit",
      );
    }
    const datagrams = encodeUdpDatagrams(tables, this.maxBatchSizeBytes);
    return this.sendDatagrams(datagrams);
  }

  publishTables(
    tables: readonly QwpTableBuffer[],
    options: QwpIngressEncodeOptions = {},
  ): Promise<void> {
    return this.sendTables(tables, options).then(() => undefined);
  }

  private async sendDatagrams(
    datagrams: readonly Uint8Array[],
  ): Promise<QwpIngressResponse> {
    for (const datagram of datagrams) await this.send(datagram);
    return { status: 0, sequence: this.sequence, tables: [] };
  }

  waitForAcknowledged(targetSequence: bigint): Promise<void> {
    this.assertOpen();
    if (targetSequence > this.sequence) {
      return Promise.reject(
        new RangeError(
          `QWP UDP datagram sequence has not been published [target=${targetSequence}, published=${this.sequence}]`,
        ),
      );
    }
    return Promise.resolve();
  }

  waitForDurable(): Promise<void> {
    return Promise.reject(
      new Error("QWP UDP does not provide server or durable acknowledgements"),
    );
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = new Promise<void>((resolve) => {
      if (!this.bound) {
        this.closed = true;
        resolve();
        return;
      }
      this.socket.close(() => {
        this.bound = false;
        this.closed = true;
        resolve();
      });
    });
    return this.closePromise;
  }

  private bind(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.bindReject = reject;
      this.socket.bind(0, "0.0.0.0", () => {
        this.bindReject = undefined;
        this.bound = true;
        try {
          this.socket.setMulticastTTL(this.multicastTtl);
          if (this.multicastInterface) {
            this.socket.setMulticastInterface(this.multicastInterface);
          }
          resolve();
        } catch (error) {
          reject(asError(error));
        }
      });
    });
  }

  private send(datagram: Uint8Array): Promise<void> {
    this.assertOpen();
    return new Promise<void>((resolve) => {
      const complete = (error: Error | null, bytes = 0): void => {
        this.sequence++;
        if (error) {
          this.reportError(error);
        } else {
          this.totalDatagramsSent++;
          this.totalBytesSent += bytes;
        }
        // Match Java's fire-and-forget policy: local UDP send failures are
        // observable, but they do not make flush retry already-sent rows.
        resolve();
      };
      try {
        this.socket.send(datagram, this.port, this.host, complete);
      } catch (error) {
        complete(asError(error));
      }
    });
  }

  private handleSocketError(error: Error): void {
    const reject = this.bindReject;
    if (reject) {
      this.bindReject = undefined;
      reject(error);
      return;
    }
    this.reportError(error);
  }

  private reportError(error: Error): void {
    this.totalSendErrors++;
    try {
      this.onError?.(error);
    } catch {
      // UDP error observers cannot participate in sender progress.
    }
  }

  private assertOpen(): void {
    if (this.closing || this.closed)
      throw new Error("QWP UDP sender is closed");
  }
}

function encodeUdpDatagrams(
  tables: readonly QwpTableBuffer[],
  maxDatagramSize: number,
): Uint8Array[] {
  const result: Uint8Array[] = [];
  for (const table of tables) {
    let start = 0;
    while (start < table.rowCount) {
      let low = start + 1;
      let high = table.rowCount;
      let acceptedEnd = start;
      let accepted: Uint8Array | undefined;
      let smallestRejectedSize = 0;
      while (low <= high) {
        const end = Math.floor((low + high) / 2);
        const encoded = encodeQwpIngressFrame([table.sliceRows(start, end)], {
          gorilla: false,
        });
        if (encoded.byteLength <= maxDatagramSize) {
          acceptedEnd = end;
          accepted = encoded;
          low = end + 1;
        } else {
          smallestRejectedSize = encoded.byteLength;
          high = end - 1;
        }
      }
      if (!accepted) {
        const oneRow = encodeQwpIngressFrame(
          [table.sliceRows(start, start + 1)],
          { gorilla: false },
        );
        throw new QwpUdpDatagramTooLargeError(
          maxDatagramSize,
          smallestRejectedSize || oneRow.byteLength,
          table.name,
          start,
        );
      }
      result.push(accepted);
      start = acceptedEnd;
    }
  }
  return result;
}

function socketAdapter(socket: Socket): QwpNodeUdpSocketLike {
  return socket as unknown as QwpNodeUdpSocketLike;
}

function validateHost(host: string): string {
  const value = host?.trim();
  if (!value) throw new RangeError("QWP UDP host must not be empty");
  return value;
}

function validatePort(port: number): number {
  const value = validatePositiveInteger(port, "port");
  if (value > 65_535)
    throw new RangeError("QWP UDP port must not exceed 65535");
  return value;
}

function validateTtl(ttl: number): number {
  if (!Number.isSafeInteger(ttl) || ttl < 0 || ttl > 255) {
    throw new RangeError("QWP UDP multicastTtl must be between 0 and 255");
  }
  return ttl;
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`QWP UDP ${name} must be a positive safe integer`);
  }
  return value;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
