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
import { DurableAckTracker } from "./durableAckTracker";
import {
  SenderError,
  classify,
  defaultPolicyFor,
  Policy,
  Category,
} from "./errors";
import { HostTracker, HostState } from "./hostTracker";
import { Endpoint, parseAddrList } from "./endpoints";
import { Dispatcher } from "./dispatcher";
import { PoisonDetector } from "./poison";
import { SfEngine } from "./sf/engine";
import { startOrphanDrainers, OrphanDrainer } from "./sf/drainer";
import { QwpBuffer } from "./buffer";
import { BACKPRESSURE_NO_SPARE, PAYLOAD_TOO_LARGE } from "./sf/ring";

const QWP_DEFAULT_AUTO_FLUSH_ROWS = 1000; // spec 9.1
// Memory-mode store-and-forward defaults (spec 9.1, 9.2). The ring lives on
// the transport for every sender; disk mode swaps the engine in later.
const MEMORY_SEGMENT_BYTES = 4 * 1024 * 1024;
const MEMORY_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
/** spec 9.1: disk-mode retention is ~80x the memory-mode ring. */
const DISK_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;
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
  private readonly durableAcks = new DurableAckTracker();
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
  private terminalError?: SenderError;
  /** Ignore late callbacks from a socket that has already been recycled. */
  private connectionGeneration = 0;
  private activeConnectionGeneration = 0;
  /** Orphan drainers launched on startup (spec 8.4); stopped on close(). */
  private drainStarted = false;
  private drainers: OrphanDrainer[] = [];
  private drainerStartPromise?: Promise<void>;
  /** Poison-frame escalation (spec 7.4): strikes AND dwell, keyed on FSN. */
  private readonly poison: PoisonDetector;
  private poisoned = false;
  /** In-flight public connect, so an explicit connect() reuses the constructor's
   *  fire-and-forget one instead of double-opening the engine (spec 4.3). */
  private connectPromise?: Promise<boolean>;
  /** Includes post-upgrade catch-up/replay so only one loop mutates wire state. */
  private connectLoopPromise?: Promise<boolean>;
  /** Serialize whole publish batches so split frames and ACK correlation stay ordered. */
  private publishTail: Promise<void> = Promise.resolve();
  /** Reconnect replay and producer publication share one wire drain. */
  private drainTail: Promise<void> = Promise.resolve();

  constructor(options: SenderOptions) {
    this.options = options;
    this.engine = new SfEngine({
      segmentBytes: options.sf_segment_bytes ?? MEMORY_SEGMENT_BYTES,
      // spec 9.1: the total-retention default is mode-dependent — 128 MiB in
      // memory mode, 10 GiB in disk mode (sf_dir present). Applying the memory
      // figure to a disk user would cap retention ~80x early and shed unacked
      // frames during exactly the outage store-and-forward exists to survive.
      maxTotalBytes:
        options.sf_max_total_bytes ??
        (options.sf_dir ? DISK_MAX_TOTAL_BYTES : MEMORY_MAX_TOTAL_BYTES),
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
    this.events = new Dispatcher(
      options.connection_listener_inbox_capacity ?? 64,
      (e) => this.eventConsumer?.(e),
    );
    this.poison = new PoisonDetector(
      options.max_frame_rejections ?? 4, // spec 9.1
      options.poison_min_escalation_window_millis ?? 5_000, // spec 9.1
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

  /** The store-and-forward engine's configured retention cap (test hook). */
  get engineMaxTotalBytes(): number {
    return this.engine.maxTotalBytes;
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
    if (this.terminalError) throw this.terminalError;
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
    // Orphan scan + background drainers (spec 8.4): recover slots abandoned by
    // a crashed producer. Runs once on startup, after our own slot is locked so
    // it is never mistaken for an orphan. Drainers use private round cursors so
    // they never steal from the foreground connect round (spec 1.2).
    if (
      !this.drainStarted &&
      this.options.drain_orphans === true &&
      this.engine.isDisk
    ) {
      this.drainStarted = true;
      this.drainerStartPromise = startOrphanDrainers(
        this.options,
        this.endpoints,
        this.tracker,
        (e) => this.emit(e),
        (d) => this.drainers.push(d), // register eagerly so close() can stop them
        () => this.closed,
      ).then(
        () => undefined,
        (e: unknown) => {
          this.emit(
            new SenderError(
              Category.UNKNOWN,
              Policy.RETRIABLE,
              `orphan drainer startup failed: ${(e as Error)?.message ?? e}`,
            ),
          );
        },
      );
    }
    return this.runConnectLoop();
  }

  private runConnectLoop(): Promise<boolean> {
    if (this.connectLoopPromise) return this.connectLoopPromise;
    const running = this.connectLoop().finally(() => {
      if (this.connectLoopPromise === running) {
        this.connectLoopPromise = undefined;
      }
    });
    this.connectLoopPromise = running;
    return running;
  }

  get connectedEndpoint(): Endpoint | undefined {
    return this.current;
  }

  private auth(): string | undefined {
    return this.options.username && this.options.password
      ? "Basic " +
          Buffer.from(
            `${this.options.username}:${this.options.password}`,
          ).toString("base64")
      : this.options.token
        ? `Bearer ${this.options.token}`
        : undefined;
  }

  private wsOptions(ep: Endpoint, generation: number): QwpWebSocketOptions {
    return {
      host: ep.host,
      port: ep.port,
      tls: this.options.protocol === "wss",
      clientId: CLIENT_ID,
      authorization: this.auth(),
      rejectUnauthorized: this.options.tls_verify !== false,
      requestDurableAck: this.options.request_durable_ack === true,
      authTimeoutMs: this.options.auth_timeout_ms,
      keepaliveMs: this.options.durable_ack_keepalive_interval_millis,
      onBinary: (p) => this.onResponse(p, generation),
      onClose: (info) => this.onDisconnected(info, generation),
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
      const generation = ++this.connectionGeneration;
      let candidate: QwpWebSocket | undefined;
      try {
        candidate = await QwpWebSocket.connect(this.wsOptions(ep, generation));
        // Durable-ack capability gap (spec 6.5.1): an opted-in client that did
        // not get the X-QWP-Durable-Ack: enabled confirmation must fail fast.
        if (
          this.options.request_durable_ack === true &&
          candidate.durableAck !== true
        ) {
          throw new DurableAckMismatchError(
            `server did not confirm X-QWP-Durable-Ack while request_durable_ack=on [endpoint=${ep.host}:${ep.port}]`,
          );
        }
        if (this.closed) {
          await candidate.close().catch(() => undefined);
          return false;
        }
        this.ws = candidate;
        this.activeConnectionGeneration = generation;
        this.tracker.record(idx, HostState.HEALTHY);
        this.current = ep;
        this.emitConnectionEvent({ type: "connected", endpoint: ep });
        // Account for catch-up before sending it: an immediate server response
        // must not be interpreted using the previous connection's sequence map.
        const catchUpFrames = this.dict.size() === 0 ? 0 : 1;
        this.acks.onConnected(this.engine.ackedFsn + 1, catchUpFrames);
        this.durableAcks.reset(this.engine.ackedFsn);
        await this.sendDictCatchUp();
        // Replay frames published beyond the acked FSN (memory-mode retention).
        this.sentUpTo = this.engine.ackedFsn;
        await this.queueDrain();
        return true;
      } catch (e) {
        if (this.activeConnectionGeneration === generation) {
          this.activeConnectionGeneration = 0;
          this.ws = undefined;
          this.current = undefined;
        }
        await candidate?.close().catch(() => undefined);
        if (e instanceof DurableAckMismatchError) throw e;
        if (e instanceof QwpUpgradeError) {
          if (e.kind === "auth") throw e; // terminal, never rotate
          this.tracker.record(
            idx,
            e.kind === "role-reject"
              ? HostState.TOPOLOGY_REJECT
              : HostState.TRANSPORT_ERROR,
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
    const frame = encodeFrame([], {
      gorilla: false,
      dict: this.dict,
      confirmedMaxId: -1,
    });
    if (frame.length > cap) {
      throw new Error(
        `dictionary catch-up exceeds the batch cap [size=${frame.length}, cap=${cap}]`,
      );
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
    await this.runConnectLoop();
  }

  async send(data: Buffer): Promise<boolean> {
    if (this.terminalError) throw this.terminalError;
    if (this.poisoned)
      throw new Error("QWP transport is terminal (poisoned frame)");
    if (!this.ws) throw new Error("QWP transport is not connected");
    await this.ws.sendBinary(data);
    return true;
  }

  /**
   * Publishes frames into the store-and-forward ring, then drains what the
   * current connection has not yet sent. flush() therefore resolves on
   * publish, not on server ACK (spec 4.4).
   */
  sendFrames(frames: Buffer[]): Promise<boolean> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.poisoned) {
      return Promise.reject(
        new Error("QWP transport is terminal (poisoned frame)"),
      );
    }
    if (this.closed)
      return Promise.reject(new Error("QWP transport is closed"));
    // Capture this batch's dictionary target before another flush seals and
    // overwrites the buffer's pending target.
    const deltaTarget = this.buffer?.pendingDeltaTarget ?? -1;
    const run = this.publishTail.then(() =>
      this.publishFrames(frames, deltaTarget),
    );
    this.publishTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async publishFrames(
    frames: Buffer[],
    deltaTarget: number,
  ): Promise<boolean> {
    if (this.terminalError) throw this.terminalError;
    if (this.poisoned)
      throw new Error("QWP transport is terminal (poisoned frame)");
    const deadline = Date.now() + SF_APPEND_DEADLINE_MILLIS;
    for (const f of frames) {
      for (;;) {
        const fsn = await this.engine.append(f);
        if (fsn === PAYLOAD_TOO_LARGE) {
          throw new Error(
            `frame does not fit a fresh segment [size=${f.length}]`,
          );
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
      this.buffer?.confirmDeltaPublished(deltaTarget);
    }
    await this.queueDrain();
    return true;
  }

  private queueDrain(): Promise<void> {
    const run = this.drainTail.then(() => this.drain());
    this.drainTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Sends everything published beyond what the current connection has sent. */
  private async drain(): Promise<void> {
    const ws = this.ws;
    const generation = this.activeConnectionGeneration;
    if (!ws || generation === 0) return;
    const pending = this.engine.framesFrom(this.sentUpTo + 1);
    for (const f of pending) {
      if (ws !== this.ws || generation !== this.activeConnectionGeneration) {
        break;
      }
      // Register before awaiting the write: an immediate local response can
      // arrive before the write callback resumes this coroutine.
      this.acks.onFrameSent();
      await ws.sendBinary(f);
      if (generation !== this.activeConnectionGeneration) break;
      this.sentUpTo++;
    }
  }

  private onResponse(payload: Buffer, generation: number): void {
    if (generation !== this.activeConnectionGeneration || this.terminalError)
      return;
    const r = decodeResponse(payload);
    if (r.status === STATUS.OK) {
      const exactFsn = this.acks.fsnForAck(r.sequence);
      if (exactFsn !== null) {
        this.acks.onAck(r.sequence);
        // Only acceptance AT OR BEYOND the suspect frame clears a strike (spec
        // 7.4) — re-OKs behind it must not launder the count.
        this.poison.accept(exactFsn);
        if (this.options.request_durable_ack === true) {
          const durableFsn = this.durableAcks.onOk(exactFsn, r.tables);
          if (durableFsn !== null) this.engine.acknowledge(durableFsn);
        } else {
          this.engine.acknowledge(exactFsn);
        }
      }
      return;
    }
    if (r.status === STATUS.DURABLE_ACK) {
      if (this.options.request_durable_ack === true) {
        const durableFsn = this.durableAcks.onDurableAck(r.tables);
        if (durableFsn !== null) this.engine.acknowledge(durableFsn);
      }
      return;
    }

    const category = classify(r.status);
    const policy = defaultPolicyFor(category);
    const fsn = this.acks.fsnForAck(r.sequence);
    const err = new SenderError(
      category,
      policy,
      r.errorMessage ??
        `server rejected frame [status=0x${r.status.toString(16)}]`,
      r.status,
      fsn ?? this.engine.ackedFsn + 1,
      fsn ?? this.engine.publishedFsn,
    );

    if (policy === Policy.TERMINAL) {
      this.latchTerminal(err);
      return;
    }
    // A RETRIABLE rejection is a verdict on the named bytes and counts toward
    // poison escalation. RETRIABLE_OTHER is a node-state verdict and rotates
    // without adding a strike.
    if (
      policy === Policy.RETRIABLE &&
      fsn !== null &&
      this.poison.strike(fsn)
    ) {
      this.poisonEscalated(
        fsn,
        r.errorMessage ?? `status=0x${r.status.toString(16)}`,
      );
      return;
    }
    this.emit(err);
    this.recycleAfterNack(policy);
  }

  private latchTerminal(err: SenderError): void {
    this.terminalError = err;
    this.closed = true;
    this.activeConnectionGeneration = 0;
    this.emit(err);
    const ws = this.ws;
    this.ws = undefined;
    this.current = undefined;
    void ws?.close().catch(() => undefined);
  }

  private recycleAfterNack(policy: Policy): void {
    const ws = this.ws;
    const endpoint = this.current;
    this.activeConnectionGeneration = 0;
    this.ws = undefined;
    this.current = undefined;
    this.durableAcks.reset(this.engine.ackedFsn);
    this.emitConnectionEvent({ type: "disconnected", endpoint });
    if (policy === Policy.RETRIABLE) {
      // Retry the healthy node first. RETRIABLE_OTHER deliberately preserves
      // the current round cursor so connectLoop rotates to another endpoint.
      this.tracker.beginRound();
    } else if (endpoint) {
      const idx = this.endpoints.findIndex(
        (e) => e.host === endpoint.host && e.port === endpoint.port,
      );
      if (idx >= 0) this.tracker.record(idx, HostState.TRANSIENT_REJECT);
    }
    void (ws ? ws.close().catch(() => undefined) : Promise.resolve()).finally(
      () => void this.reconnect(),
    );
  }

  /**
   * A frame was rejected too many times within the dwell window: PROTOCOL_VIOLATION
   * is TERMINAL (spec 7.4). Stop replaying it — under store-and-forward a poisoned
   * frame would otherwise replay forever — and surface the error, then tear down.
   */
  private poisonEscalated(fsn: number, detail: string): void {
    this.poisoned = true;
    this.latchTerminal(
      new SenderError(
        Category.PROTOCOL_VIOLATION,
        Policy.TERMINAL,
        `poisoned frame ${fsn} was rejected too many times within the poison escalation ` +
          `window — terminal (${detail})`,
        -1,
        fsn,
        fsn,
      ),
    );
  }

  private onDisconnected(
    info: { orderly: boolean; framesSent: number },
    generation: number,
  ): void {
    if (generation !== this.activeConnectionGeneration) return;
    this.activeConnectionGeneration = 0;
    this.emitConnectionEvent({ type: "disconnected", endpoint: this.current });
    this.current = undefined;
    this.ws = undefined;
    this.durableAcks.reset(this.engine.ackedFsn);
    // spec 7.4: a NON-orderly close AFTER at least one send counts a strike on
    // the head-of-line unacked frame (the first frame the reconnect replays). An
    // orderly close (NORMAL/GONE) or a connection that sent nothing never counts
    // — otherwise a graceful failover would false-positive into a terminal.
    if (!info.orderly && info.framesSent > 0 && !this.poisoned) {
      // Poison follows the retained replay head, not the highest commit-level
      // OK. In durable mode an accepted frame remains retained until its table
      // watermark arrives; striking OK+1 can target an unpublished FSN and can
      // never be cleared by replay acceptance.
      const fsn = this.engine.ackedFsn + 1;
      if (
        fsn >= 0 &&
        fsn <= this.engine.publishedFsn &&
        this.poison.strike(fsn)
      ) {
        this.poisonEscalated(
          fsn,
          "connection dropped repeatedly while the head-of-line frame was unacked",
        );
        return; // terminal: do not reconnect into the same poison
      }
    }
    // With store-and-forward retention in place a disconnect no longer loses
    // in-flight frames: they are replayed from the ring on reconnect. Make the
    // reconnect automatic instead of surfacing DATA_LOSS (spec 8.1.1).
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.closed) return;
    this.reconnecting = true;
    try {
      await this.runConnectLoop();
    } catch (e) {
      if (!this.closed) {
        const auth = e instanceof QwpUpgradeError && e.kind === "auth";
        this.latchTerminal(
          new SenderError(
            auth ? Category.SECURITY_ERROR : Category.PROTOCOL_VIOLATION,
            Policy.TERMINAL,
            `QWP reconnect failed terminally: ${(e as Error)?.message ?? e}`,
          ),
        );
      }
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
    await this.publishTail;
    await this.drainTail;
    for (const d of this.drainers) d.stop();
    // Startup may be waiting for a drainer slot. Stopping current workers wakes
    // it; shouldStop prevents it from constructing any post-close workers.
    await this.drainerStartPromise;
    for (const d of this.drainers) d.stop();
    await Promise.all(
      this.drainers.map((d) => d.finished.catch(() => undefined)),
    );
    await this.ws?.close();
    this.ws = undefined;
    await this.engine.close();
  }

  getDefaultAutoFlushRows(): number {
    return QWP_DEFAULT_AUTO_FLUSH_ROWS;
  }

  getDefaultAutoFlushInterval(): number {
    return 100; // spec 9.1
  }
}
