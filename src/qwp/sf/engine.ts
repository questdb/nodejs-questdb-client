import { Buffer } from "node:buffer";
import { open, readFile, readdir, rm } from "node:fs/promises";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { SegmentRing } from "./ring";
import { acquireSlot, releaseSlot, SlotHandle } from "./slotLock";
import { appendFrame, scanSegment, SEGMENT_HEADER_SIZE } from "./segment";
import { writeBoundary, readBoundary, BOUNDARY_FILE_SIZE } from "./boundary";
import {
  writeManifest,
  readManifest,
  MANIFEST_FILE_NAME,
  MANIFEST_FILE_SIZE,
} from "./manifest";
import {
  decodeDictFileState,
  DICT_HEADER,
  encodeChunk,
} from "./symbolDictFile";
import { SymbolDict } from "../protocol/symbolDict";
import { quarantineSlot } from "./quarantine";
import { SenderError, Category, Policy } from "../errors";

export const SEGMENT_EXT = ".sfa";
/** Segment flags bit 0: this file is governed by an sf-manifest.bin (spec 8.1.5). */
export const MANIFEST_REQUIRED_FLAG = 1;
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
  private appendTail: Promise<void> = Promise.resolve();

  // ack watermark state (spec 8.2). Written on a cadence, never per-ACK (C1),
  // and fsynced only in periodic durability.
  private wmBuf = Buffer.alloc(BOUNDARY_FILE_SIZE);
  private wmGen = 0;
  private lastWm = -1n;
  private watermarkDirty = false;
  private barrierTimer?: ReturnType<typeof setInterval>;
  private barrierInFlight = false;

  // sf-manifest.bin state (spec 8.2, 8.1.1): records the chain head so
  // recovery can cross-check the scanned segment chain. Same alternating
  // generation scheme as the ack watermark; written on rotation, never per frame.
  private manBuf = Buffer.alloc(MANIFEST_FILE_SIZE);
  private manifestGen = 0;

  // symbol dictionary file (load-bearing for delta mode; spec 8.1.6)
  private dict = new SymbolDict();
  private dictFd?: number;
  private dictValidBytes = 0;
  private dictDirty = false;
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

  /** The configured total-retention cap (observability/test hook). */
  get maxTotalBytes(): number {
    return this.opts.maxTotalBytes;
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
    // Remove a torn final chunk before appending. Otherwise every later valid
    // chunk remains hidden behind the first invalid tail on every recovery.
    if (!this.dictFresh && fstatSync(this.dictFd).size > this.dictValidBytes) {
      ftruncateSync(this.dictFd, this.dictValidBytes);
    }
    // A fresh (or zero-length) slot has no file header yet: publish it fully.
    if (this.dictFresh) {
      this.writeSyncFully(DICT_HEADER);
      this.dictValidBytes = DICT_HEADER.length;
      this.dictDirty = true;
    }

    // Start the throttled durability barrier. In memory mode it coalesces the
    // page-cache watermark write across ACKs (spec 8.2 consequence 1); in
    // periodic mode it additionally fsyncs the active segment (spec 8.1.5
    // syncPublished semantics).
    const interval =
      this.opts.syncIntervalMillis ?? DEFAULT_SYNC_INTERVAL_MILLIS;
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
    // sf-manifest.bin -> chain-head cross-check (spec 8.1.1, 8.2). The manifest
    // is written only after the new segment's header exists, so on a crash the
    // manifest is never AHEAD of a segment that is already on disk. Equality or
    // a manifest behind the scanned head (the rotation write-order race) is a
    // benign, recoverable state; a manifest strictly ahead of the scanned head
    // means a recorded tail segment vanished from disk = real data loss.
    const manData = await readFile(join(slotDir, MANIFEST_FILE_NAME)).catch(
      () => undefined,
    );
    let manifestHead: number | undefined;
    if (manData && manData.length > 0) {
      manData.copy(this.manBuf);
      const m = readManifest(this.manBuf);
      if (m) {
        manifestHead = m.headBaseSeq;
        this.manifestGen = m.generation + 1;
      }
    }

    // ack watermark (discardable optimisation, guarded by monotonic clamp)
    let recoveredWm: number | undefined;
    try {
      const wmData = await readFile(join(slotDir, ACK_WATERMARK)).catch(
        () => undefined,
      );
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
    const segFiles = entries
      .filter((e) => e.endsWith(SEGMENT_EXT))
      .sort((a, b) => {
        const ai = Number(a.slice(0, -SEGMENT_EXT.length));
        const bi = Number(b.slice(0, -SEGMENT_EXT.length));
        if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
        return a.localeCompare(b);
      });
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
    let manifestRequired = false;
    for (const f of segFiles) {
      const data = await readFile(join(slotDir, f));
      const sr = scanSegment(data);
      chain.push({ baseSeq: sr.baseSeq, frames: sr.frames });
      if (sr.frames.length > 0 && (sr.flags & MANIFEST_REQUIRED_FLAG) !== 0) {
        manifestRequired = true;
      }
    }
    if (manifestRequired && manifestHead === undefined) {
      throw new Error("sf manifest missing or corrupt for governed segments");
    }
    // Cross-check the manifest head against the scanned chain (spec 8.1.1).
    // A valid manifest is only ever written after a new segment header exists,
    // so the manifest is never ahead of an existing file on a benign crash.
    // A manifest ahead of the scanned head therefore means a recorded tail
    // segment (or its entire chain) vanished from disk = real data loss.
    if (manifestHead !== undefined) {
      let head = -1;
      for (const c of chain) if (c.baseSeq > head) head = c.baseSeq;
      if (head < 0 || head < manifestHead) {
        const detail =
          chain.length === 0
            ? "no segments found but the manifest records head " + manifestHead
            : `manifest head ${manifestHead} ahead of scanned chain head ${head}`;
        throw new Error("sf lost-tail detected: " + detail);
      }
    }
    if (chain.length > 0) {
      this.ring = SegmentRing.recovered(chain, {
        segmentBytes: this.opts.segmentBytes,
        maxTotalBytes: this.opts.maxTotalBytes,
      });
      if (recoveredWm !== undefined) this.ring.acknowledge(recoveredWm);
    }

    // symbol dictionary (load-bearing; positions preserved, never de-duped)
    const dictData = await readFile(join(slotDir, SYMBOL_DICT)).catch(
      () => undefined,
    );
    if (dictData && dictData.length > 0) {
      const decoded = decodeDictFileState(dictData);
      for (const e of decoded.entries) this.dict.addRecovered(e);
      this.dictValidBytes = decoded.validBytes;
    } else {
      this.dictValidBytes = 0;
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

  private async writeFully(
    fh: Awaited<ReturnType<typeof open>>,
    data: Buffer,
    position = 0,
  ): Promise<void> {
    let offset = 0;
    while (offset < data.length) {
      const { bytesWritten } = await fh.write(
        data,
        offset,
        data.length - offset,
        position + offset,
      );
      if (bytesWritten <= 0) throw new Error("file write made no progress");
      offset += bytesWritten;
    }
  }

  private writeSyncFully(data: Buffer): void {
    if (this.dictFd === undefined)
      throw new Error("symbol dictionary is not open");
    let offset = 0;
    while (offset < data.length) {
      const written = writeSync(
        this.dictFd,
        data,
        offset,
        data.length - offset,
        undefined,
      );
      if (written <= 0) throw new Error("file write made no progress");
      offset += written;
    }
  }

  private async openForUpdate(path: string) {
    try {
      return await open(path, "r+");
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return open(path, "w+");
    }
  }

  /**
   * Background / close-time durability barrier. Coalesces the ACK watermark
   * write (C1) and, in periodic mode, fsyncs the dictionary before any segment
   * that can reference it.
   */
  private async runBarrier(): Promise<void> {
    // NOT gated on this.closed: close() relies on a final barrier after it has
    // already cleared the timer and set closed, and runBarrier is protected from
    // overlap by barrierInFlight (the timer is cleared before the final call).
    if (!this.isDisk || !this.slot || this.barrierInFlight) return;
    this.barrierInFlight = true;
    try {
      // Periodic covering order: the load-bearing symbol dictionary must reach
      // disk before any segment that references its ids, then the watermark.
      if (this.durability === "periodic" && this.dictDirty) {
        fsyncSync(this.dictFd!);
        this.dictDirty = false;
      }
      if (this.durability === "periodic" && this.fh) await this.fh.sync();
      if (this.watermarkDirty) {
        this.wmGen++;
        writeBoundary(this.wmBuf, this.wmGen, this.lastWm);
        const path = join(this.slot.slotDir, ACK_WATERMARK);
        const fh = await this.openForUpdate(path);
        try {
          await this.writeFully(fh, this.wmBuf);
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
  append(frame: Buffer): Promise<number> {
    if (this.closed)
      return Promise.reject(new Error("store-and-forward engine is closed"));
    const run = this.appendTail.then(() => this.appendOne(frame));
    this.appendTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async appendOne(frame: Buffer): Promise<number> {
    if (!this.isDisk || !this.slot) return this.ring.append(frame);
    const fsn = this.ring.planAppend(frame);
    if (fsn < 0) return fsn;
    // Persistence is the publication boundary in disk mode. A failed write
    // must not leave a replay-visible in-memory FSN behind.
    await this.persistFrame(fsn, frame);
    const committed = this.ring.append(frame);
    if (committed !== fsn) {
      throw new Error(
        `store-and-forward append plan changed [planned=${fsn}, actual=${committed}]`,
      );
    }
    return fsn;
  }

  private async openActiveFile(baseSeq: number): Promise<void> {
    const path = join(this.slot!.slotDir, `${this.fileNo++}${SEGMENT_EXT}`);
    const fh = await open(path, "w+");
    let headerWritten = false;
    try {
      const header = Buffer.alloc(SEGMENT_HEADER_SIZE);
      header.write("SF01", 0, "ascii");
      header.writeUInt8(1, 4);
      header.writeUInt8(MANIFEST_REQUIRED_FLAG, 5); // governed by sf-manifest.bin
      header.writeBigUInt64LE(BigInt(baseSeq), 8);
      await this.writeFully(fh, header);
      headerWritten = true;
      // Record the new chain head AFTER the complete segment header exists.
      await this.persistManifest(baseSeq);
      this.fh = fh;
      this.activeOffset = SEGMENT_HEADER_SIZE;
      this.activeDataBytes = 0;
    } catch (e) {
      await fh.close().catch(() => undefined);
      // A complete empty header is recoverable and may be left behind if the
      // manifest update failed. A partial header can only poison recovery.
      if (!headerWritten)
        await rm(path, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  /** Writes the chain head into sf-manifest.bin, alternating records by generation. */
  private async persistManifest(head: number): Promise<void> {
    if (!this.isDisk || !this.slot) return;
    this.manifestGen++;
    writeManifest(this.manBuf, this.manifestGen, head);
    const path = join(this.slot.slotDir, MANIFEST_FILE_NAME);
    const fh = await this.openForUpdate(path);
    try {
      await this.writeFully(fh, this.manBuf);
      if (this.durability === "periodic") await fh.sync();
    } finally {
      await fh.close();
    }
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
    const oldOffset = this.activeOffset;
    const oldDataBytes = this.activeDataBytes;
    try {
      await this.writeFully(
        this.fh!,
        tmp.subarray(0, newOff),
        this.activeOffset,
      );
      this.activeOffset += newOff;
      this.activeDataBytes += frame.length;
    } catch (e) {
      // Keep a failed/short record out of subsequent scans and allow a retry at
      // the same FSN to reuse the active segment safely.
      await this.fh!.truncate(oldOffset).catch(() => undefined);
      this.activeOffset = oldOffset;
      this.activeDataBytes = oldDataBytes;
      throw e;
    }
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
    if (!this.isDisk || entries.length === 0 || this.dictFd === undefined)
      return;
    const buf = encodeChunk(entries);
    const start = fstatSync(this.dictFd).size;
    try {
      this.writeSyncFully(buf);
      this.dictValidBytes = start + buf.length;
      this.dictDirty = true;
    } catch (e) {
      // A failed loop may already have appended a prefix. Remove it now so a
      // later valid positional chunk is not hidden behind an invalid tail.
      ftruncateSync(this.dictFd, start);
      throw e;
    }
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
    await this.appendTail;
    // Final barrier: persist any un-flushed ACK watermark before the files close.
    await this.runBarrier();
    if (this.fh) await this.fh.close();
    if (this.dictFd !== undefined) closeSync(this.dictFd);
    if (this.slot) await releaseSlot(this.slot);
  }
}
