import { describe, it, expect } from "vitest";
import { writeVarint, varintSize, readVarint } from "../../src/qwp/protocol/varint";

describe("varint (unsigned LEB128)", () => {
  it("encodes single-byte values", () => {
    const b = Buffer.alloc(4);
    expect(writeVarint(b, 0, 0)).toBe(1);
    expect(b[0]).toBe(0x00);
    expect(writeVarint(b, 0, 127)).toBe(1);
    expect(b[0]).toBe(0x7f);
  });

  it("encodes multi-byte values with the continuation bit", () => {
    const b = Buffer.alloc(4);
    const end = writeVarint(b, 0, 128);
    expect(end).toBe(2);
    expect(b[0]).toBe(0x80);
    expect(b[1]).toBe(0x01);
  });

  it("round-trips a range of values", () => {
    for (const v of [0, 1, 127, 128, 300, 16383, 16384, 1_000_000]) {
      const b = Buffer.alloc(10);
      const end = writeVarint(b, 0, v);
      expect(end).toBe(varintSize(v));
      expect(readVarint(b, 0)).toEqual({ value: v, offset: end });
    }
  });
});
