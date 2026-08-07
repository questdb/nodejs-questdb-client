import { describe, it, expect } from "vitest";
import { columnPayloadSize, writeColumn } from "../../src/qwp/protocol/columnWriter";
import { TYPE_BOOLEAN, TYPE_INT, TYPE_FLOAT } from "../../src/qwp/protocol/constants";

const opts = { gorilla: false };

function encode(col: any, rowCount: number): Buffer {
  const size = columnPayloadSize(col, rowCount, opts);
  const b = Buffer.alloc(size);
  const end = writeColumn(b, 0, col, rowCount, opts);
  expect(end).toBe(size);
  return b;
}

describe("column writers", () => {
  it("bit-packs BOOLEAN LSB-first over non-null values", () => {
    const col = { name: "b", type: TYPE_BOOLEAN, values: [true, false, true], nulls: [false, false, false], size: 3 };
    const b = encode(col, 3);
    expect(b[0]).toBe(0); // nullHeader
    expect(b[1]).toBe(0b00000101); // bits 0 and 2
    expect(b.length).toBe(2);
  });

  it("writes INT as 4 bytes LE", () => {
    const col = { name: "i", type: TYPE_INT, values: [258], nulls: [false], size: 1 };
    const b = encode(col, 1);
    expect(b.readInt32LE(1)).toBe(258);
  });

  it("writes FLOAT as 4 bytes IEEE754", () => {
    const col = { name: "f", type: TYPE_FLOAT, values: [1.5], nulls: [false], size: 1 };
    const b = encode(col, 1);
    expect(b.readFloatLE(1)).toBeCloseTo(1.5, 6);
  });
});
