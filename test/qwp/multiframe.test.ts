import { describe, it, expect } from "vitest";
import { QwpBuffer } from "../../src/qwp/buffer";

describe("multi-frame sealing", () => {
  it("returns a single frame when the batch fits", () => {
    const b = new QwpBuffer();
    b.table("t").intColumn("x", 1);
    b.at(1n, "us");
    const frames = b.sealFrames(1_000_000);
    expect(frames.length).toBe(1);
    expect(frames[0].subarray(0, 4).toString("ascii")).toBe("QWP1");
  });

  it("returns an empty array when nothing is buffered", () => {
    expect(new QwpBuffer().sealFrames(1_000_000)).toEqual([]);
  });

  it("clears state after sealing", () => {
    const b = new QwpBuffer();
    b.table("t").intColumn("x", 1);
    b.at(1n, "us");
    b.sealFrames(1_000_000);
    expect(b.sealFrames(1_000_000)).toEqual([]);
  });
});
