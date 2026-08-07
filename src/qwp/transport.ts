import { Buffer } from "node:buffer";
import { SenderTransport } from "../transport";
import { SenderOptions } from "../options";
import { QwpWebSocket } from "./ws/socket";

const QWP_DEFAULT_AUTO_FLUSH_ROWS = 1000; // spec 9.1
const CLIENT_ID = "nodejs/1.0.0"; // protocol client version, not the package version (spec 6.5)

export class QwpTransport implements SenderTransport {
  private readonly options: SenderOptions;
  private ws?: QwpWebSocket;

  constructor(options: SenderOptions) {
    this.options = options;
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
    });
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
      await this.ws.sendBinary(f);
    }
    return true;
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
