import { describe, it, expect } from "vitest";
import { QwpBuffer } from "../../src/qwp/buffer";
import { HEADER_SIZE } from "../../src/qwp/protocol/constants";

describe("QwpBuffer", () => {
  it("seals a frame containing the buffered rows", () => {
    const b = new QwpBuffer();
    b.table("trades").symbol("sym", "ETH").floatColumn("price", 1.5);
    b.at(1000n, "us");
    const f = b.toBufferNew()!;
    expect(f.subarray(0, 4).toString("ascii")).toBe("QWP1");
    expect(f.readUInt16LE(6)).toBe(1); // one table
    expect(f.length).toBeGreaterThan(HEADER_SIZE);
  });

  it("returns null when nothing is buffered", () => {
    expect(new QwpBuffer().toBufferNew()).toBeNull();
  });

  it("accumulates multiple tables into one frame", () => {
    const b = new QwpBuffer();
    b.table("a").intColumn("x", 1);
    b.at(1n, "us");
    b.table("b").intColumn("y", 2);
    b.at(2n, "us");
    expect(b.toBufferNew()!.readUInt16LE(6)).toBe(2);
  });

  it("throws for column types this plan does not encode", () => {
    const b = new QwpBuffer();
    b.table("t");
    expect(() => b.booleanColumn("flag", true)).toThrow(/not supported/i);
  });

  it("clears state after sealing", () => {
    const b = new QwpBuffer();
    b.table("t").intColumn("x", 1);
    b.at(1n, "us");
    b.toBufferNew();
    expect(b.toBufferNew()).toBeNull();
  });
});
