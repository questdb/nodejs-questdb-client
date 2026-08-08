import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SenderOptions } from "../../options";
import { QwpWebSocket, QwpWebSocketOptions } from "../ws/socket";
import { QwpUpgradeError } from "../ws/handshake";
import { decodeResponse, STATUS } from "../protocol/response";
import { encodeFrame } from "../protocol/frameEncoder";
import { UNCAPPED_CATCHUP_PACKING_LIMIT } from "../protocol/constants";
import { AckTracker } from "../ackTracker";
import { DurableAckTracker } from "../durableAckTracker";
import { HostTracker, HostState } from "../hostTracker";
import { Endpoint } from "../endpoints";
import { SfEngine, EngineOptions } from "./engine";
import {
  acquireSlot,
  releaseSlot,
  acquireLogicalLock,
  releaseLogicalLock,
  isLiveLock,
  SlotHandle,
} from "./slotLock";
import { scanOrphans, OrphanSlot } from "./orphanScanner";
import {
  SenderError,
  Category,
  Policy,
  classify,
  defaultPolicyFor,
} from "../errors";

const CLIENT_ID = "nodejs/1.0.0";
const DEFAULT_BACKOFF = 100;
const POLL_QUIESCE = 10;
// Orphan-drainer cap-gap escalation (spec 7.5): a foreground sender retries a
// too-large catch-up forever; only a drainer may latch terminal, after this many
// consecutive cap gaps AND this dwell window. The dwell is defaulted in the
// config parser (catch_up_cap_gap_min_escalation_window_millis, spec 9.1).
const MAX_CATCHUP_CAP_GAP_ATTEMPTS = 16;
const DEFAULT_CATCHUP_CAP_GAP_DWELL_MILLIS = 300_000;
const FAILED_SENTINEL = ".failed";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function engineOptions(o: SenderOptions): EngineOptions {
  return {
    segmentBytes: o.sf_segment_bytes ?? 4 * 1024 * 1024,
    // Drainers only ever run in disk mode (they adopt orphan slots), so the
    // disk default applies here even when sf_max_total_bytes is unset (spec 9.1:
    // 10 GiB disk vs 128 MiB memory).
    maxTotalBytes: o.sf_max_total_bytes ?? 10 * 1024 * 1024 * 1024,
    senderId: o.sender_id ?? "default",
  };
}

/**
 * A background orphan drainer (spec 8.4): adopts an orphan slot left by a
 * crashed producer, opens its OWN WebSocket with a PRIVATE round cursor (never
 * the shared round, spec 1.2), and replays the slot read-only until ackedFsn
 * catches the startup snapshot of publishedFsn, then releases the slot. A
 * terminal failure drops a `.failed` sentinel so future scans skip it until an
 * operator clears it; a transient all-replica outage is retried indefinitely.
 */
export class OrphanDrainer {
  private stopped = false;
  private ws?: QwpWebSocket;
  private acks = new AckTracker();
  private durableAcks = new DurableAckTracker();
  private acked = -1;
  private fatalResponse?: Error;
  /** Reject late responses/closes from a recycled connection. */
  private connectionGeneration = 0;
  private activeConnectionGeneration = 0;
  private readonly running: Promise<void>;

  constructor(
    private readonly options: SenderOptions,
    private readonly endpoints: Endpoint[],
    private readonly tracker: HostTracker,
    private readonly slot: OrphanSlot,
    private readonly emit: (e: SenderError) => void,
  ) {
    this.running = this.run();
  }

  get finished(): Promise<void> {
    return this.running;
  }

  stop(): void {
    this.stopped = true;
    const ws = this.ws;
    this.activeConnectionGeneration = 0;
    this.ws = undefined;
    void ws?.close();
  }

  private onBinary(payload: Buffer, generation: number): void {
    if (generation !== this.activeConnectionGeneration) return;
    const r = decodeResponse(payload);
    if (r.status === STATUS.OK) {
      const f = this.acks.fsnForAck(r.sequence);
      if (f === null) return;
      this.acks.onAck(r.sequence);
      if (this.options.request_durable_ack === true) {
        const durable = this.durableAcks.onOk(f, r.tables);
        if (durable !== null) this.acked = Math.max(this.acked, durable);
      } else {
        this.acked = Math.max(this.acked, f);
      }
      return;
    }
    if (r.status === STATUS.DURABLE_ACK) {
      if (this.options.request_durable_ack === true) {
        const durable = this.durableAcks.onDurableAck(r.tables);
        if (durable !== null) this.acked = Math.max(this.acked, durable);
      }
      return;
    }
    const category = classify(r.status);
    const policy = defaultPolicyFor(category);
    if (policy === Policy.TERMINAL) {
      this.fatalResponse = new Error(
        `terminal orphan replay rejection (${category}): ${r.errorMessage ?? r.status}`,
      );
    }
    // Any retryable NACK recycles the connection and replays from the unchanged
    // read-only watermark. A terminal NACK is observed by replay() and causes
    // the slot to receive its .failed sentinel instead of hanging forever.
    this.recycleConnection(generation);
  }

  private onClose(generation: number): void {
    if (generation !== this.activeConnectionGeneration) return;
    this.activeConnectionGeneration = 0;
    this.ws = undefined;
  }

  private recycleConnection(generation: number): void {
    if (generation !== this.activeConnectionGeneration) return;
    const ws = this.ws;
    this.activeConnectionGeneration = 0;
    this.ws = undefined;
    void ws?.close();
  }

  private buildWsOptions(
    ep: Endpoint,
    generation: number,
  ): QwpWebSocketOptions {
    const auth =
      this.options.username && this.options.password
        ? "Basic " +
          Buffer.from(
            `${this.options.username}:${this.options.password}`,
          ).toString("base64")
        : this.options.token
          ? `Bearer ${this.options.token}`
          : undefined;
    return {
      host: ep.host,
      port: ep.port,
      tls: this.options.protocol === "wss",
      clientId: CLIENT_ID,
      authorization: auth,
      rejectUnauthorized: this.options.tls_verify !== false,
      requestDurableAck: this.options.request_durable_ack === true,
      authTimeoutMs: this.options.auth_timeout_ms,
      keepaliveMs: this.options.durable_ack_keepalive_interval_millis,
      onBinary: (payload) => this.onBinary(payload, generation),
      onClose: () => this.onClose(generation),
    };
  }

  private async run(): Promise<void> {
    const sfDir = this.options.sf_dir!;
    try {
      await acquireLogicalLock(sfDir, this.slot.senderId);
    } catch {
      // Another producer/drainer won adoption. Contention is not a replay
      // failure and must not become an unhandled rejected promise.
      return;
    }
    let held: SlotHandle | undefined;
    try {
      // Revalidate: a producer may have re-adopted the slot while we scanned.
      if (
        this.stopped ||
        (await isLiveLock(join(this.slot.slotDir, ".lock")))
      ) {
        return;
      }
      try {
        held = await acquireSlot(sfDir, this.slot.senderId);
      } catch {
        return; // a live holder appeared; not ours to drain
      }
      if (this.stopped) return;

      let engine: SfEngine;
      try {
        engine = await SfEngine.openReadOnly(
          engineOptions(this.options),
          sfDir,
          this.slot.senderId,
        );
      } catch (e) {
        await this.dropFailed(
          `orphan slot could not be recovered: ${(e as Error)?.message ?? e}`,
        );
        return;
      }
      try {
        await this.replay(engine);
        if (!this.stopped && this.acked >= engine.publishedFsn) {
          await this.retireOrphan(sfDir);
          // The owned lock moved with the retired directory and was deleted.
          held = undefined;
        }
      } catch (e) {
        await this.dropFailed((e as Error)?.message ?? String(e));
      }
    } finally {
      await releaseLogicalLock(sfDir, this.slot.senderId);
      if (held) await releaseSlot(held);
    }
  }

  /**
   * Make successful completion crash-safe: rename to an ignored hidden path
   * before deletion. A crash after rename can leak bytes but cannot replay them.
   */
  private async retireOrphan(sfDir: string): Promise<void> {
    const ws = this.ws;
    this.activeConnectionGeneration = 0;
    this.ws = undefined;
    await ws?.close().catch(() => undefined);
    const retired = join(
      sfDir,
      `.drained-${this.slot.senderId}-${randomUUID()}`,
    );
    await rename(this.slot.slotDir, retired);
    // Rename is the correctness boundary; cleanup is best-effort because the
    // hidden name is already outside scanner visibility.
    await rm(retired, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Terminal failure: drop the `.failed` sentinel and surface DATA_LOSS. */
  private async dropFailed(detail: string): Promise<void> {
    try {
      await writeFile(
        join(this.slot.slotDir, FAILED_SENTINEL),
        `drain failed at ${new Date().toISOString()}\n`,
      );
    } catch {
      /* best-effort sentinel */
    }
    this.emit(
      new SenderError(
        Category.DATA_LOSS,
        Policy.ABANDONED,
        `orphan slot '${this.slot.senderId}' failed to drain: ${detail}`,
        -1,
        -1,
        -1,
        this.slot.slotDir,
      ),
    );
  }

  /** Replay until ackedFsn catches the recovered publishedFsn, then release. */
  private async replay(engine: SfEngine): Promise<void> {
    const dict = engine.symbolDict;
    const target = engine.publishedFsn;
    this.acked = engine.ackedFsn;
    this.acks = new AckTracker();
    let cursor = this.tracker.newCursor();
    let capGapAttempts = 0;
    let capGapFirstAt = 0;
    const capGapDwell =
      this.options.catch_up_cap_gap_min_escalation_window_millis ??
      DEFAULT_CATCHUP_CAP_GAP_DWELL_MILLIS;
    const hasDict = dict.size() > 0;

    for (;;) {
      if (this.stopped) return;
      if (this.fatalResponse) throw this.fatalResponse;
      if (this.acked >= target) return;

      if (!this.ws) {
        const idx = cursor.pickNext();
        if (idx === null) {
          // Private round exhausted: transient. Back off and start a fresh round
          // (a fresh walker-local attempted set, never the shared round).
          cursor = this.tracker.newCursor();
          await sleep(
            this.options.reconnect_initial_backoff_millis ?? DEFAULT_BACKOFF,
          );
          continue;
        }
        const ep = this.endpoints[idx];
        const generation = ++this.connectionGeneration;
        let w: QwpWebSocket | undefined;
        try {
          w = await QwpWebSocket.connect(this.buildWsOptions(ep, generation));
          if (this.options.request_durable_ack === true && !w.durableAck) {
            await w.close();
            this.tracker.record(idx, HostState.TRANSIENT_REJECT);
            continue;
          }
          this.tracker.record(idx, HostState.HEALTHY);
          // Establish response correlation before catch-up is sent; a local
          // server can ACK in the same event-loop turn.
          this.acks.onConnected(this.acked + 1, hasDict ? 1 : 0);
          this.durableAcks.reset(this.acked);
          this.activeConnectionGeneration = generation;
          this.ws = w;
          if (hasDict) {
            // Connection-scoped dictionary is empty on a fresh server: re-register
            // it from id 0 before any replay frame (spec 7.5).
            const frame = encodeFrame([], {
              gorilla: false,
              dict,
              confirmedMaxId: -1,
            });
            const cap = w.maxBatchSize ?? UNCAPPED_CATCHUP_PACKING_LIMIT;
            if (frame.length > cap) {
              this.recycleConnection(generation);
              await w.close();
              capGapAttempts++;
              if (capGapFirstAt === 0) capGapFirstAt = Date.now();
              if (
                capGapAttempts >= MAX_CATCHUP_CAP_GAP_ATTEMPTS &&
                Date.now() - capGapFirstAt >= capGapDwell
              ) {
                throw new Error(
                  `drainer catch-up exceeds every server cap [size=${frame.length}]`,
                );
              }
              continue; // try the next node / round
            }
            capGapAttempts = 0;
            capGapFirstAt = 0;
            await w.sendBinary(frame);
          }
          if (this.fatalResponse) throw this.fatalResponse;
          if (this.activeConnectionGeneration !== generation || this.ws !== w) {
            continue;
          }
        } catch (e) {
          if (this.activeConnectionGeneration === generation) {
            this.activeConnectionGeneration = 0;
            this.ws = undefined;
          }
          await w?.close().catch(() => undefined);
          if (e instanceof QwpUpgradeError) {
            if (e.kind === "auth") {
              throw new Error(`drainer authentication failed: ${e.message}`);
            }
            this.tracker.record(
              idx,
              e.kind === "role-reject"
                ? HostState.TOPOLOGY_REJECT
                : HostState.TRANSPORT_ERROR,
            );
          } else if (
            e instanceof Error &&
            e.message.startsWith("drainer catch-up exceeds")
          ) {
            throw e;
          } else {
            this.tracker.record(idx, HostState.TRANSPORT_ERROR);
          }
          continue;
        }
      }

      // Send every unacked frame up to the startup snapshot.
      const pending = engine.framesFrom(this.acked + 1);
      for (const f of pending) {
        if (this.stopped) return;
        const ws = this.ws;
        const generation = this.activeConnectionGeneration;
        if (!ws || generation === 0) break;
        // Count the wire attempt before awaiting write completion so an
        // immediate local ACK is correlated against this connection.
        this.acks.onFrameSent();
        try {
          await ws.sendBinary(f);
        } catch {
          // Transport failures are transient for orphan replay. Keep the slot
          // and replay from the unchanged watermark on another connection.
          if (generation === this.activeConnectionGeneration) {
            this.activeConnectionGeneration = 0;
            this.ws = undefined;
          }
          await ws.close().catch(() => undefined);
          break;
        }
        if (generation !== this.activeConnectionGeneration) break;
      }
      // Quiesce: ACKs arrive via onBinary and advance `this.acked`; a drop
      // clears `this.ws` so the loop reconnects and re-sends what's unacked.
      while (!this.stopped && this.acked < target && this.ws) {
        if (this.fatalResponse) throw this.fatalResponse;
        await sleep(POLL_QUIESCE);
      }
    }
  }
}

/**
 * Scans for orphan slots and hands each to a drainer, bounded by
 * `max_background_drainers` concurrent WebSockets. Returns handles so the
 * transport can stop them on close().
 */
export async function startOrphanDrainers(
  options: SenderOptions,
  endpoints: Endpoint[],
  tracker: HostTracker,
  emit: (e: SenderError) => void,
  onStart?: (d: OrphanDrainer) => void,
  shouldStop?: () => boolean,
): Promise<OrphanDrainer[]> {
  const sfDir = options.sf_dir;
  if (!sfDir) return [];
  const max = options.max_background_drainers ?? 4; // spec 9.1
  const orphans = await scanOrphans(sfDir);
  const running = new Set<OrphanDrainer>();
  const all: OrphanDrainer[] = [];
  for (const slot of orphans) {
    if (shouldStop?.()) break;
    // Bound concurrency: wait until a slot frees before starting the next.
    while (running.size >= max && !shouldStop?.()) {
      await Promise.race(
        [...running].map((d) => d.finished.catch(() => undefined)),
      );
    }
    if (shouldStop?.()) break;
    const drainer = new OrphanDrainer(options, endpoints, tracker, slot, emit);
    running.add(drainer);
    all.push(drainer);
    onStart?.(drainer);
    void drainer.finished.then(
      () => running.delete(drainer),
      () => running.delete(drainer),
    );
  }
  return all;
}
