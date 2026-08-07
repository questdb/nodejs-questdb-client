import { describe, it, expect } from "vitest";
import { writeBoundary, readBoundary, BOUNDARY_FILE_SIZE } from "../../../src/qwp/sf/boundary";

describe("boundary record", () => {
  it("alternates slots and picks the greatest valid generation", () => {
    const buf = Buffer.alloc(BOUNDARY_FILE_SIZE);
    writeBoundary(buf, 1, 100n);
    writeBoundary(buf, 2, 200n);
    expect(readBoundary(buf)).toEqual({ generation: 2, value: 200n });
  });

  it("writes the two records 4096 bytes apart", () => {
    const buf = Buffer.alloc(BOUNDARY_FILE_SIZE);
    writeBoundary(buf, 1, 100n);
    writeBoundary(buf, 2, 200n);
    expect(buf.readUInt32LE(0)).not.toBe(0);
    expect(buf.readUInt32LE(4096)).not.toBe(0);
  });

  it("falls back to the older record when the newer one is torn", () => {
    const buf = Buffer.alloc(BOUNDARY_FILE_SIZE);
    writeBoundary(buf, 1, 100n);
    writeBoundary(buf, 2, 200n);
    // Corrupt whichever slot holds generation 2.
    const slot = buf.readBigUInt64LE(8) === 2n ? 0 : 4096;
    buf[slot + 20] ^= 0xff;
    expect(readBoundary(buf)).toEqual({ generation: 1, value: 100n });
  });

  it("returns null when neither record validates", () => {
    const buf = Buffer.alloc(BOUNDARY_FILE_SIZE);
    expect(readBoundary(buf)).toBeNull();
  });
});
