import { Buffer } from "node:buffer";

export const BACKPRESSURE_NO_SPARE = -1;
export const PAYLOAD_TOO_LARGE = -2;

interface Seg {
  baseSeq: number;
  frames: Buffer[];
  bytes: number;
}

export interface RingOptions {
  segmentBytes: number;
  maxTotalBytes: number;
}

export class SegmentRing {
  private segs: Seg[] = [];
  private nextSeq = 0;
  private acked = -1;

  constructor(private readonly opts: RingOptions) {
    this.segs.push({ baseSeq: 0, frames: [], bytes: 0 });
  }

  /** FSNs derive from the chain, so a recovered ring continues numbering. */
  static recovered(
    chain: { baseSeq: number; frames: Buffer[] }[],
    opts: RingOptions,
  ): SegmentRing {
    const r = new SegmentRing(opts);
    r.segs = chain.map((c) => ({
      baseSeq: c.baseSeq,
      frames: c.frames,
      bytes: c.frames.reduce((a, f) => a + f.length, 0),
    }));
    r.segs.sort((a, b) => a.baseSeq - b.baseSeq);
    for (let i = 1; i < r.segs.length; i++) {
      const prev = r.segs[i - 1];
      if (prev.baseSeq + prev.frames.length !== r.segs[i].baseSeq) {
        throw new Error("segment chain is not contiguous");
      }
    }
    for (const s of r.segs) {
      if (s.baseSeq < 0) throw new Error("segment with negative baseSeq must be quarantined");
    }
    const last = r.segs[r.segs.length - 1];
    r.nextSeq = last.baseSeq + last.frames.length;
    return r;
  }

  get publishedFsn(): number {
    return this.nextSeq - 1;
  }

  get ackedFsn(): number {
    return this.acked;
  }

  get totalBytes(): number {
    return this.segs.reduce((a, s) => a + s.bytes, 0);
  }

  /** Returns the assigned FSN, or a negative sentinel. */
  append(frame: Buffer): number {
    if (frame.length > this.opts.segmentBytes) return PAYLOAD_TOO_LARGE;
    const active = this.segs[this.segs.length - 1];
    if (active.bytes + frame.length > this.opts.segmentBytes) {
      if (this.totalBytes + frame.length > this.livenessFloorAdjustedCap()) {
        return BACKPRESSURE_NO_SPARE;
      }
      this.segs.push({ baseSeq: this.nextSeq, frames: [], bytes: 0 });
    }
    const seg = this.segs[this.segs.length - 1];
    seg.frames.push(frame);
    seg.bytes += frame.length;
    return this.nextSeq++;
  }

  /**
   * Never refuse below the minimum working set. Segment bytes are reclaimable
   * by ACK-driven trim, but side files are lifetime-monotonic, so refusing on
   * the raw total can wedge the producer permanently (spec 8.1.3).
   */
  private livenessFloorAdjustedCap(): number {
    return Math.max(this.opts.maxTotalBytes, 2 * this.opts.segmentBytes);
  }

  acknowledge(fsn: number): void {
    if (fsn > this.acked) this.acked = fsn;
    while (this.segs.length > 1) {
      const head = this.segs[0];
      if (head.baseSeq + head.frames.length - 1 > this.acked) break;
      this.segs.shift();
    }
  }

  framesFrom(fsn: number): Buffer[] {
    const out: Buffer[] = [];
    for (const s of this.segs) {
      s.frames.forEach((f, i) => {
        if (s.baseSeq + i >= fsn) out.push(f);
      });
    }
    return out;
  }
}
