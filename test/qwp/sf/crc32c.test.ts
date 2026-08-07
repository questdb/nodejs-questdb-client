import { describe, it, expect } from "vitest";
import { crc32c } from "../../../src/qwp/sf/crc32c";

describe("crc32c (Castagnoli)", () => {
  it("matches the published check value for '123456789'", () => {
    expect(crc32c(Buffer.from("123456789", "ascii")) >>> 0).toBe(0xe3069283);
  });

  it("returns 0 for an empty buffer", () => {
    expect(crc32c(Buffer.alloc(0)) >>> 0).toBe(0);
  });

  it("is order-sensitive", () => {
    expect(crc32c(Buffer.from("ab"))).not.toBe(crc32c(Buffer.from("ba")));
  });
});
