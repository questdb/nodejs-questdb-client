import { describe, it, expect } from "vitest";
import { WORKLOADS } from "./workloads";

describe("workloads", () => {
  it("are deterministic across calls", () => {
    const a = WORKLOADS.trades.rows(100);
    const b = WORKLOADS.trades.rows(100);
    expect(JSON.stringify(a, (_, v) => (typeof v === "bigint" ? v.toString() : v)))
      .toBe(JSON.stringify(b, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  });

  it("trades has the advertised shape", () => {
    const r = WORKLOADS.trades.rows(1)[0];
    expect(r.symbols.length).toBe(1);
    expect(r.doubles.length).toBe(2);
  });

  it("wide has 50 data columns across all four families", () => {
    expect(WORKLOADS.wide.columns).toBe(50);
    const r = WORKLOADS.wide.rows(1)[0];
    // 1 + 20 + 20 + 9 = 50. The encoded table carries 51 including the
    // designated timestamp, which is not counted here.
    expect(r.symbols.length + r.longs.length + r.doubles.length + r.strings.length).toBe(50);
  });

  it("highCardSymbol produces many distinct symbols", () => {
    const rows = WORKLOADS.highCardSymbol.rows(5000);
    const distinct = new Set(rows.map((r) => r.symbols[0][1]));
    expect(distinct.size).toBeGreaterThan(4000);
  });

  it("sparse marks roughly 30% of values null", () => {
    const rows = WORKLOADS.sparse.rows(1000);
    const nullCount = rows.reduce((a, r) => a + r.nulls.length, 0);
    const total = rows.length * 8;
    expect(nullCount / total).toBeGreaterThan(0.2);
    expect(nullCount / total).toBeLessThan(0.4);
  });
});
