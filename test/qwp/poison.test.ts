import { describe, it, expect } from "vitest";
import { PoisonDetector } from "../../src/qwp/poison";

describe("PoisonDetector", () => {
  it("does NOT escalate on strikes alone inside the dwell window", () => {
    let now = 1000;
    const d = new PoisonDetector(4, 5000, () => now);
    for (let i = 0; i < 6; i++) {
      now += 100;
      expect(d.strike(7)).toBe(false);
    }
  });

  it("escalates once both the count and the dwell are satisfied", () => {
    let now = 1000;
    const d = new PoisonDetector(4, 5000, () => now);
    d.strike(7);
    for (let i = 0; i < 3; i++) {
      now += 2000;
      d.strike(7);
    }
    now += 1;
    expect(d.strike(7)).toBe(true);
  });

  it("resets only on acceptance at or beyond the suspect frame", () => {
    let now = 1000;
    const d = new PoisonDetector(4, 0, () => now);
    d.strike(7);
    d.accept(5); // behind the suspect: must NOT launder the count
    d.strike(7);
    d.strike(7);
    expect(d.strike(7)).toBe(true);

    const d2 = new PoisonDetector(4, 0, () => now);
    d2.strike(7);
    d2.accept(7); // at the suspect: clears
    expect(d2.strike(7)).toBe(false);
  });

  it("a different frame resets the sequence", () => {
    let now = 1000;
    const d = new PoisonDetector(4, 0, () => now);
    d.strike(7);
    d.strike(7);
    d.strike(8);
    expect(d.strike(8)).toBe(false);
  });
});
