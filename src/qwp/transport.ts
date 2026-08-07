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
import { QwpBuffer } from "./buffer";
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

/** Terminal durable-ack capability gap; escapes the rotation loop (spec 6.5.1). */
class DurableAckMismatchError extends Error {}

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
  /** The producer's buffer, once the Sender has attached it (delta wiring). */
  private buffer?: QwpBuffer;
  /** Highest FSN sent on the current connection (wire replay start). */
  private sentUpTo = -1;
  private reconnecting = false;
  private closed = false;
  /** In-flight public connect, so an explicit connect() reuses the constructor's
   *  fire-and-forget one instead of double-opening the engine (spec 4.3). */
  private connectPromise?: Promise<boolean>;

  constructor(options: SenderOptions) {
    this.options = options;
    this.engine = new SfEngine({
      segmentBytes: options.sf_segment_bytes ?? MEMORY_SEGMENT_BYTES,
      maxTotalBytes: options.sf_max_total_bytes ?? MEMORY_MAX_TOTAL_BYTES,
      sfDir: options.sf_dir,
      senderId: options.sender_id ?? DEFAULT_SENDER_ID,
      durability: options.sf_durability === "periodic" ? "periodic" : "memory",
      syncIntervalMillis: options.sf_sync_interval_millis,
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

  /**
   * Attach the producer's buffer so delta symbol-dictionary mode can run
   * end-to-end (spec 8.1.6). Shares the transport-owned connection dictionary
   * with the buffer and installs the engine's write-ahead persist hook. Must be
   * called once, before connect(), from the Sender construction path.
   */
  attachSymbolBuffer(b: QwpBuffer): void {
    this.buffer = b;
    b.attachDict(this.dict, (entries) => this.engine.persistSymbols(entries));
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
    // Idempotent: the constructor may already have kicked off a fire-and-forget
    // connect (derived SYNC mode). An explicit connect() must join that in-flight
    // attempt rather than open the engine a second time (spec 4.3, 8.3 slot lock).
    if (this.ws) return true;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async doConnect(): Promise<boolean> {
    await this.engine.open();
    // Recovery seeding (spec 8.1.6, 5.2): the engine's recovered dictionary is a
    // DIFFERENT SymbolDict from the transport's connection-scoped one. Seed ours
    // positionally via addRecovered (never getOrAdd, which de-dupes and would
    // desync the persisted id scheme), and tell the buffer the recovered count is
    // already confirmed. That way the first flush only persists/ships NEW
    // symbols and does not re-write the recovered baseline to .symbol-dict. The
    // recovered symbols themselves reach the fresh server via the catch-up frame
    // in connectLoop (spec 7.5).
    if (this.engine.isDisk) {
      const recovered = this.engine.symbolDict;
      const recoveredSize = recovered.size();
      for (const s of recovered.entriesFrom(0)) this.dict.addRecovered(s);
      if (recoveredSize > 0) this.buffer?.setConfirmedMaxId(recoveredSize - 1);
    }
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
      requestDurableAck: this.options.request_durable_ack === true,
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
        // Durable-ack capability gap (spec 6.5.1): an opted-in client that did
        // not get the X-QWP-Durable-Ack: enabled confirmation must fail fast.
        // Retrying the same endpoints cannot turn a non-capable server into a
        // capable one, so this is terminal, not a rotation.
        if (
          this.options.request_durable_ack === true &&
          this.ws.durableAck !== true
        ) {
          const err = new DurableAckMismatchError(
            `server did not confirm X-QWP-Durable-Ack while request_durable_ack=on [endpoint=${ep.host}:${ep.port}]`,
          );
          await this.ws.close().catch(() => undefined);
          this.ws = undefined;
          throw err;
        }
        this.tracker.record(idx, HostState.HEALTHY);
        this.current = ep;
        this.emitConnectionEvent({ type: "connected", endpoint: ep });
        // Re-register the dictionary FIRST. The catch-up frame(s) occupy the
        // lowest connection-scoped wire seqs, so onConnected must know how many
        // precede the ring replay or the first ring-frame ACK over-trims (spec
        // 6.6.1).
        const catchUpFrames = await this.sendDictCatchUp();
        this.acks.onConnected(this.engine.ackedFsn + 1, catchUpFrames);
        // Replay frames published beyond the acked FSN (memory-mode retention):
        // after a reconnect the dictionary is re-registered first, then every
        // unacked frame is re-sent from ackedFsn + 1 (spec 7.5, 8.1.1).
        this.sentUpTo = this.engine.ackedFsn;
        await this.drain();
        return true;
      } catch (e) {
        if (e instanceof DurableAckMismatchError) throw e;
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
   * DICTIONARY_GAP (spec 7.5). Returns the number of catch-up frames sent so
   * the caller can account for the wire seqs they consume (spec 6.6.1).
   */
  private async sendDictCatchUp(): Promise<number> {
    if (this.dict.size() === 0) return 0;
    const cap = this.ws?.maxBatchSize ?? UNCAPPED_CATCHUP_PACKING_LIMIT;
    const frame = encodeFrame([], { gorilla: false, dict: this.dict, confirmedMaxId: -1 });
    if (frame.length > cap) {
      throw new Error(`dictionary catch-up exceeds the batch cap [size=${frame.length}, cap=${cap}]`);
    }
    await this.ws!.sendBinary(frame);
    this.confirmedMaxId = this.dict.size() - 1;
    // The fresh server now knows the whole dictionary, so no old id is delta-pending
    // any more: re-pin the buffer baseline to the dictionary tail so only truly new
    // symbols are persisted/shipped going forward (spec 5.2, 7.5).
    this.buffer?.setConfirmedMaxId(this.confirmedMaxId);
    return 1;
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
      // The frame is queued onto the ring: this is the point where the delta
      // baseline may advance (spec 5.2). Only reaches here on append success;
      // a PAYLOAD_TOO_LARGE or backpressure deadline above throws before it, and
      // the baseline stays put so ids never ship as a delta the server lacks.
      // Replayed frames (drain) never call this, so a reconnect cannot double-
      // advance it. It is idempotent and forward-only, so per-frame and
      // per-(whole-)batch confirmation are equivalent.
      this.buffer?.confirmDeltaPublished();
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
