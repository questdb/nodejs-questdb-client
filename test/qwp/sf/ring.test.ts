import { describe, it, expect } from "vitest";
import { SegmentRing, BACKPRESSURE_NO_SPARE, PAYLOAD_TOO_LARGE } from "../../../src/qwp/sf/ring";

describe("SegmentRing", () => {
  it("assigns FSNs from 0 on a fresh ring", () => {
    const r = new SegmentRing({ segmentBytes: 4096, maxTotalBytes: 1 << 20 });
    expect(r.publishedFsn).toBe(-1);
    expect(r.append(Buffer.from("a"))).toBe(0);
    expect(r.append(Buffer.from("b"))).toBe(1);
    expect(r.publishedFsn).toBe(1);
  });

  it("continues numbering when recovered from existing segments", () => {
    const r = SegmentRing.recovered([{ baseSeq: 10, frames: [Buffer.from("x"), Buffer.from("y")] }], {
      segmentBytes: 4096,
      maxTotalBytes: 1 << 20,
    });
    expect(r.publishedFsn).toBe(11);
    expect(r.append(Buffer.from("z"))).toBe(12);
  });

  it("returns PAYLOAD_TOO_LARGE for a frame that cannot fit a fresh segment", () => {
    const r = new SegmentRing({ segmentBytes: 64, maxTotalBytes: 1 << 20 });
    expect(r.append(Buffer.alloc(1000))).toBe(PAYLOAD_TOO_LARGE);
  });

  it("trims acked segments and frees space", () => {
    const r = new SegmentRing({ segmentBytes: 64, maxTotalBytes: 256 });
    const fsns = [0, 1, 2].map(() => r.append(Buffer.alloc(20)));
    r.acknowledge(fsns[2]);
    expect(r.ackedFsn).toBe(fsns[2]);
    expect(r.totalBytes).toBeLessThan(256);
  });

  it("returns the frames to replay from ackedFsn + 1", () => {
    const r = new SegmentRing({ segmentBytes: 4096, maxTotalBytes: 1 << 20 });
    r.append(Buffer.from("a"));
    r.append(Buffer.from("b"));
    r.append(Buffer.from("c"));
    r.acknowledge(0);
    expect(r.framesFrom(r.ackedFsn + 1).map((f) => f.toString())).toEqual(["b", "c"]);
  });
});
