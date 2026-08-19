import { describe, it, expect } from "vitest";
import { newMaskKey, applyMask } from "../../src/qwp/ws/mask";

describe("ws masking", () => {
  it("produces a fresh 4-byte key per call", () => {
    const a = newMaskKey();
    const b = newMaskKey();
    expect(a.length).toBe(4);
    // Not a strong randomness test; catches a constant/seeded-once key.
    const keys = new Set([a.toString("hex"), b.toString("hex")]);
    for (let i = 0; i < 20; i++) keys.add(newMaskKey().toString("hex"));
    expect(keys.size).toBeGreaterThan(1);
  });

  it("is its own inverse", () => {
    const key = Buffer.from([1, 2, 3, 4]);
    const original = Buffer.from("hello websocket", "utf8");
    const payload = Buffer.from(original);
    applyMask(payload, key);
    expect(payload.equals(original)).toBe(false);
    applyMask(payload, key);
    expect(payload.equals(original)).toBe(true);
  });
});
