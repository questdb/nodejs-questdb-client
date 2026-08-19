import { describe, it, expect } from "vitest";
import { QWP_MAGIC, HEADER_SIZE, QWP_VERSION, TYPE_LONG, TYPE_SYMBOL } from "../../src/qwp/protocol/constants";

describe("QWP constants", () => {
  it("magic reads as 0x31505751 little-endian", () => {
    expect(QWP_MAGIC.toString("ascii")).toBe("QWP1");
    expect(QWP_MAGIC.readUInt32LE(0)).toBe(0x31505751);
  });

  it("pins header size and version", () => {
    expect(HEADER_SIZE).toBe(12);
    expect(QWP_VERSION).toBe(1);
  });

  it("pins the type codes this plan uses", () => {
    expect(TYPE_LONG).toBe(0x05);
    expect(TYPE_SYMBOL).toBe(0x09);
  });
});
