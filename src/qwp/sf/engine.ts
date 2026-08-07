import { Buffer } from "node:buffer";
import { open, readFile, readdir } from "node:fs/promises";
import { openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { SegmentRing } from "./ring";
import { acquireSlot, releaseSlot, SlotHandle } from "./slotLock";
import { appendFrame, scanSegment, SEGMENT_HEADER_SIZE } from "./segment";
import { writeBoundary, readBoundary, BOUNDARY_FILE_SIZE } from "./boundary";
import { encodeChunk, decodeDictFile, DICT_HEADER } from "./symbolDictFile";
import { SymbolDict } from "../protocol/symbolDict";
import { quarantineSlot } from "./quarantine";
import { SenderError, Category, Policy } from "../errors";

export const SEGMENT_EXT = ".sfa";
const ACK_WATERMARK = ".ack-watermark";
const SYMBOL_DICT = ".symbol-dict";
const DEFAULT_SYNC_INTERVAL_MILLIS = 5000; // spec 9.1

export interface EngineOptions {
  segmentBytes: number;
  maxTotalBytes: number;
  sfDir?: string;
  senderId: string;
  /** spec 8.2: page-cache only (default) vs a periodic background barrier. */
  durability?: "memory" | "periodic";
  /** Target cadence for the periodic barrier (spec 9.1 default 5000). */
  syncIntervalMillis?: number;
}

/**
 * Ties the FSN ring and the crash-safe on-disk state (segments, ack watermark,
 * symbol dictionary) together. With `sfDir` set the engine writes every
 * published frame to a segment file; without it (memory mode) it is just the
 * ring, and a process crash loses everything as usual (spec 8, 9.2).
 */
export class SfEngine {
  private ring: SegmentRing;
  private slot?: SlotHandle;
  private fh?: Awaited<ReturnType<typeof open>>;
  private fileNo = 0;
  private activeOffset = 0;
  private activeDataBytes = 0;
  private closed = false;

  // ack watermark state (spec 8.2). Written on a cadence, never per-ACK (C1),
  // and fsynced only in periodic durability.
  private wmBuf = Buffer.alloc(BOUNDARY_FILE_SIZE);
  private wmGen = 0;
  private lastWm = -1n;
  private watermarkDirty = false;
  private barrierTimer?: ReturnType<typeof setInterval>;
  private barrierInFlight = false;

  // symbol dictionary file (load-bearing for delta mode; spec 8.1.6)
  private dict = new SymbolDict();
  private dictFd?: number;
  /** True when the slot had no (or an empty) symbol-dict file on open. */
  private dictFresh = false;

  constructor(private readonly opts: EngineOptions) {
    this.ring = new SegmentRing({
      segmentBytes: opts.segmentBytes,
      maxTotalBytes: opts.maxTotalBytes,
    });
  }

  get isDisk(): boolean {
    return this.opts.sfDir !== undefined;
  }

  get ackedFsn(): number {
    return this.ring.ackedFsn;
  }

  get publishedFsn(): number {
    return this.ring.publishedFsn;
  }

  /** The recovered symbol dictionary, for catch-up re-registration (spec 7.5). */
  get symbolDict(): SymbolDict {
    return this.dict;
  }

  get durability(): "memory" | "periodic" {
    return this.opts.durability ?? "memory";
  }

  async open(): Promise<void> {
    if (!this.isDisk) return;
    const { sfDir, senderId } = this.opts;
    this.slot = await acquireSlot(sfDir, senderId);
    // A slot that cannot be recovered is set aside (rename + .failed sentinel)
    // and surfaced as DATA_LOSS/ABANDONED rather than failing the sender with
    // an unlabelled error (spec 8.4). This covers both a corrupt segment chain
    // and a corrupt, load-bearing symbol dictionary (spec 8.1.6).
    try {
      await this.recover(this.slot.slotDir);
    } catch (e) {
      await this.failQuarantined(sfDir, senderId, e);
    }
    this.dictFd = openSync(join(this.slot.slotDir, SYMBOL_DICT), "a");
    // A fresh (or zero-length) slot has no file header yet: write the SYD1
    // header before any chunk so recovery can parse it (spec 8.1.6). An append
    // write lands at EOF, which is offset 0 on an empty file.
    if (this.dictFresh) {
      writeSync(this.dictFd, DICT_HEADER, 0, DICT_HEADER.length, undefined);
    }

    // Start the throttled durability barrier. In memory mode it coalesces the
    // page-cache watermark write across ACKs (spec 8.2 consequence 1); in
    // periodic mode it additionally fsyncs the active segment (spec 8.1.5
    // syncPublished semantics).
    const interval = this.opts.syncIntervalMillis ?? DEFAULT_SYNC_INTERVAL_MILLIS;
    if (interval > 0) {
      this.barrierTimer = setInterval(() => void this.runBarrier(), interval);
      this.barrierTimer.unref?.();
    }
  }

  /**
   * Read-only recovery for orphan drainers, which already hold the slot lock and
   * must never write (spec 8.4). Populates the recovered ring and symbol
   * dictionary without taking a lock, opening write descriptors, or starting the
   * durability barrier. Throws on a slot that cannot be recovered.
   */
  static async openReadOnly(
    opts: EngineOptions,
    sfDir: string,
    senderId: string,
  ): Promise<SfEngine> {
    const e = new SfEngine({
      ...opts,
      sfDir: undefined, // never let a read-only view think it can write
      durability: "memory",
      syncIntervalMillis: 0,
    });
    await e.recover(join(sfDir, senderId));
    return e;
  }

  /**
   * Shared recovery: reads the ack watermark, the contiguous segment chain into
   * the ring, and the loaded symbol dictionary. Throws on a slot that cannot be
   * recovered (corrupt chain, bad magic, broken dictionary); the caller decides
   * whether to quarantine (owner) or drop a .failed sentinel (drainer).
   */
  private async recover(slotDir: string): Promise<void> {
    // ack watermark (discardable optimisation, guarded by monotonic clamp)
    let recoveredWm: number | undefined;
    try {
      const wmData = await readFile(join(slotDir, ACK_WATERMARK)).catch(() => undefined);
      if (wmData && wmData.length > 0) {
        wmData.copy(this.wmBuf);
        const b = readBoundary(this.wmBuf);
        if (b) recoveredWm = Number(b.value);
      }
    } catch {
      /* fall back to the segment-derived seed (spec 8.2) */
    }

    // segments -> contiguous FSN chain
    const entries = await readdir(slotDir).catch(() => []);
    const segFiles = entries.filter((e) => e.endsWith(SEGMENT_EXT)).sort();
    // Resume the file counter PAST any existing segment so continued appends
    // open fresh files rather than truncating a recovered one that may still
    // hold unacked frames (spec 8.1.5).
    let maxIdx = -1;
    for (const f of segFiles) {
      const n = Number(f.slice(0, -SEGMENT_EXT.length));
      if (Number.isFinite(n) && n > maxIdx) maxIdx = n;
    }
    this.fileNo = maxIdx + 1;
    const chain: { baseSeq: number; frames: Buffer[] }[] = [];
    for (const f of segFiles) {
      const data = await readFile(join(slotDir, f));
      const sr = scanSegment(data);
      chain.push({ baseSeq: sr.baseSeq, frames: sr.frames });
    }
    if (chain.length > 0) {
      this.ring = SegmentRing.recovered(chain, {
        segmentBytes: this.opts.segmentBytes,
        maxTotalBytes: this.opts.maxTotalBytes,
      });
      if (recoveredWm !== undefined) this.ring.acknowledge(recoveredWm);
    }

    // symbol dictionary (load-bearing; positions preserved, never de-duped)
    const dictData = await readFile(join(slotDir, SYMBOL_DICT)).catch(() => undefined);
    if (dictData && dictData.length > 0) {
      for (const e of decodeDictFile(dictData)) this.dict.addRecovered(e);
    }
    this.dictFresh = !dictData || dictData.length === 0;
  }

  /**
   * Releases the slot lock, quarantines the corrupt slot, and throws a
   * DATA_LOSS/ABANDONED SenderError carrying the quarantined path (spec 8.4).
   */
  private async failQuarantined(
    sfDir: string,
    senderId: string,
    cause: unknown,
  ): Promise<never> {
    const slot = this.slot!;
    this.slot = undefined;
    await releaseSlot(slot);
    let quarantinedPath: string | undefined;
    try {
      quarantinedPath = await quarantineSlot(sfDir, senderId, slot.slotDir);
    } catch {
      // The cap refused the rename; keep the original path as context.
      quarantinedPath = slot.slotDir;
    }
    const detail = (cause as Error)?.message ?? String(cause);
    throw new SenderError(
      Category.DATA_LOSS,
      Policy.ABANDONED,
      `sf slot '${senderId}' could not be recovered and was quarantined: ${detail}`,
      -1,
      -1,
      -1,
      quarantinedPath,
    );
  }

  /**
   * Background / close-time durability barrier. Coalesces the ACK watermark
   * write (C1) and, in periodic mode, fsyncs the active segment.
   */
  private async runBarrier(): Promise<void> {
    // NOT gated on this.closed: close() relies on a final barrier after it has
    // already cleared the timer and set closed, and runBarrier is protected from
    // overlap by barrierInFlight (the timer is cleared before the final call).
    if (!this.isDisk || !this.slot || this.barrierInFlight) return;
    this.barrierInFlight = true;
    try {
      // Periodic covering order: make the active segment durable first, then
      // the watermark that guards it (spec 8.1.5, 8.2).
      if (this.durability === "periodic" && this.fh) {
        await this.fh.sync();
      }
      if (this.watermarkDirty) {
        this.wmGen++;
        writeBoundary(this.wmBuf, this.wmGen, this.lastWm);
        const path = join(this.slot.slotDir, ACK_WATERMARK);
        const fh = await open(path, "w");
        try {
          await fh.write(this.wmBuf);
          if (this.durability === "periodic") await fh.sync();
        } finally {
          await fh.close();
        }
        this.watermarkDirty = false;
      }
      // Note: Node exposes no directory fsync, so the slot-dir covering fsync
      // of spec 8.2 has no portable Node analogue; the file fsyncs above are
      // the load-bearing part.
    } catch {
      // Durability is best-effort on a failing filesystem; leave the dirty flag
      // set so the next barrier retries.
    } finally {
      this.barrierInFlight = false;
    }
  }

  /**
   * Publishes a frame, returning its FSN or a negative sentinel. In disk mode
   * the frame is written ahead to a segment file before returning.
   */
  async append(frame: Buffer): Promise<number> {
    const fsn = this.ring.append(frame);
    if (fsn < 0) return fsn;
    if (this.isDisk && this.slot) await this.persistFrame(fsn, frame);
    return fsn;
  }

  private async openActiveFile(baseSeq: number): Promise<void> {
    const path = join(this.slot!.slotDir, `${this.fileNo++}${SEGMENT_EXT}`);
    this.fh = await open(path, "w+");
    const header = Buffer.alloc(SEGMENT_HEADER_SIZE);
    header.write("SF01", 0, "ascii");
    header.writeUInt8(1, 4);
    header.writeBigUInt64LE(BigInt(baseSeq), 8);
    await this.fh.write(header, 0, SEGMENT_HEADER_SIZE, 0);
    this.activeOffset = SEGMENT_HEADER_SIZE;
    this.activeDataBytes = 0;
  }

  private async persistFrame(fsn: number, frame: Buffer): Promise<void> {
    if (!this.fh) await this.openActiveFile(fsn);
    if (this.activeDataBytes + frame.length > this.opts.segmentBytes) {
      await this.fh.close();
      this.fh = undefined;
      await this.openActiveFile(fsn);
    }
    // Frame = u32 crc32c(payloadLen ++ payload) | u32 payloadLen | payload (spec 8.1.5)
    const tmp = Buffer.alloc(8 + frame.length);
    const newOff = appendFrame(tmp, 0, frame);
    await this.fh!.write(tmp.subarray(0, newOff), 0, newOff, this.activeOffset);
    this.activeOffset += newOff;
    this.activeDataBytes += frame.length;
  }

  acknowledge(fsn: number): void {
    this.ring.acknowledge(fsn);
    if (this.isDisk && this.slot && fsn >= 0 && BigInt(fsn) > this.lastWm) {
      // Memory durability is a page-cache write coalesced onto the barrier
      // cadence, never a per-ACK syscall (spec 8.2 consequence 1).
      this.lastWm = BigInt(fsn);
      this.watermarkDirty = true;
    }
  }

  /**
   * Write-ahead persist a batch of newly introduced symbols before the frame
   * carrying them is published (spec 8.1.6). Synchronous because the buffer's
   * persist hook is sync and must complete before the frame goes on the wire.
   *
   * Wired end-to-end by the Sender: `QwpTransport.attachSymbolBuffer` installs
   * this as the buffer's persist hook, so delta mode is live in memory mode and
   * (once `.symbol-dict` has opened) in disk mode. The engine writes the SYD1
   * header on a fresh slot, then one chunk per frame; recovery re-reads it
   * positionally (spec 8.1.6, handoff B1).
   */
  persistSymbols(entries: string[]): void {
    if (!this.isDisk || entries.length === 0 || this.dictFd === undefined) return;
    const buf = encodeChunk(entries);
    writeSync(this.dictFd, buf, 0, buf.length, undefined);
  }

  framesFrom(fsn: number): Buffer[] {
    return this.ring.framesFrom(fsn);
  }

  /** Drops the bytes that survive the current ring so a fresh open re-scans. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.barrierTimer) {
      clearInterval(this.barrierTimer);
      this.barrierTimer = undefined;
    }
    // Final barrier: persist any un-flushed ACK watermark before the files close.
    await this.runBarrier();
    if (this.fh) await this.fh.close();
    if (this.dictFd !== undefined) closeSync(this.dictFd);
    if (this.slot) await releaseSlot(this.slot);
  }
}
