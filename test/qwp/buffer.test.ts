import { describe, it, expect } from "vitest";
import { QwpBuffer } from "../../src/qwp/buffer";
import { HEADER_SIZE, TYPE_LONG, TYPE_TIMESTAMP } from "../../src/qwp/protocol/constants";

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

  it("writes the designated timestamp as an empty-name TIMESTAMP column", () => {
    // QwpSchema allows nameLen=0 for the designated timestamp; the server names
    // it "timestamp". A column literally named "timestamp" collides with the
    // server's reserved designated column, so it must NOT be emitted.
    const b = new QwpBuffer();
    b.table("t").intColumn("x", 1);
    b.at(1_700_000_000_000_000n, "us");
    const f = b.toBufferNew()!;
    let o = HEADER_SIZE;
    o += f[o] + 1; // table name "t" (varint len + bytes)
    o += 1; // rowCount
    const cc = f[o++];
    expect(cc).toBe(2);
    const nx = f[o++];
    o += nx;
    expect(f[o++]).toBe(TYPE_LONG); // "x"
    expect(f[o++]).toBe(0); // empty column name length -> designated timestamp
    expect(f[o++]).toBe(TYPE_TIMESTAMP);
  });
});
