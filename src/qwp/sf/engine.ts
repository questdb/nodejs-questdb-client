import { Buffer } from "node:buffer";
import { open, readFile, writeFile, readdir } from "node:fs/promises";
import { writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { SegmentRing } from "./ring";
import { acquireSlot, releaseSlot, SlotHandle } from "./slotLock";
import { appendFrame, scanSegment, SEGMENT_HEADER_SIZE } from "./segment";
import { writeBoundary, readBoundary, BOUNDARY_FILE_SIZE } from "./boundary";
import { encodeChunk, decodeDictFile } from "./symbolDictFile";
import { SymbolDict } from "../protocol/symbolDict";

export const SEGMENT_EXT = ".sfa";
const ACK_WATERMARK = ".ack-watermark";
const SYMBOL_DICT = ".symbol-dict";

export interface EngineOptions {
  segmentBytes: number;
  maxTotalBytes: number;
  sfDir?: string;
  senderId: string;
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

  // ack watermark state
  private wmBuf = Buffer.alloc(BOUNDARY_FILE_SIZE);
  private wmGen = 0;
  private lastWm = -1n;

  // symbol dictionary file (load-bearing for delta mode; spec 8.1.6)
  private dict = new SymbolDict();
  private dictFd?: number;

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

  async open(): Promise<void> {
    if (!this.isDisk) return;
    const { sfDir, senderId } = this.opts;
    this.slot = await acquireSlot(sfDir, senderId);

    // ack watermark (discardable optimisation, guarded by monotonic clamp)
    let recoveredWm: number | undefined;
    try {
      const wmData = await readFile(join(this.slot.slotDir, ACK_WATERMARK)).catch(() => undefined);
      if (wmData && wmData.length > 0) {
        wmData.copy(this.wmBuf);
        const b = readBoundary(this.wmBuf);
        if (b) recoveredWm = Number(b.value);
      }
    } catch {
      /* fall back to the segment-derived seed (spec 8.2) */
    }

    // segments -> contiguous FSN chain
    const entries = await readdir(this.slot.slotDir).catch(() => []);
    const segFiles = entries.filter((e) => e.endsWith(SEGMENT_EXT)).sort();
    const chain: { baseSeq: number; frames: Buffer[] }[] = [];
    for (const f of segFiles) {
      const data = await readFile(join(this.slot.slotDir, f));
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
    const dictData = await readFile(join(this.slot.slotDir, SYMBOL_DICT)).catch(() => undefined);
    if (dictData && dictData.length > 0) {
      for (const e of decodeDictFile(dictData)) this.dict.addRecovered(e);
    }
    this.dictFd = (await open(join(this.slot.slotDir, SYMBOL_DICT), "a")).fd;
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
      // memory durability: page-cache write, no explicit fsync (spec 8.2).
      this.lastWm = BigInt(fsn);
      this.wmGen++;
      writeBoundary(this.wmBuf, this.wmGen, this.lastWm);
      writeFile(join(this.slot.slotDir, ACK_WATERMARK), this.wmBuf).catch(() => undefined);
    }
  }

  /**
   * Write-ahead persist a batch of newly introduced symbols before the frame
   * carrying them is published (spec 8.1.6). Synchronous because the buffer's
   * persist hook is sync and must complete before the frame goes on the wire.
   */
  persistSymbols(entries: string[]): void {
    if (!this.isDisk || entries.length === 0 || this.dictFd === undefined) return;
    const buf = Buffer.concat([encodeChunk(entries)]);
    writeSync(this.dictFd, buf, 0, buf.length, undefined);
  }

  framesFrom(fsn: number): Buffer[] {
    return this.ring.framesFrom(fsn);
  }

  /** Drops the bytes that survive the current ring so a fresh open re-scans. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.fh) await this.fh.close();
    if (this.dictFd !== undefined) closeSync(this.dictFd);
    if (this.slot) await releaseSlot(this.slot);
  }
}
