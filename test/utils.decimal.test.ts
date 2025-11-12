// @ts-check
import { describe, it, expect } from "vitest";
import { bigintToTwosComplementBytes } from "../src/utils";

describe("bigintToTwosComplementBytes", () => {
  it("encodes zero as a single zero byte", () => {
    expect(bigintToTwosComplementBytes(0n)).toEqual([0x00]);
  });

  it("encodes positive values without unnecessary sign-extension", () => {
    expect(bigintToTwosComplementBytes(1n)).toEqual([0x01]);
    expect(bigintToTwosComplementBytes(123456n)).toEqual([0x01, 0xe2, 0x40]);
  });

  it("adds a leading zero when the positive sign bit would be set", () => {
    expect(bigintToTwosComplementBytes(255n)).toEqual([0x00, 0xff]);
  });

  it("encodes negative values with two's complement sign extension", () => {
    expect(bigintToTwosComplementBytes(-1n)).toEqual([0xff]);
    expect(bigintToTwosComplementBytes(-10n)).toEqual([0xff, 0xf6]);
    expect(bigintToTwosComplementBytes(-256n)).toEqual([0xff, 0x00]);
  });
});
