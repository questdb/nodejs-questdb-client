import { describe, it, expect } from "vitest";
import { encodeFrame } from "../../src/qwp/protocol/frameEncoder";
import { QwpTableBuffer } from "../../src/qwp/protocol/tableBuffer";
import { TYPE_LONG, HEADER_SIZE } from "../../src/qwp/protocol/constants";

describe("encodeFrame", () => {
  it("writes a valid 12-byte header", () => {
    const t = new QwpTableBuffer("t");
    t.getOrCreateColumn("a", TYPE_LONG)!.values.push(7);
    t.nextRow();
    const f = encodeFrame([t]);
    expect(f.subarray(0, 4).toString("ascii")).toBe("QWP1");
    expect(f.readUInt8(4)).toBe(1); // version
    expect(f.readUInt8(5)).toBe(0); // flags: none in this plan
    expect(f.readUInt16LE(6)).toBe(1); // tableCount
    expect(f.readUInt32LE(8)).toBe(f.length - HEADER_SIZE); // payloadLen excludes header
  });

  it("emits nullHeader 0 and compacted values when there are no nulls", () => {
    const t = new QwpTableBuffer("t");
    t.getOrCreateColumn("a", TYPE_LONG)!.values.push(1);
    t.nextRow();
    t.getOrCreateColumn("a", TYPE_LONG)!.values.push(2);
    t.nextRow();
    const f = encodeFrame([t]);
    // ...header, table name "t", rowCount 2, colCount 1, schema "a"+type, then column
    // nullHeader is the byte immediately after the schema entry.
    const idx = f.indexOf(TYPE_LONG, HEADER_SIZE);
    expect(f.readUInt8(idx + 1)).toBe(0); // nullHeader = no nulls
    expect(f.readBigInt64LE(idx + 2)).toBe(1n);
    expect(f.readBigInt64LE(idx + 10)).toBe(2n);
  });

  it("emits nullHeader 1, an LSB-first bitmap, and only non-null values", () => {
    const t = new QwpTableBuffer("t");
    t.getOrCreateColumn("a", TYPE_LONG)!.values.push(1);
    t.nextRow();
    t.nextRow(); // row 1: "a" not set -> null
    const f = encodeFrame([t]);
    const idx = f.indexOf(TYPE_LONG, HEADER_SIZE);
    expect(f.readUInt8(idx + 1)).toBe(1); // bitmap present
    expect(f.readUInt8(idx + 2)).toBe(0b00000010); // bit 1 set -> row 1 is NULL
    expect(f.readBigInt64LE(idx + 3)).toBe(1n); // only ONE value, not two
    expect(f.length).toBe(idx + 3 + 8);
  });
});
