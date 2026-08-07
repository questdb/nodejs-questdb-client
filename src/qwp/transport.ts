import { Buffer } from "node:buffer";
import { SenderTransport } from "../transport";
import { SenderOptions } from "../options";
import { QwpWebSocket, QwpWebSocketOptions } from "./ws/socket";
import { QwpUpgradeError } from "./ws/handshake";
import { decodeResponse, STATUS } from "./protocol/response";
import { UNCAPPED_CATCHUP_PACKING_LIMIT } from "./protocol/constants";
import { encodeFrame } from "./protocol/frameEncoder";
import { SymbolDict } from "./protocol/symbolDict";
import { AckTracker } from "./ackTracker";
import { Category, Policy, SenderError, classify, defaultPolicyFor } from "./errors";
import { HostTracker, HostState } from "./hostTracker";
import { Endpoint, parseAddrList } from "./endpoints";

const QWP_DEFAULT_AUTO_FLUSH_ROWS = 1000; // spec 9.1
const CLIENT_ID = "nodejs/1.0.0"; // protocol client version, not the package version (spec 6.5)

export class QwpTransport implements SenderTransport {
  private readonly options: SenderOptions;
  private ws?: QwpWebSocket;
  private readonly acks = new AckTracker();
  private errorHandler?: (e: SenderError) => void;
  private inFlight = 0;
  private endpoints: Endpoint[] = [];
  private tracker!: HostTracker;
  private current?: Endpoint;
  private readonly dict = new SymbolDict();
  private confirmedMaxId = -1;

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
    this.endpoints = parseAddrList(this.options.addr!, 9000);
    this.tracker = new HostTracker(this.endpoints.length);
    return this.connectLoop();
  }

  get connectedEndpoint(): Endpoint | undefined {
    return this.current;
  }

  private auth(): string | undefined {
    return this.options.username && this.options.password
      ? "Basic " +
        Buffer.from(`${this.options.username}:${this.options.password}`).toString("base64")
      : this.options.token
        ? `Bearer ${this.options.token}`
        : undefined;
  }

  private wsOptions(ep: Endpoint): QwpWebSocketOptions {
    return {
      host: ep.host,
      port: ep.port,
      tls: this.options.protocol === "wss",
      clientId: CLIENT_ID,
      authorization: this.auth(),
      rejectUnauthorized: this.options.tls_verify !== false,
      onBinary: (p) => this.onResponse(p),
      onClose: () => this.onDisconnected(),
    };
  }

  private backoffMillis(): number {
    return this.options.reconnect_initial_backoff_millis ?? 100;
  }

  private async connectLoop(): Promise<boolean> {
    for (;;) {
      const idx = this.tracker.pickNext();
      if (idx === null) {
        this.tracker.beginRound();
        // A fully-rejected round means no primary is reachable yet; retry
        // indefinitely rather than giving up (spec 6.5.1).
        await new Promise((r) => setTimeout(r, this.backoffMillis()));
        continue;
      }
      const ep = this.endpoints[idx];
      try {
        this.ws = await QwpWebSocket.connect(this.wsOptions(ep));
        this.tracker.record(idx, HostState.HEALTHY);
        this.current = ep;
        this.acks.onConnected(this.acks.acked + 1);
        await this.sendDictCatchUp();
        return true;
      } catch (e) {
        if (e instanceof QwpUpgradeError) {
          if (e.kind === "auth") throw e; // terminal, never rotate
          this.tracker.record(
            idx,
            e.kind === "role-reject" ? HostState.TOPOLOGY_REJECT : HostState.TRANSPORT_ERROR,
          );
        } else {
          this.tracker.record(idx, HostState.TRANSPORT_ERROR);
        }
      }
    }
  }

  /**
   * The server's dictionary is connection-scoped and empty after a reconnect,
   * so re-register from id 0 before any data frame or every delta frame earns
   * DICTIONARY_GAP (spec 7.5).
   */
  private async sendDictCatchUp(): Promise<void> {
    if (this.dict.size() === 0) return;
    const cap = this.ws?.maxBatchSize ?? UNCAPPED_CATCHUP_PACKING_LIMIT;
    const frame = encodeFrame([], { gorilla: false, dict: this.dict, confirmedMaxId: -1 });
    if (frame.length > cap) {
      throw new Error(`dictionary catch-up exceeds the batch cap [size=${frame.length}, cap=${cap}]`);
    }
    await this.ws!.sendBinary(frame);
    this.confirmedMaxId = this.dict.size() - 1;
  }

  /** Test hook: register a symbol in the transport-owned dictionary. */
  registerSymbolForTest(s: string): void {
    this.dict.getOrAdd(s);
  }

  /** Test hook: tear down and re-establish the connection (dict catch-up path). */
  async reconnectForTest(): Promise<void> {
    await this.ws?.close();
    this.ws = undefined;
    this.tracker.beginRound();
    await this.connectLoop();
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
