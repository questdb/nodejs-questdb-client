export interface Row {
  table: string;
  symbols: [string, string][];
  longs: [string, bigint][];
  doubles: [string, number][];
  strings: [string, string][];
  /** Column names deliberately left unset for this row. */
  nulls: string[];
  ts: bigint;
}

export interface Workload {
  name: string;
  columns: number;
  rows(count: number): Row[];
}

/**
 * xorshift32 — deterministic and dependency-free.
 *
 * The first outputs from a small seed are near zero (seed 1 yields 0.00006,
 * then 0.01575) because the state has not diffused. Left unwarmed, `sparse`
 * would make row 0's leading columns deterministically null and `trades` would
 * open with its minimum price. Discarding the first 16 rounds costs nothing at
 * setup time and makes the early rows as representative as the rest.
 */
function rng(seed: number): () => number {
  let x = seed || 0x9e3779b9;
  const next = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
  for (let i = 0; i < 16; i++) next();
  return next;
}

const BASE_TS = 1_700_000_000_000_000n;

function trades(count: number): Row[] {
  const r = rng(1);
  const syms = ["ETH-USD", "BTC-USD", "SOL-USD", "ADA-USD"];
  const out: Row[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      table: "bench_trades",
      symbols: [["symbol", syms[i % syms.length]]],
      longs: [],
      doubles: [
        ["price", 1000 + r() * 5000],
        ["amount", r()],
      ],
      strings: [],
      nulls: [],
      ts: BASE_TS + BigInt(i) * 1000n,
    });
  }
  return out;
}

function wide(count: number): Row[] {
  const r = rng(2);
  const out: Row[] = [];
  for (let i = 0; i < count; i++) {
    const longs: [string, bigint][] = [];
    const doubles: [string, number][] = [];
    const strings: [string, string][] = [];
    for (let c = 0; c < 20; c++) longs.push([`l${c}`, BigInt(Math.floor(r() * 1e6))]);
    for (let c = 0; c < 20; c++) doubles.push([`d${c}`, r() * 1000]);
    for (let c = 0; c < 9; c++) strings.push([`s${c}`, `v${Math.floor(r() * 100)}`]);
    out.push({
      table: "bench_wide",
      symbols: [["sym", `s${i % 16}`]],
      longs,
      doubles,
      strings,
      nulls: [],
      ts: BASE_TS + BigInt(i) * 1000n,
    });
  }
  return out;
}

function highCardSymbol(count: number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      table: "bench_highcard",
      // Distinct per row up to 100k, then repeats.
      symbols: [["sym", `sym-${i % 100_000}`]],
      longs: [["v", BigInt(i)]],
      doubles: [],
      strings: [],
      nulls: [],
      ts: BASE_TS + BigInt(i) * 1000n,
    });
  }
  return out;
}

function sparse(count: number): Row[] {
  const r = rng(4);
  const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const out: Row[] = [];
  for (let i = 0; i < count; i++) {
    const longs: [string, bigint][] = [];
    const nulls: string[] = [];
    for (const n of names) {
      if (r() < 0.3) nulls.push(n);
      else longs.push([n, BigInt(Math.floor(r() * 1e6))]);
    }
    out.push({
      table: "bench_sparse",
      symbols: [],
      longs,
      doubles: [],
      strings: [],
      nulls,
      ts: BASE_TS + BigInt(i) * 1000n,
    });
  }
  return out;
}

export type WorkloadName = "trades" | "wide" | "highCardSymbol" | "sparse";

// Keyed on the literal union, not `string`: Tasks 6 and 7 index this as
// WORKLOADS[name], and a `Record<string, Workload>` would type a misspelled
// name as a valid Workload and fail only at runtime.
export const WORKLOADS: Record<WorkloadName, Workload> = {
  trades: { name: "trades", columns: 4, rows: trades },
  wide: { name: "wide", columns: 50, rows: wide },
  highCardSymbol: { name: "highCardSymbol", columns: 3, rows: highCardSymbol },
  sparse: { name: "sparse", columns: 8, rows: sparse },
};
