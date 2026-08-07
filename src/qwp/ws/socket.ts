import { Buffer } from "node:buffer";
import { connect as netConnect, Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { encodeClientFrame, FrameParser, OPCODE } from "./frame";
import { buildUpgradeRequest, computeAccept, parseUpgradeResponse } from "./handshake";

export interface QwpWebSocketOptions {
  host: string;
  port: number;
  tls: boolean;
  clientId: string;
  authorization?: string;
  rejectUnauthorized?: boolean;
  ca?: Buffer | Buffer[];
  requestDurableAck?: boolean;
  /** Inbound binary payloads (response frames) are handed here. */
  onBinary?: (payload: Buffer) => void;
  /** Fires once when the connection is dropped or closed externally. */
  onClose?: () => void;
}

export class QwpWebSocket {
  private readonly socket: Socket;
  private readonly parser = new FrameParser();
  private closed = false;
  private readonly onBinary?: (payload: Buffer) => void;
  private readonly onClose?: () => void;
  readonly maxBatchSize?: number;
  /** True when the server confirmed durable-ack capability (spec 6.5.1). */
  readonly durableAck: boolean;

  private constructor(
    socket: Socket,
    maxBatchSize: number | undefined,
    durableAck: boolean,
    onBinary?: (payload: Buffer) => void,
    onClose?: () => void,
  ) {
    this.socket = socket;
    this.maxBatchSize = maxBatchSize;
    this.durableAck = durableAck;
    this.onBinary = onBinary;
    this.onClose = onClose;
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
    this.socket.on("close", () => this.handleClosed());
    this.socket.on("error", () => this.handleClosed());
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

      const onError = (e: Error) => reject(e);
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
            );
            if (res.leftover.length > 0) ws.onData(res.leftover);
            resolve(ws);
          } catch (e) {
            socket.destroy();
            reject(e);
          }
        };
        socket.on("data", onHeaderData);
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.parser.push(chunk);
    for (let m = this.parser.next(); m; m = this.parser.next()) {
      switch (m.opcode) {
        case OPCODE.PING:
          this.socket.write(encodeClientFrame(OPCODE.PONG, m.payload));
          break;
        case OPCODE.CLOSE:
          // RFC 6455 §5.5.1: echo the close before tearing down.
          if (!this.closed) {
            this.closed = true;
            this.socket.write(encodeClientFrame(OPCODE.CLOSE, m.payload));
            this.socket.end();
          }
          this.onClose?.();
          break;
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
      this.socket.write(frame, (err) => (err ? reject(err) : resolve()));
    });
  }

  private handleClosed(): void {
    // Fires on external drop (server teardown / socket error) OR on a remote
    // CLOSE handshake. Our own close() sets `closed` first, so it is excluded
    // and the transport is never told a graceful shutdown was a failure.
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.closed) return resolve();
      this.closed = true;
      this.socket.write(encodeClientFrame(OPCODE.CLOSE, Buffer.alloc(0)));
      this.socket.end(() => resolve());
    });
  }
}
