import { describe, it, expect } from "vitest";
import { QwpBuffer } from "../../src/qwp/buffer";

describe("row rollback", () => {
  it("leaves all columns equal-length after a mid-row throw", () => {
    const b = new QwpBuffer();
    b.table("t").intColumn("a", 1);
    expect(() => b.intColumn("bad", 1.5)).toThrow(); // not an integer
    b.intColumn("a2", 2);
    b.at(1n, "us");
    const frame = b.sealFrames(1_000_000)[0];
    // One row; the frame must encode without a size mismatch, which the
    // encoder asserts internally.
    expect(frame.readUInt16LE(6)).toBe(1);
  });

  it("produces bytes identical to a row that was never started", () => {
    const a = new QwpBuffer();
    a.table("t").intColumn("x", 1);
    a.at(5n, "us");
    const clean = a.sealFrames(1_000_000)[0];

    const c = new QwpBuffer();
    c.table("t");
    expect(() => c.intColumn("x", 0.5)).toThrow();
    c.table("t").intColumn("x", 1);
    c.at(5n, "us");
    expect(c.sealFrames(1_000_000)[0].equals(clean)).toBe(true);
  });

  it("truncates a partially-filled in-progress row on a mid-row throw", () => {
    const expected = (() => {
      const b = new QwpBuffer();
      b.table("t").intColumn("a", 1);
      b.at(5n, "us");
      return b.sealFrames(1_000_000)[0];
    })();

    const b = new QwpBuffer();
    b.table("t").intColumn("a", 1);
    b.at(5n, "us");
    // Start a new row, populate 'a', then throw mid-row before at().
    b.table("t").intColumn("a", 2);
    expect(() => b.intColumn("bad", 1.5)).toThrow();
    // Without rollback, 'a' would carry two compacted values for one row.
    expect(b.sealFrames(1_000_000)[0].equals(expected)).toBe(true);
  });
});
