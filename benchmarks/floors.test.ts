import { describe, it, expect } from "vitest";
import { floorWriteLongs, floorWriteStrings, floorInternSymbols } from "./floors";

describe("floors", () => {
  it("writes 8 bytes per long", () => {
    const b = floorWriteLongs([1n, 2n, 3n]);
    expect(b.length).toBe(24);
    expect(b.readBigInt64LE(8)).toBe(2n);
  });

  it("writes utf8 back to back", () => {
    expect(floorWriteStrings(["ab", "cd"]).toString("utf8")).toBe("abcd");
  });

  it("interns to dense ids", () => {
    expect(floorInternSymbols(["a", "b", "a"])).toEqual([0, 1, 0]);
  });
});
