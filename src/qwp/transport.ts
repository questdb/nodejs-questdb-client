import { Buffer } from "node:buffer";
import { SenderTransport } from "../transport";
import { SenderOptions } from "../options";
import { QwpWebSocket } from "./ws/socket";
import { decodeResponse, STATUS } from "./protocol/response";
import { AckTracker } from "./ackTracker";
import { Category, Policy, SenderError, classify, defaultPolicyFor } from "./errors";

const QWP_DEFAULT_AUTO_FLUSH_ROWS = 1000; // spec 9.1
const CLIENT_ID = "nodejs/1.0.0"; // protocol client version, not the package version (spec 6.5)

export class QwpTransport implements SenderTransport {
  private readonly options: SenderOptions;
  private ws?: QwpWebSocket;
  private readonly acks = new AckTracker();
  private errorHandler?: (e: SenderError) => void;
  private inFlight = 0;

  constructor(options: SenderOptions) {
    this.options = options;
  }

  onError(h: (e: SenderError) => void): void {
    this.errorHandler = h;
  }

  get ackedFsn(): number {
    return this.acks.acked;
  }

  private emit(e: SenderError): void {
    try {
      this.errorHandler?.(e);
    } catch {
      /* a handler must never break the sender (spec 4.2) */
    }
  }

  async connect(): Promise<boolean> {
    const auth = this.options.username && this.options.password
      ? "Basic " +
        Buffer.from(`${this.options.username}:${this.options.password}`).toString("base64")
      : this.options.token
        ? `Bearer ${this.options.token}`
        : undefined;

    this.ws = await QwpWebSocket.connect({
      host: this.options.host!,
      port: this.options.port!,
      tls: this.options.protocol === "wss",
      clientId: CLIENT_ID,
      authorization: auth,
      rejectUnauthorized: this.options.tls_verify !== false,
      onBinary: (p) => this.onResponse(p),
      onClose: () => this.onDisconnected(),
    });
    this.acks.onConnected(0);
    return true;
  }

  async send(data: Buffer): Promise<boolean> {
    if (!this.ws) throw new Error("QWP transport is not connected");
    await this.ws.sendBinary(data);
    return true;
  }

  /** Sends each frame as its own WebSocket binary message. */
  async sendFrames(frames: Buffer[]): Promise<boolean> {
    if (!this.ws) throw new Error("QWP transport is not connected");
    for (const f of frames) {
      this.inFlight++;
      this.acks.onFrameSent();
      await this.ws.sendBinary(f);
    }
    return true;
  }

  private onResponse(payload: Buffer): void {
    const r = decodeResponse(payload);
    if (r.status === STATUS.OK) {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.acks.onAck(r.sequence);
      return;
    }
    if (r.status === STATUS.DURABLE_ACK) return;
    const category = classify(r.status);
    this.emit(
      new SenderError(
        category,
        defaultPolicyFor(category),
        r.errorMessage ?? `server rejected frame [status=0x${r.status.toString(16)}]`,
        r.status,
      ),
    );
  }

  private onDisconnected(): void {
    if (this.inFlight > 0) {
      // No retention until Plan 4: these frames are gone. Say so.
      this.emit(
        new SenderError(
          Category.DATA_LOSS,
          Policy.ABANDONED,
          `connection lost with ${this.inFlight} frame(s) in flight and no retention configured`,
        ),
      );
      this.inFlight = 0;
    }
  }

  /** Server-advertised cap, or a conservative default before the handshake. */
  get maxBatchSize(): number {
    return this.ws?.maxBatchSize ?? 16 * 1024 * 1024;
  }

  async close(): Promise<void> {
    await this.ws?.close();
    this.ws = undefined;
  }

  getDefaultAutoFlushRows(): number {
    return QWP_DEFAULT_AUTO_FLUSH_ROWS;
  }
}
