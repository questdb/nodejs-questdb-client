import { describe, it, expect } from "vitest";
import {
  writeManifest,
  readManifest,
  MANIFEST_FILE_SIZE,
  SFM1_MAGIC,
} from "../../../src/qwp/sf/manifest";

describe("sf-manifest.bin boundary record (spec 8.2, alternatgen scheme)", () => {
  it("writes an SFM1 record and reads it back", () => {
    const buf = Buffer.alloc(MANIFEST_FILE_SIZE);
    writeManifest(buf, 1, 42);
    const m = readManifest(buf);
    expect(m).toEqual({ generation: 1, headBaseSeq: 42 });
  });

  it("uses little-endian 'SFM1' magic like .ack-watermark does 'AKW1'", () => {
    const buf = Buffer.alloc(MANIFEST_FILE_SIZE);
    writeManifest(buf, 1, 7);
    // gen 1 -> slot 4096; LE bytes there: 'S' 'F' 'M' '1'
    expect(buf.subarray(4096, 4100).toString("ascii")).toBe("SFM1");
    expect(SFM1_MAGIC).toBe(0x314d4653);
  });

  it("alternates slots by generation parity so a torn record falls back", () => {
    const buf = Buffer.alloc(MANIFEST_FILE_SIZE);
    // slot = (generation % 2) * 4096: gen 1 -> slot 4096, gen 2 -> slot 0.
    writeManifest(buf, 1, 100); // slot 4096
    writeManifest(buf, 2, 200); // slot 0
    // Corrupt the newest (gen 2, slot 0) record's CRC.
    buf.writeUInt32LE(0, 0 + 60);
    const m = readManifest(buf);
    // Falls back to the older valid (gen 1, slot 4096) record.
    expect(m).toEqual({ generation: 1, headBaseSeq: 100 });
  });

  it("returns null when the file is absent/empty or neither record validates", () => {
    expect(readManifest(Buffer.alloc(MANIFEST_FILE_SIZE))).toBeNull();
    const buf = Buffer.alloc(MANIFEST_FILE_SIZE);
    buf.write("NOPE", 0, "ascii");
    expect(readManifest(buf)).toBeNull();
  });
});
