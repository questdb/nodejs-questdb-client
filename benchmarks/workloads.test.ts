import { describe, expect, it } from "vitest";
import { BENCHMARK_WORKLOADS } from "./workloads";

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

describe("benchmark workloads", () => {
  it("are deterministic across calls", () => {
    expect(stringify(BENCHMARK_WORKLOADS.trades.rows(100))).toBe(
      stringify(BENCHMARK_WORKLOADS.trades.rows(100)),
    );
  });

  it("builds the advertised trade shape", () => {
    const row = BENCHMARK_WORKLOADS.trades.rows(1)[0];
    expect(row.symbols).toHaveLength(1);
    expect(row.doubles).toHaveLength(2);
  });

  it("builds 50 wide data columns", () => {
    const row = BENCHMARK_WORKLOADS.wide.rows(1)[0];
    expect(
      row.symbols.length +
        row.longs.length +
        row.doubles.length +
        row.strings.length,
    ).toBe(50);
  });

  it("builds high-cardinality symbols", () => {
    const rows = BENCHMARK_WORKLOADS.highCardinalitySymbols.rows(5000);
    expect(new Set(rows.map((row) => row.symbols[0][1])).size).toBeGreaterThan(
      4000,
    );
  });

  it("makes roughly 30 percent of sparse values null", () => {
    const rows = BENCHMARK_WORKLOADS.sparse.rows(1000);
    const nulls = rows.reduce((total, row) => total + row.nulls.length, 0);
    const ratio = nulls / (rows.length * 8);
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(0.4);
  });
});
