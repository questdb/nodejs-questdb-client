export interface BenchmarkRow {
  table: string;
  symbols: [string, string][];
  longs: [string, bigint][];
  doubles: [string, number][];
  strings: [string, string][];
  /** Column names deliberately left unset for this row. */
  nulls: string[];
  timestamp: bigint;
}

export interface BenchmarkWorkload {
  name: string;
  columns: number;
  rows(count: number): BenchmarkRow[];
}

/** Deterministic, dependency-free xorshift32 generator. */
function random(seed: number): () => number {
  let state = seed || 0x9e3779b9;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  // Small xorshift seeds start near zero. Discard the poorly diffused prefix.
  for (let index = 0; index < 16; index++) next();
  return next;
}

const BASE_TIMESTAMP = 1_700_000_000_000_000n;

function trades(count: number): BenchmarkRow[] {
  const next = random(1);
  const symbols = ["ETH-USD", "BTC-USD", "SOL-USD", "ADA-USD"];
  return Array.from({ length: count }, (_, index) => ({
    table: "bench_trades",
    symbols: [["symbol", symbols[index % symbols.length]]],
    longs: [],
    doubles: [
      ["price", 1000 + next() * 5000],
      ["amount", next()],
    ],
    strings: [],
    nulls: [],
    timestamp: BASE_TIMESTAMP + BigInt(index) * 1000n,
  }));
}

function wide(count: number): BenchmarkRow[] {
  const next = random(2);
  const rows: BenchmarkRow[] = [];
  for (let index = 0; index < count; index++) {
    const longs: [string, bigint][] = [];
    const doubles: [string, number][] = [];
    const strings: [string, string][] = [];
    for (let column = 0; column < 20; column++) {
      longs.push([`l${column}`, BigInt(Math.floor(next() * 1e6))]);
      doubles.push([`d${column}`, next() * 1000]);
    }
    for (let column = 0; column < 9; column++) {
      strings.push([`s${column}`, `v${Math.floor(next() * 100)}`]);
    }
    rows.push({
      table: "bench_wide",
      symbols: [["sym", `s${index % 16}`]],
      longs,
      doubles,
      strings,
      nulls: [],
      timestamp: BASE_TIMESTAMP + BigInt(index) * 1000n,
    });
  }
  return rows;
}

function highCardinalitySymbols(count: number): BenchmarkRow[] {
  return Array.from({ length: count }, (_, index) => ({
    table: "bench_highcard",
    symbols: [["sym", `sym-${index % 100_000}`]],
    longs: [["v", BigInt(index)]],
    doubles: [],
    strings: [],
    nulls: [],
    timestamp: BASE_TIMESTAMP + BigInt(index) * 1000n,
  }));
}

function sparse(count: number): BenchmarkRow[] {
  const next = random(4);
  const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const rows: BenchmarkRow[] = [];
  for (let index = 0; index < count; index++) {
    const longs: [string, bigint][] = [];
    const nulls: string[] = [];
    for (const name of names) {
      if (next() < 0.3) nulls.push(name);
      else longs.push([name, BigInt(Math.floor(next() * 1e6))]);
    }
    rows.push({
      table: "bench_sparse",
      symbols: [],
      longs,
      doubles: [],
      strings: [],
      nulls,
      timestamp: BASE_TIMESTAMP + BigInt(index) * 1000n,
    });
  }
  return rows;
}

export type BenchmarkWorkloadName =
  | "trades"
  | "wide"
  | "highCardinalitySymbols"
  | "sparse";

export const BENCHMARK_WORKLOADS: Record<
  BenchmarkWorkloadName,
  BenchmarkWorkload
> = {
  trades: { name: "trades", columns: 4, rows: trades },
  wide: { name: "wide", columns: 50, rows: wide },
  highCardinalitySymbols: {
    name: "highCardinalitySymbols",
    columns: 3,
    rows: highCardinalitySymbols,
  },
  sparse: { name: "sparse", columns: 8, rows: sparse },
};
