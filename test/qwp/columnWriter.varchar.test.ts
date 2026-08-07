import { describe, it, expect } from "vitest";
import { columnPayloadSize, writeColumn } from "../../src/qwp/protocol/columnWriter";
import { TYPE_VARCHAR } from "../../src/qwp/protocol/constants";

describe("VARCHAR", () => {
  it("writes V+1 offsets then concatenated utf8", () => {
    const col = { name: "s", type: TYPE_VARCHAR, values: ["ab", "cde"], nulls: [false, false], size: 2 };
    const opts = { gorilla: false };
    const size = columnPayloadSize(col as any, 2, opts);
    const b = Buffer.alloc(size);
    expect(writeColumn(b, 0, col as any, 2, opts)).toBe(size);
    expect(b[0]).toBe(0); // nullHeader
    expect(b.readUInt32LE(1)).toBe(0);
    expect(b.readUInt32LE(5)).toBe(2);
    expect(b.readUInt32LE(9)).toBe(5);
    expect(b.subarray(13).toString("utf8")).toBe("abcde");
  });
});
