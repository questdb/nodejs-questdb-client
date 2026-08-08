import { Buffer } from "node:buffer";
import { connect as netConnect, Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { encodeClientFrame, FrameParser, OPCODE } from "./frame";
import {
  buildUpgradeRequest,
  computeAccept,
  parseUpgradeResponse,
} from "./handshake";

const DEFAULT_AUTH_TIMEOUT_MS = 15_000; // spec 9.1

export interface QwpWebSocketOptions {
  host: string;
  port: number;
  tls: boolean;
  clientId: string;
  authorization?: string;
  rejectUnauthorized?: boolean;
  ca?: Buffer | Buffer[];
  requestDurableAck?: boolean;
  /** spec 9.1: connect + handshake timeout (default 15000 ms). */
  authTimeoutMs?: number;
  /** spec 9.1: keepalive PING interval; < = 0 disables (default 200 ms). */
  keepaliveMs?: number;
  /** Inbound binary payloads (response frames) are handed here. */
  onBinary?: (payload: Buffer) => void;
  /**
   * Fires once when the connection is dropped or closed externally.
   * `orderly` is true for a remote NORMAL_CLOSURE/GOING_AWAY close handshake,
   * false for an abrupt drop — which is what the poison detector keys on
   * (spec 7.4). `framesSent` counts frames written on this connection.
   */
  onClose?: (info: { orderly: boolean; framesSent: number }) => void;
}

export class QwpWebSocket {
  private readonly socket: Socket;
  private readonly parser = new FrameParser();
  private closed = false;
  private readonly onBinary?: (payload: Buffer) => void;
  private readonly onClose?: (info: {
    orderly: boolean;
    framesSent: number;
  }) => void;
  private framesSent = 0;
  private closeNotified = false;
  private readonly keepalive?: NodeJS.Timeout;
  readonly maxBatchSize?: number;
  /** True when the server confirmed durable-ack capability (spec 6.5.1). */
  readonly durableAck: boolean;

  private constructor(
    socket: Socket,
    maxBatchSize: number | undefined,
    durableAck: boolean,
    onBinary?: (payload: Buffer) => void,
    onClose?: (info: { orderly: boolean; framesSent: number }) => void,
    keepaliveMs?: number,
  ) {
    this.socket = socket;
    this.maxBatchSize = maxBatchSize;
    this.durableAck = durableAck;
    this.onBinary = onBinary;
    this.onClose = onClose;
    // Neither WebSocket framing errors nor application response-decoder errors
    // may escape an EventEmitter callback: an uncaught throw here terminates the
    // host process. Convert both into one abrupt-close notification instead.
    this.socket.on("data", (chunk: Buffer) => this.handleDataSafely(chunk));
    this.socket.on("close", () => this.handleClosed());
    this.socket.on("error", () => this.handleClosed());
    // Keepalive PING (spec 9.1, durable_ack_keepalive_interval_millis).
    // < = 0 disables; the default 200 keeps the server's durable-ack wait
    // bounded by a liveness signal even when no data is flowing.
    if (keepaliveMs && keepaliveMs > 0) {
      this.keepalive = setInterval(() => {
        if (!this.closed)
          this.socket.write(encodeClientFrame(OPCODE.PING, Buffer.alloc(0)));
      }, keepaliveMs);
    }
  }

  static connect(opts: QwpWebSocketOptions): Promise<QwpWebSocket> {
    return new Promise((resolve, reject) => {
      const socket: Socket = opts.tls
        ? tlsConnect({
            host: opts.host,
            port: opts.port,
            rejectUnauthorized: opts.rejectUnauthorized !== false,
            ca: opts.ca,
          })
        : netConnect({ host: opts.host, port: opts.port });

      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(authTimer);
        reject(e);
      };
      // spec 9.1: bound the connect + handshake by auth_timeout_ms (15 s). A
      // black-holed endpoint would otherwise hang the sender forever.
      const authTimer = setTimeout(() => {
        socket.destroy();
        fail(
          new Error(`QWP connect timed out [host=${opts.host}:${opts.port}]`),
        );
      }, opts.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS);

      const onError = (e: Error) => fail(e);
      socket.once("error", onError);

      socket.once(opts.tls ? "secureConnect" : "connect", () => {
        const { request, key } = buildUpgradeRequest(opts);
        socket.write(request);

        let acc = Buffer.alloc(0);
        const onHeaderData = (chunk: Buffer) => {
          acc = Buffer.concat([acc, chunk]);
          if (acc.indexOf("\r\n\r\n") < 0) return;
          socket.off("data", onHeaderData);
          socket.off("error", onError);
          clearTimeout(authTimer);
          try {
            const res = parseUpgradeResponse(acc);
            if (res.accept !== computeAccept(key)) {
              throw new Error("websocket: Sec-WebSocket-Accept mismatch");
            }
            const ws = new QwpWebSocket(
              socket,
              res.maxBatchSize,
              res.durableAck === "enabled",
              opts.onBinary,
              opts.onClose,
              opts.keepaliveMs,
            );
            // Resolve before dispatching bytes coalesced with the HTTP 101.
            // Consumers such as QwpTransport must activate their connection
            // generation before any response/close callback can arrive.
            settled = true;
            resolve(ws);
            if (res.leftover.length > 0) {
              queueMicrotask(() => ws.handleDataSafely(res.leftover));
            }
          } catch (e) {
            socket.destroy();
            fail(e as Error);
          }
        };
        socket.on("data", onHeaderData);
      });
    });
  }

  private handleDataSafely(chunk: Buffer): void {
    if (this.closed) return;
    try {
      this.onData(chunk);
    } catch {
      this.failConnection();
    }
  }

  private onData(chunk: Buffer): void {
    this.parser.push(chunk);
    for (let m = this.parser.next(); m; m = this.parser.next()) {
      switch (m.opcode) {
        case OPCODE.PING:
          this.socket.write(encodeClientFrame(OPCODE.PONG, m.payload));
          break;
        case OPCODE.CLOSE: {
          // RFC 6455 §5.5.1: echo the close before tearing down.
          // The close payload's 2-byte code classifies orderliness: NORMAL
          // (1000) and GOING_AWAY (1001) are orderly; anything else (or none)
          // is not (spec 7.4 — only NON-orderly closes can count a strike).
          if (!this.closed) {
            this.closed = true;
            if (this.keepalive) clearInterval(this.keepalive);
            this.socket.write(encodeClientFrame(OPCODE.CLOSE, m.payload));
            this.socket.end();
          }
          const code = m.payload.length >= 2 ? m.payload.readUInt16BE(0) : -1;
          this.notifyClosed(code === 1000 || code === 1001);
          return;
        }
        case OPCODE.BINARY:
          this.onBinary?.(m.payload);
          break;
        default:
          break;
      }
    }
  }

  /** One write per frame, so a control frame can never interleave mid-frame. */
  sendBinary(payload: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("websocket is closed"));
      const frame = encodeClientFrame(OPCODE.BINARY, payload);
      this.framesSent++;
      this.socket.write(frame, (err) => (err ? reject(err) : resolve()));
    });
  }

  private notifyClosed(orderly: boolean): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    if (this.keepalive) clearInterval(this.keepalive);
    this.onClose?.({ orderly, framesSent: this.framesSent });
  }

  private failConnection(): void {
    if (!this.closed) {
      this.closed = true;
      this.socket.destroy();
    }
    this.notifyClosed(false);
  }

  private handleClosed(): void {
    // Fires on external drop (server teardown / socket error). A remote CLOSE
    // handshake notifies in onData; our own close() intentionally does not.
    if (this.closed) return;
    this.closed = true;
    this.notifyClosed(false);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.closed) {
        if (this.keepalive) clearInterval(this.keepalive);
        return resolve();
      }
      this.closed = true;
      if (this.keepalive) clearInterval(this.keepalive);
      this.socket.write(encodeClientFrame(OPCODE.CLOSE, Buffer.alloc(0)));
      this.socket.end(() => resolve());
    });
  }
}
