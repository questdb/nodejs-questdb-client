import { describe, it, expect } from "vitest";
import { buildSegment, scanSegment, SEGMENT_HEADER_SIZE } from "../../../src/qwp/sf/segment";

function seg(baseSeq: number, frames: Buffer[]): Buffer {
  return buildSegment(baseSeq, frames, 4096);
}

describe("segment", () => {
  it("writes an SF01 header carrying baseSeq", () => {
    const b = seg(42, [Buffer.from("aa")]);
    expect(b.subarray(0, 4).toString("ascii")).toBe("SF01");
    expect(b.readUInt8(4)).toBe(1);
    expect(Number(b.readBigUInt64LE(8))).toBe(42);
  });

  it("scans back the frames it wrote", () => {
    const r = scanSegment(seg(0, [Buffer.from("aa"), Buffer.from("bbb")]));
    expect(r.frames.map((f) => f.toString())).toEqual(["aa", "bbb"]);
    expect(r.tornTailBytes).toBe(0);
  });

  it("stops at a bad CRC and reports a torn tail", () => {
    const b = seg(0, [Buffer.from("aa"), Buffer.from("bbb")]);
    b[SEGMENT_HEADER_SIZE + 8 + 2 + 0] ^= 0xff; // corrupt the second frame's payload
    const r = scanSegment(b);
    expect(r.frames.length).toBe(1);
    expect(r.tornTailBytes).toBeGreaterThan(0);
  });

  it("distinguishes a clean partial fill from a torn tail", () => {
    const b = seg(0, [Buffer.from("aa")]);
    // trailing bytes are already zero -> clean fill, not a tear
    expect(scanSegment(b).tornTailBytes).toBe(0);
  });

  it("stops when a declared length overruns the file", () => {
    const b = seg(0, [Buffer.from("aa")]);
    b.writeUInt32LE(9_000_000, SEGMENT_HEADER_SIZE + 4);
    expect(scanSegment(b).frames.length).toBe(0);
  });
});
