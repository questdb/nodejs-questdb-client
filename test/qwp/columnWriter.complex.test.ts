import { describe, it, expect } from "vitest";
import { QwpTableBuffer } from "../../src/qwp/protocol/tableBuffer";
import { TYPE_GEOHASH, TYPE_DOUBLE_ARRAY } from "../../src/qwp/protocol/constants";
import { columnPayloadSize, writeColumn, flattenArray } from "../../src/qwp/protocol/columnWriter";

describe("complex column rules", () => {
  it("locks geohash precision on the first value", () => {
    const t = new QwpTableBuffer("t");
    const c = t.getOrCreateColumn("g", TYPE_GEOHASH)!;
    t.setGeoHashPrecision(c, 20);
    expect(() => t.setGeoHashPrecision(c, 25)).toThrow(/precision mismatch/i);
  });

  it("rejects an out-of-range geohash precision", () => {
    const t = new QwpTableBuffer("t");
    const c = t.getOrCreateColumn("g", TYPE_GEOHASH)!;
    expect(() => t.setGeoHashPrecision(c, 61)).toThrow(/1-60/);
  });

  it("writes a double array as per-value shape then values", () => {
    const col = {
      name: "m", type: TYPE_DOUBLE_ARRAY,
      values: [{ dims: [2], data: [1.5, 2.5] }],
      nulls: [false], size: 1,
    };
    const opts = { gorilla: false };
    const size = columnPayloadSize(col as any, 1, opts);
    const b = Buffer.alloc(size);
    expect(writeColumn(b, 0, col as any, 1, opts)).toBe(size);
    expect(b[1]).toBe(1); // nDims
    expect(b.readUInt32LE(2)).toBe(2); // dim length
    expect(b.readDoubleLE(6)).toBeCloseTo(1.5);
    expect(b.readDoubleLE(14)).toBeCloseTo(2.5);
  });

  it("rejects a jagged array", () => {
    expect(() => flattenArray([[1, 2], [3]])).toThrow(/irregular array shape/i);
  });
});
