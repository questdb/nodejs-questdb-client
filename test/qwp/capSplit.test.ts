import { describe, it, expect } from "vitest";
import { QwpBuffer } from "../../src/qwp/buffer";
import { encodeCommitFrame } from "../../src/qwp/protocol/frameEncoder";
import { SymbolDict } from "../../src/qwp/protocol/symbolDict";
import { FLAG_DEFER_COMMIT } from "../../src/qwp/protocol/constants";

describe("cap splitting", () => {
  it("splits per table when the batch exceeds the cap", () => {
    const b = new QwpBuffer();
    for (const t of ["a", "b", "c"]) {
      b.table(t).intColumn("x", 1);
      b.at(1n, "us");
    }
    const frames = b.sealFrames(80); // small cap forces a split
    expect(frames.length).toBe(3);
    // All but the last defer the commit.
    expect(frames[0].readUInt8(5) & FLAG_DEFER_COMMIT).toBe(FLAG_DEFER_COMMIT);
    expect(frames[1].readUInt8(5) & FLAG_DEFER_COMMIT).toBe(FLAG_DEFER_COMMIT);
    expect(frames[2].readUInt8(5) & FLAG_DEFER_COMMIT).toBe(0);
  });

  it("throws before publishing when one table cannot fit any split", () => {
    const b = new QwpBuffer();
    b.table("wide").stringColumn("s", "x".repeat(500));
    b.at(1n, "us");
    expect(() => b.sealFrames(50)).toThrow(/cannot fit/i);
  });

  it("builds a commit frame with no tables and an empty delta", () => {
    const dict = new SymbolDict();
    dict.getOrAdd("a");
    const f = encodeCommitFrame(dict, 0);
    expect(f.readUInt16LE(6)).toBe(0); // tableCount
    expect(f.readUInt8(5) & FLAG_DEFER_COMMIT).toBe(0);
  });
});
