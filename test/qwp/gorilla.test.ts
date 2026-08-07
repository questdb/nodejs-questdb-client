import { describe, it, expect } from "vitest";
import { BitWriter } from "../../src/qwp/protocol/bits";
import { gorillaSize, encodeGorilla } from "../../src/qwp/protocol/gorilla";

describe("BitWriter", () => {
  it("packs LSB-first within each byte", () => {
    const w = new BitWriter(4);
    w.writeBits(0b1, 1);
    w.writeBits(0b0, 1);
    w.writeBits(0b1, 1);
    const out = w.finish();
    expect(out[0]).toBe(0b00000101);
  });
});

describe("gorilla", () => {
  it("returns -1 when a delta-of-delta leaves int32", () => {
    const ts = [0n, 1n, BigInt(2 ** 40)];
    expect(gorillaSize(ts)).toBe(-1);
  });

  it("sizes a constant-interval series as first two raw plus one bit per row", () => {
    const ts = [1000n, 2000n, 3000n, 4000n];
    // 8 + 8 + ceil(2 bits / 8) = 17
    expect(gorillaSize(ts)).toBe(17);
  });

  it("emits the first two timestamps raw", () => {
    const ts = [1000n, 2000n, 3000n];
    const b = encodeGorilla(ts);
    expect(b.readBigInt64LE(0)).toBe(1000n);
    expect(b.readBigInt64LE(8)).toBe(2000n);
  });
});
describe("gorilla round-trip (bit-reversal correctness)", () => {
  // Minimal LSB-first bit reader mirroring the encoder.
  function makeReader(enc: Buffer) {
    let byteIdx = 16, bitIdx = 0;
    const read = (n: number): number => {
      let v = 0;
      for (let i = 0; i < n; i++) {
        v |= ((enc[byteIdx] >> bitIdx) & 1) << i;
        if (++bitIdx === 8) { bitIdx = 0; byteIdx++; }
      }
      return v;
    };
    const signed = (v: number, bits: number) =>
      (v & (1 << (bits - 1))) ? v - (1 << bits) : v;
    return { read, signed };
  }

  function decode(enc: Buffer, count: number): bigint[] {
    const out: bigint[] = [enc.readBigInt64LE(0), enc.readBigInt64LE(8)];
    const { read, signed } = makeReader(enc);
    let prevDelta = out[1] - out[0];
    let prevTs = out[1];
    for (let i = 2; i < count; i++) {
      let dod: number;
      if (read(1) === 0) dod = 0;
      else if (read(1) === 0) dod = signed(read(7), 7);
      else if (read(1) === 0) dod = signed(read(9), 9);
      else if (read(1) === 0) dod = signed(read(12), 12);
      else dod = (read(32) | 0);
      const delta = prevDelta + BigInt(dod);
      prevTs = prevTs + delta;
      out.push(prevTs);
      prevDelta = delta;
    }
    return out;
  }

  it("round-trips a constant-interval series", () => {
    const ts = [1000n, 2000n, 3000n, 4000n, 5000n];
    expect(decode(encodeGorilla(ts), ts.length)).toEqual(ts);
  });

  it("round-trips a series exercising the '10' bucket", () => {
    // deltas: 100, 110, 120 -> dod 10, 10 (in [-64,63])
    const ts = [1000n, 1100n, 1210n, 1330n];
    expect(decode(encodeGorilla(ts), ts.length)).toEqual(ts);
  });
});
