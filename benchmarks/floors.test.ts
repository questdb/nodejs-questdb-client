import { describe, expect, it } from "vitest";
import {
  floorInternSymbols,
  floorWriteLongs,
  floorWriteStrings,
} from "./floors";

describe("benchmark floors", () => {
  it("writes eight bytes per long", () => {
    const bytes = floorWriteLongs([1n, 2n, 3n]);
    expect(bytes).toHaveLength(24);
    expect(new DataView(bytes.buffer).getBigInt64(8, true)).toBe(2n);
  });

  it("writes UTF-8 values back to back", () => {
    expect(floorWriteStrings(["ab", "cd"]).toString("utf8")).toBe("abcd");
  });

  it("interns symbols to dense IDs", () => {
    expect(floorInternSymbols(["a", "b", "a"])).toEqual([0, 1, 0]);
  });
});
