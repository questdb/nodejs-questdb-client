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
import { SenderError, classify, defaultPolicyFor } from "./errors";
import { HostTracker, HostState } from "./hostTracker";
import { Endpoint, parseAddrList } from "./endpoints";
import { Dispatcher } from "./dispatcher";
import { SfEngine } from "./sf/engine";
import { BACKPRESSURE_NO_SPARE, PAYLOAD_TOO_LARGE } from "./sf/ring";

const QWP_DEFAULT_AUTO_FLUSH_ROWS = 1000; // spec 9.1
// Memory-mode store-and-forward defaults (spec 9.1, 9.2). The ring lives on
// the transport for every sender; disk mode swaps the engine in later.
const MEMORY_SEGMENT_BYTES = 4 * 1024 * 1024;
const MEMORY_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const SF_APPEND_DEADLINE_MILLIS = 30_000; // spec 4.4
const DEFAULT_SENDER_ID = "default";
const CLIENT_ID = "nodejs/1.0.0"; // protocol client version, not the package version (spec 6.5)

export enum ConnectMode {
  OFF = "OFF",
  SYNC = "SYNC",
}

export interface ConnectionEvent {
  type: "connected" | "disconnected";
  endpoint?: Endpoint;
  reason?: string;
}

/**
 * The default is DERIVED: setting any reconnect_* key implicitly upgrades
 * construction from non-connecting to connecting-with-retry, because those
 * knobs read as a general retry budget while the underlying path governs only
 * reconnects from an established connection (spec 4.3).
 */
export function deriveConnectMode(o: SenderOptions): ConnectMode {
  const anyReconnect =
    o.reconnect_max_duration_millis !== undefined ||
    o.reconnect_initial_backoff_millis !== undefined ||
    o.reconnect_max_backoff_millis !== undefined;
  return anyReconnect ? ConnectMode.SYNC : ConnectMode.OFF;
}

export class QwpTransport implements SenderTransport {
  private readonly options: SenderOptions;
  private ws?: QwpWebSocket;
  private readonly acks = new AckTracker();
  private readonly errors: Dispatcher<SenderError>;
  private readonly events: Dispatcher<ConnectionEvent>;
  private errorConsumer?: (e: SenderError) => void;
  private eventConsumer?: (e: ConnectionEvent) => void;
  private endpoints: Endpoint[] = [];
  private tracker!: HostTracker;
  private current?: Endpoint;
  private readonly dict = new SymbolDict();
  private confirmedMaxId = -1;
  private engine: SfEngine;
  /** Highest FSN sent on the current connection (wire replay start). */
  private sentUpTo = -1;
  private reconnecting = false;
  private closed = false;

  constructor(options: SenderOptions) {
    this.options = options;
    this.engine = new SfEngine({
      segmentBytes: options.sf_segment_bytes ?? MEMORY_SEGMENT_BYTES,
      maxTotalBytes: options.sf_max_total_bytes ?? MEMORY_MAX_TOTAL_BYTES,
      sfDir: options.sf_dir,
      senderId: options.sender_id ?? DEFAULT_SENDER_ID,
    });
    this.errors = new Dispatcher(options.error_inbox_capacity ?? 256, (e) =>
      this.errorConsumer?.(e),
    );
    // The connection-event inbox is a SEPARATE drop-oldest inbox at capacity
    // 64 (spec 9.1): error and connection notifications must not share a fence.
    this.events = new Dispatcher(options.connection_listener_inbox_capacity ?? 64, (e) =>
      this.eventConsumer?.(e),
    );
  }

  onError(h: (e: SenderError) => void): void {
    this.errorConsumer = h;
  }

  onConnectionEvent(h: (e: ConnectionEvent) => void): void {
    this.eventConsumer = h;
  }

  get ackedFsn(): number {
    return this.engine.ackedFsn;
  }

  private emit(e: SenderError): void {
    // Delivered async via the drop-oldest inbox; a handler must never break the
    // sender (spec 4.2).
    this.errors.offer(e);
  }

  private emitConnectionEvent(e: ConnectionEvent): void {
    this.events.offer(e);
  }

  async connect(): Promise<boolean> {
    await this.engine.open();
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
      if (this.closed) return false;
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
        this.emitConnectionEvent({ type: "connected", endpoint: ep });
        this.acks.onConnected(this.engine.ackedFsn + 1);
        await this.sendDictCatchUp();
        // Replay frames published beyond the acked FSN (memory-mode retention):
        // after a reconnect the dictionary is re-registered first, then every
        // unacked frame is re-sent from ackedFsn + 1 (spec 7.5, 8.1.1).
        this.sentUpTo = this.engine.ackedFsn;
        await this.drain();
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
    this.closed = false;
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

  /**
   * Publishes frames into the store-and-forward ring, then drains what the
   * current connection has not yet sent. flush() therefore resolves on
   * publish, not on server ACK (spec 4.4).
   */
  async sendFrames(frames: Buffer[]): Promise<boolean> {
    const deadline = Date.now() + SF_APPEND_DEADLINE_MILLIS;
    for (const f of frames) {
      for (;;) {
        const fsn = await this.engine.append(f);
        if (fsn === PAYLOAD_TOO_LARGE) {
          throw new Error(`frame does not fit a fresh segment [size=${f.length}]`);
        }
        if (fsn !== BACKPRESSURE_NO_SPARE) break;
        if (Date.now() >= deadline) {
          throw new Error(
            "store-and-forward append deadline exceeded while waiting for space",
          );
        }
        // Space frees only via ACK-driven trim on the I/O side; yield to it.
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    await this.drain();
    return true;
  }

  /** Sends everything published beyond what the current connection has sent. */
  private async drain(): Promise<void> {
    if (!this.ws) return;
    const pending = this.engine.framesFrom(this.sentUpTo + 1);
    for (const f of pending) {
      await this.ws.sendBinary(f);
      this.acks.onFrameSent();
      this.sentUpTo++;
    }
  }

  private onResponse(payload: Buffer): void {
    const r = decodeResponse(payload);
    if (r.status === STATUS.OK) {
      const fsn = this.acks.onAck(r.sequence);
      if (fsn !== null) this.engine.acknowledge(fsn);
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
    this.emitConnectionEvent({ type: "disconnected", endpoint: this.current });
    this.current = undefined;
    this.ws = undefined;
    // With store-and-forward retention in place a disconnect no longer loses
    // in-flight frames: they are replayed from the ring on reconnect. Make the
    // reconnect automatic instead of surfacing DATA_LOSS (spec 8.1.1).
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.closed) return;
    this.reconnecting = true;
    try {
      await this.connectLoop();
    } finally {
      this.reconnecting = false;
    }
  }

  /** Server-advertised cap, or a conservative default before the handshake. */
  get maxBatchSize(): number {
    return this.ws?.maxBatchSize ?? 16 * 1024 * 1024;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.ws?.close();
    this.ws = undefined;
    await this.engine.close();
  }

  getDefaultAutoFlushRows(): number {
    return QWP_DEFAULT_AUTO_FLUSH_ROWS;
  }
}
