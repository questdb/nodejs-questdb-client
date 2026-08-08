# QWP Plan B — Benchmarks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A TypeScript benchmark suite that validates the shipped QWP implementation — encoder throughput against hand-written floors, row-building overhead, store-and-forward append cost, and end-to-end flush latency against a live QuestDB.

**Architecture:** `vitest bench` for the three pure layers (no new tooling — vitest 3.1.3 is already a devDependency and uses tinybench underneath). One standalone script for end-to-end, which needs a live server and reports percentiles rather than ops/s. Workloads are hardcoded TypeScript generators with fixed seeds.

**Tech Stack:** TypeScript, Node ≥ 20, vitest bench. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-08-qwp-node-benchmarks-design.md`.

## Global Constraints

- **No new dependencies**, runtime or dev. `vitest bench` is already available.
- **Ad-hoc only.** Do not add a CI workflow, a PR gate, or a nightly job.
- **Benchmarks live in `benchmarks/`**, not `test/`, so `pnpm test` stays fast.
- **Deterministic workloads.** Every generator takes a fixed seed; no `Math.random()` without one, or two runs are not comparable.
- Existing tests stay green: `npx vitest run && npx tsc --noEmit && npx eslint src/**`.
- **Never quote a number from a single run.** The e2e script enforces this by repeating; for the pure layers, tinybench's own iteration count covers it.

## Harness facts, verified by running it

A throwaway probe was run against `vitest bench` 3.1.3 before this plan was
finalised. What it established:

- **Nested `describe` and `async` bench bodies both work.** The shapes this plan
  uses are supported.
- **Vitest prints "Benchmarking is an experimental feature. Breaking changes
  might not follow SemVer, please pin Vitest's version when using it."** Take
  that seriously: `package.json` currently has `"vitest": "^3.1.3"` with a
  caret, which is exactly what the warning advises against. Task 3 pins it.
- **The reported columns are `hz, min, max, mean, p75, p99, p995, p999, rme,
  samples`.** There is **no p50 and no p90** — the e2e script computes those
  itself, which is part of why it is a standalone script rather than a bench file.
- **`hz` is callback invocations per second, not rows per second.** With a
  10,000-row workload per callback, rows/s is `hz × 10_000`. Reading `hz`
  directly as a row rate understates throughput by four orders of magnitude.
- **An `await Promise.resolve()` alone costs ~1.4×** at these speeds (380k hz
  sync vs 267k hz async in the probe). Task 7's `SfEngine.append` is async, so a
  meaningful slice of that measurement is promise machinery rather than engine
  work. Do not attribute it all to the engine.
- **`rme` is the relative margin of error.** Check it before believing any
  delta: a 5% difference between two arms with ±3% rme each is not a result.

**Not covered by the probe, so treat as an assumption:** that `beforeAll` runs
in a `.bench.ts` file. Task 7 relies on it for the temp directory, the disk
baseline *and* opening both engines. If it does not fire, the engines are
`undefined` and the task crashes — loudly, which is the good case. Move that
setup to module scope if so; the file is loaded once per run, so top-level code
works either way. Check this before concluding anything about the numbers.

## Verified API surface

These signatures were checked against the shipped code and are what the benchmarks call:

```ts
// src/qwp/protocol/frameEncoder.ts
interface FrameOpts { gorilla: boolean; dict?: SymbolDict; confirmedMaxId?: number; deferCommit?: boolean }
function encodeFrame(tables: QwpTableBuffer[], opts: FrameOpts): Buffer

// src/qwp/protocol/columnWriter.ts
function columnPayloadSize(col, rowCount, opts): number
function writeColumn(buf, offset, col, rowCount, opts): number

// src/qwp/protocol/tableBuffer.ts
class QwpTableBuffer { constructor(name); getOrCreateColumn(name, type); nextRow(); reset() }

// src/qwp/protocol/symbolDict.ts
class SymbolDict { getOrAdd(s): number; size(): number; entriesFrom(id): string[] }

// src/qwp/buffer.ts
class QwpBuffer { attachDict(d, persist?); sealFrames(maxBatchSize): Buffer[] }

// src/qwp/sf/engine.ts
interface EngineOptions { segmentBytes; maxTotalBytes; sfDir?; senderId; durability?; syncIntervalMillis? }
class SfEngine { async append(frame: Buffer): Promise<number> }

// src/qwp/sf/segment.ts
function scanSegment(buf: Buffer): ScanResult
```

## File Structure

| File | Responsibility |
|---|---|
| `benchmarks/workloads.ts` | Four seeded row generators |
| `benchmarks/floors.ts` | Hand-written baselines |
| `benchmarks/encoder.bench.ts` | Column write, frame encode, gorilla, symbol dict |
| `benchmarks/buffer.bench.ts` | `QwpBuffer` builder chain |
| `benchmarks/sf.bench.ts` | `SfEngine.append`, `scanSegment`, disk baseline |
| `benchmarks/e2e.ts` | Live-server latency, both flush contracts |
| `benchmarks/validate.test.ts` | The five spec §8 assertions, run by `pnpm test` |
| `package.json` | **modify** — `bench` and `bench:e2e` scripts |
| `vitest.config.ts` | **modify or create** — include `benchmarks/` for bench mode |

---

### Task 1: Seeded workloads

**Files:**
- Create: `benchmarks/workloads.ts`
- Test: `benchmarks/workloads.test.ts`

**Interfaces:**
- Produces: `interface Row { table: string; symbols: [string,string][]; longs: [string,bigint][]; doubles: [string,number][]; strings: [string,string][]; nulls: string[]; ts: bigint }`, `type Workload = { name: string; columns: number; rows(count: number): Row[] }`, and `WORKLOADS: Record<"trades"|"wide"|"highCardSymbol"|"sparse", Workload>`.

Determinism matters more than realism here: two runs must produce identical input or the numbers are not comparable.

- [ ] **Step 1: Write the failing test**

```ts
// benchmarks/workloads.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/nick/repos/nodejs-questdb-client && npx vitest run benchmarks/workloads.test.ts`
Expected: FAIL — cannot resolve `./workloads`.

- [ ] **Step 3: Write the implementation**

```ts
// benchmarks/workloads.ts

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

/** xorshift32 — deterministic and dependency-free. */
function rng(seed: number): () => number {
  let x = seed || 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run benchmarks/workloads.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/workloads.ts benchmarks/workloads.test.ts
git commit -m "bench: add seeded workload generators"
```

---

### Task 2: Floor baselines

**Files:**
- Create: `benchmarks/floors.ts`
- Test: `benchmarks/floors.test.ts`

**Interfaces:**
- Produces: `floorWriteLongs(values: bigint[]): Buffer`, `floorWriteStrings(values: string[]): Buffer`, `floorInternSymbols(values: string[]): number[]`.

Rust's idea: the floor bounds how much measured time is protocol work versus raw byte movement. It is **not** a target — it ignores null bitmaps, schema and framing.

- [ ] **Step 1: Write the failing test**

```ts
// benchmarks/floors.test.ts
import { describe, it, expect } from "vitest";
import { floorWriteLongs, floorWriteStrings, floorInternSymbols } from "./floors";

describe("floors", () => {
  it("writes 8 bytes per long", () => {
    const b = floorWriteLongs([1n, 2n, 3n]);
    expect(b.length).toBe(24);
    expect(b.readBigInt64LE(8)).toBe(2n);
  });

  it("writes utf8 back to back", () => {
    expect(floorWriteStrings(["ab", "cd"]).toString("utf8")).toBe("abcd");
  });

  it("interns to dense ids", () => {
    expect(floorInternSymbols(["a", "b", "a"])).toEqual([0, 1, 0]);
  });
});
```

- [ ] **Step 2: Run test** → `npx vitest run benchmarks/floors.test.ts` → FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```ts
// benchmarks/floors.ts
import { Buffer } from "node:buffer";

/**
 * Hand-written baselines. Each does the minimum byte movement the equivalent
 * encoder path must also do -- no null bitmap, no schema, no framing. The gap
 * between a floor and the real encoder is the protocol's cost.
 */

export function floorWriteLongs(values: bigint[]): Buffer {
  const b = Buffer.allocUnsafe(values.length * 8);
  let o = 0;
  for (const v of values) {
    b.writeBigInt64LE(v, o);
    o += 8;
  }
  return b;
}

export function floorWriteStrings(values: string[]): Buffer {
  let total = 0;
  for (const s of values) total += Buffer.byteLength(s, "utf8");
  const b = Buffer.allocUnsafe(total);
  let o = 0;
  for (const s of values) o += b.write(s, o, "utf8");
  return b;
}

/** Naive per-row map lookup -- what the row API pays at the same cardinality. */
export function floorInternSymbols(values: string[]): number[] {
  const map = new Map<string, number>();
  const out: number[] = [];
  for (const s of values) {
    let id = map.get(s);
    if (id === undefined) {
      id = map.size;
      map.set(s, id);
    }
    out.push(id);
  }
  return out;
}
```

- [ ] **Step 4: Run test** → PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/floors.ts benchmarks/floors.test.ts
git commit -m "bench: add hand-written floor baselines"
```

---

### Task 3: Bench scripts and vitest config

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts` (or modify if present)

- [ ] **Step 1: Check whether a vitest config already exists**

Run: `ls vitest.config.* vite.config.* 2>/dev/null || echo NONE`
If one exists, modify it rather than creating a second.

- [ ] **Step 2: Add the config**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep `pnpm test` fast: unit tests and the benchmark validation
    // assertions, but never the benchmarks themselves.
    include: ["test/**/*.test.ts", "benchmarks/**/*.test.ts"],
    // `benchmark` nests UNDER `test` — a top-level key is silently ignored
    // and `vitest bench` then picks up its default globs instead.
    benchmark: {
      include: ["benchmarks/**/*.bench.ts"],
    },
  },
});
```

- [ ] **Step 3: Add the scripts and pin vitest**

In `package.json`, alongside the existing `"test"` script:

```json
    "bench": "vitest bench --run",
    "bench:e2e": "npx tsx benchmarks/e2e.ts"
```

`npx tsx`, not bare `tsx`. `tsx` is deliberately **not** a dependency (see Global
Constraints), so it is not in `node_modules/.bin` and a bare invocation fails
with "command not found". `npx` fetches it on demand.

And **pin vitest exactly**, dropping the caret. Vitest prints a warning on every
bench run that benchmarking is experimental and may break outside SemVer; a
caret range means a patch bump can silently change the numbers or the output
format:

```json
    "vitest": "3.1.3"
```

`tsx` is invoked via `npx` at run time and is **not** added as a dependency —
`npx tsx` resolves it on demand, keeping the constraint that this plan adds none.

- [ ] **Step 4: Verify the split**

Run: `npx vitest run` then `npx vitest bench --run`
Expected: the first runs unit tests and finds no `.bench.ts`; the second reports "No benchmark files found" (nothing exists yet). Neither errors.

- [ ] **Step 5: Commit**

```bash
git add package.json vitest.config.ts
git commit -m "bench: add bench scripts and split bench files from tests"
```

---

### Task 4: Validation assertions — run before you measure

**Files:**
- Create: `benchmarks/validate.test.ts`

**Spec §8.** These run under `pnpm test`, not `pnpm bench` — they are correctness checks on the wire format, expressed through the benchmark workloads. They are the cheapest possible check that the rules the design spec spent most of its length on actually hold at runtime.

- [ ] **Step 1: Write the failing test**

```ts
// benchmarks/validate.test.ts
import { describe, it, expect } from "vitest";
import { QwpBuffer } from "../src/qwp/buffer";
import { SymbolDict } from "../src/qwp/protocol/symbolDict";
import { QwpTableBuffer } from "../src/qwp/protocol/tableBuffer";
import { encodeFrame } from "../src/qwp/protocol/frameEncoder";
import { TYPE_LONG } from "../src/qwp/protocol/constants";
import { WORKLOADS } from "./workloads";

const CAP = 1 << 30;

/**
 * `confirmedMaxId` lives on the BUFFER, starts at -1, and only advances via
 * confirmDeltaPublished(), which the transport's publish path calls -- not
 * sealFrames(). So a fresh QwpBuffer with a fully primed dictionary still
 * ships every symbol, because entriesFrom(-1 + 1) returns everything. Priming
 * the dict alone does nothing; the baseline has to be set too, which is what
 * `confirmed` simulates.
 */
function build(
  rows: ReturnType<typeof WORKLOADS.trades.rows>,
  dict?: SymbolDict,
  confirmed?: number,
): Buffer[] {
  const b = new QwpBuffer();
  if (dict) b.attachDict(dict);
  if (confirmed !== undefined) b.setConfirmedMaxId(confirmed);
  for (const row of rows) {
    b.table(row.table);
    for (const [n, v] of row.symbols) b.symbol(n, v);
    for (const [n, v] of row.longs) b.intColumn(n, Number(v));
    for (const [n, v] of row.doubles) b.floatColumn(n, v);
    for (const [n, v] of row.strings) b.stringColumn(n, v);
    b.at(row.ts, "us");
  }
  return b.sealFrames(CAP);
}

describe("wire-format invariants", () => {
  it("trades encodes to a plausible bytes/row", () => {
    const rows = WORKLOADS.trades.rows(10_000);
    const bytes = build(rows).reduce((a, f) => a + f.length, 0);
    const perRow = bytes / rows.length;
    // Well under means values are being dropped; well over means framing
    // overhead has regressed.
    expect(perRow).toBeGreaterThan(20);
    expect(perRow).toBeLessThan(120);
  });

  it("null values are compacted, not written as placeholders", () => {
    const rows = WORKLOADS.sparse.rows(2000);
    const sparseBytes = build(rows).reduce((a, f) => a + f.length, 0);

    // Same shape with every value present.
    const dense = rows.map((r) => ({
      ...r,
      nulls: [],
      longs: ["a", "b", "c", "d", "e", "f", "g", "h"].map(
        (n) => [n, 1n] as [string, bigint],
      ),
    }));
    const denseBytes = build(dense).reduce((a, f) => a + f.length, 0);

    // ~30% nulls must produce a materially smaller payload (spec 6.2.1).
    expect(sparseBytes).toBeLessThan(denseBytes * 0.9);
  });

  it("delta mode emits fewer bytes than full-dict on high cardinality", () => {
    const rows = WORKLOADS.highCardSymbol.rows(5000);
    const full = build(rows).reduce((a, f) => a + f.length, 0);

    // Steady state: the dictionary is populated AND the server has confirmed
    // those ids, so the frame carries varint ids and an empty delta section.
    // Both halves are required -- see the note on build() above.
    const dict = new SymbolDict();
    build(rows, dict); // first pass registers every symbol in the dict
    const second = build(rows, dict, dict.size() - 1).reduce((a, f) => a + f.length, 0);

    expect(second).toBeLessThan(full);
  });

  it("a cold delta batch is NOT smaller — the baseline is what saves bytes", () => {
    // Guards the mistake above: priming the dict without advancing the
    // confirmed baseline still ships every symbol string, so this must land
    // in the same range as full-dict rather than winning.
    const rows = WORKLOADS.highCardSymbol.rows(5000);
    const full = build(rows).reduce((a, f) => a + f.length, 0);

    const dict = new SymbolDict();
    build(rows, dict);
    const coldAgain = build(rows, dict).reduce((a, f) => a + f.length, 0);

    expect(coldAgain).toBeGreaterThan(full * 0.5);
  });

  it("gorilla shrinks regularly spaced timestamps", () => {
    const t = new QwpTableBuffer("g");
    for (let i = 0; i < 5000; i++) {
      t.getOrCreateColumn("v", TYPE_LONG)?.values.push(BigInt(i));
      t.nextRow();
    }
    const off = encodeFrame([t], { gorilla: false }).length;
    const on = encodeFrame([t], { gorilla: true }).length;
    // LONG is not gorilla-encoded, so these must match exactly. A difference
    // means the flag is leaking into a column type it should not touch.
    expect(on).toBe(off);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run benchmarks/validate.test.ts`
Expected: 4 tests. **If any fail, that is a real finding about the implementation, not a broken test** — investigate the encoder before adjusting a bound.

- [ ] **Step 3: Record the actual bytes/row**

Once green, replace the wide 20–120 band with a tighter one around the measured value, and note the measured figure in a comment. A loose bound catches nothing.

- [ ] **Step 4: Commit**

```bash
git add benchmarks/validate.test.ts
git commit -m "test: add wire-format invariants over the benchmark workloads"
```

---

### Task 5: Encoder benchmarks

**Files:**
- Create: `benchmarks/encoder.bench.ts`

Covers `writeColumn` per type, whole-frame `encodeFrame`, gorilla on and off, and `SymbolDict` versus the naive floor.

- [ ] **Step 1: Write the benchmark**

```ts
// benchmarks/encoder.bench.ts
import { bench, describe } from "vitest";
import { QwpTableBuffer } from "../src/qwp/protocol/tableBuffer";
import { encodeFrame } from "../src/qwp/protocol/frameEncoder";
import { SymbolDict } from "../src/qwp/protocol/symbolDict";
import {
  TYPE_LONG,
  TYPE_DOUBLE,
  TYPE_SYMBOL,
  TYPE_TIMESTAMP,
  TYPE_VARCHAR,
} from "../src/qwp/protocol/constants";
import { WORKLOADS } from "./workloads";
import { floorWriteLongs, floorInternSymbols } from "./floors";

const N = 10_000;

/**
 * Consumes every result so neither the encoder nor the floor can be optimised
 * away. Built in rather than added reactively: a floor that gets eliminated
 * while the encoder does not (or vice versa) produces a ratio that looks like
 * a finding, and the whole point of the floor is that the ratio is trustworthy.
 */
let sink = 0;

/**
 * Every column family the workloads generate must be handled here. Dropping
 * one silently shrinks the benchmark: omitting `strings` turns `wide` from the
 * advertised 50 columns into 42 and stops exercising varchar entirely.
 */
function buildTable(name: string, rows: ReturnType<typeof WORKLOADS.trades.rows>): QwpTableBuffer {
  const t = new QwpTableBuffer(name);
  for (const row of rows) {
    for (const [n, v] of row.symbols) t.getOrCreateColumn(n, TYPE_SYMBOL)?.values.push(v);
    for (const [n, v] of row.longs) t.getOrCreateColumn(n, TYPE_LONG)?.values.push(v);
    for (const [n, v] of row.doubles) t.getOrCreateColumn(n, TYPE_DOUBLE)?.values.push(v);
    for (const [n, v] of row.strings) t.getOrCreateColumn(n, TYPE_VARCHAR)?.values.push(v);
    t.getOrCreateColumn("timestamp", TYPE_TIMESTAMP)?.values.push(row.ts);
    t.nextRow();
  }
  return t;
}

describe("frame encode", () => {
  for (const name of ["trades", "wide", "sparse"] as const) {
    const rows = WORKLOADS[name].rows(N);
    // Use the workload's own table name, matching Tasks 4 and 6. Passing
    // WORKLOADS[name].name instead ("trades" vs "bench_trades") would encode a
    // different table-name length and make frame sizes differ between tasks
    // measuring nominally the same workload.
    const table = buildTable(rows[0].table, rows);
    bench(`encodeFrame / ${name} / gorilla off`, () => {
      sink += encodeFrame([table], { gorilla: false }).length;
    });
    bench(`encodeFrame / ${name} / gorilla on`, () => {
      sink += encodeFrame([table], { gorilla: true }).length;
    });
  }
});

describe("floor comparison", () => {
  const longs = WORKLOADS.sparse.rows(N).flatMap((r) => r.longs.map(([, v]) => v));

  bench("FLOOR writeBigInt64LE loop", () => {
    sink += floorWriteLongs(longs).length;
  });

  const t = new QwpTableBuffer("floor_cmp");
  for (const v of longs) {
    t.getOrCreateColumn("v", TYPE_LONG)?.values.push(v);
    t.nextRow();
  }
  bench("encodeFrame single long column", () => {
    sink += encodeFrame([t], { gorilla: false }).length;
  });
});

describe("symbol interning", () => {
  const syms = WORKLOADS.highCardSymbol.rows(N).map((r) => r.symbols[0][1]);

  bench("FLOOR naive Map intern", () => {
    sink += floorInternSymbols(syms).length;
  });

  bench("SymbolDict.getOrAdd", () => {
    const d = new SymbolDict();
    for (const s of syms) d.getOrAdd(s);
    sink += d.size();
  });
});

// Keeps `sink` observable so the compiler cannot treat it as dead.
export const _sink = () => sink;
```

- [ ] **Step 2: Run it**

Run: `npx vitest bench --run benchmarks/encoder.bench.ts`
Expected: a table with `hz, min, max, mean, p75, p99, p995, p999, rme, samples`.

**`hz` is callbacks per second, not rows per second.** Each callback encodes
`N = 10_000` rows, so rows/s is `hz × 10_000`. Record the multiplied figure or
label the column honestly — quoting `hz` as a row rate understates it 10,000×.

- [ ] **Step 3: Sanity-read the output before trusting it**

Two checks before recording anything:
- `encodeFrame single long column` should be **slower** than the floor, not faster. The `sink` accumulator already guards against elimination; if the encoder still beats a bare write loop, something is wrong with the comparison itself, not with dead-code removal.
- `gorilla on` should produce a **smaller frame** than `gorilla off` on `trades`
  and `wide`, whose timestamps are perfectly regular (`BASE_TS + i × 1000`) so
  every delta-of-delta is 0 and each row costs one bit. If it does not, the
  encoder is not taking the compressed path.
- `gorilla on` on `sparse`, whose timestamps are jittered, should still be
  smaller than `gorilla off` but by a **narrower** margin — jitter pushes
  delta-of-delta into the 7/9/12-bit buckets instead of the 1-bit one.

**What this suite does not cover.** Gorilla's raw fallback (spec 6.3.1) fires
only when a delta-of-delta leaves signed int32 — roughly a 35-minute jump
between consecutive gaps at microsecond resolution. No workload here produces
that, so the fallback is never measured. It is a correctness property rather
than a throughput one, so Task 4 asserts it instead; do not read these numbers
as covering it.

- [ ] **Step 4: Commit**

```bash
git add benchmarks/encoder.bench.ts
git commit -m "bench: add encoder throughput benchmarks with floor comparison"
```

---

### Task 6: Row-building benchmarks

**Files:**
- Create: `benchmarks/buffer.bench.ts`

Measures what the encoder benchmarks miss: map lookups, type locks, null back-fill, and the row-rollback guard on every setter.

- [ ] **Step 1: Write the benchmark**

```ts
// benchmarks/buffer.bench.ts
import { bench, describe } from "vitest";
import { QwpBuffer } from "../src/qwp/buffer";
import { SymbolDict } from "../src/qwp/protocol/symbolDict";
import { WORKLOADS } from "./workloads";

const N = 10_000;
const CAP = 1 << 30; // large enough that nothing splits

/** See Task 5's note — consumes results so nothing is optimised away. */
let sink = 0;

/**
 * Handles every column family the workloads generate — see Task 5's note.
 *
 * Note `Number(v)`: `intColumn` takes a `number` while the workloads carry
 * `bigint`, so this layer pays a per-value conversion the encoder benchmarks in
 * Task 5 do not (they push the bigint straight into `values`). The two tasks are
 * therefore not directly comparable — some of the gap is representation, not
 * buffer overhead. All generated values are well under 2^53, so no precision is
 * lost; raise N or change a generator and re-check that.
 */
function fill(b: QwpBuffer, rows: ReturnType<typeof WORKLOADS.trades.rows>): void {
  for (const row of rows) {
    b.table(row.table);
    for (const [n, v] of row.symbols) b.symbol(n, v);
    for (const [n, v] of row.longs) b.intColumn(n, Number(v));
    for (const [n, v] of row.doubles) b.floatColumn(n, v);
    for (const [n, v] of row.strings) b.stringColumn(n, v);
    // QwpBuffer.at() is synchronous (src/qwp/buffer.ts:173) — do NOT await it.
    b.at(row.ts, "us");
  }
}

describe("QwpBuffer build + seal", () => {
  for (const name of ["trades", "wide", "sparse"] as const) {
    const rows = WORKLOADS[name].rows(N);
    bench(`build+seal / ${name}`, () => {
      const b = new QwpBuffer();
      fill(b, rows);
      sink += b.sealFrames(CAP).length;
    });
  }
});

describe("dictionary mode", () => {
  const rows = WORKLOADS.highCardSymbol.rows(N);

  bench("full-dict (no dict attached)", () => {
    const b = new QwpBuffer();
    fill(b, rows);
    sink += b.sealFrames(CAP).length;
  });

  // Steady state needs BOTH halves: a populated dictionary and a confirmed
  // baseline. confirmedMaxId lives on the buffer, starts at -1, and only moves
  // via confirmDeltaPublished() from the transport's publish path -- so a
  // fresh buffer with a primed dict still ships every symbol, because
  // entriesFrom(-1 + 1) returns everything. Priming the dict alone measures
  // nothing new.
  const primed = new SymbolDict();
  {
    const warm = new QwpBuffer();
    warm.attachDict(primed);
    fill(warm, rows);
    warm.sealFrames(CAP);
  }

  bench("delta-dict (primed + baseline confirmed)", () => {
    const b = new QwpBuffer();
    b.attachDict(primed);
    b.setConfirmedMaxId(primed.size() - 1);
    fill(b, rows);
    sink += b.sealFrames(CAP).length;
  });

  bench("delta-dict (cold, first batch)", () => {
    const b = new QwpBuffer();
    b.attachDict(new SymbolDict());
    fill(b, rows);
    sink += b.sealFrames(CAP).length;
  });
});

export const _sink = () => sink;
```

- [ ] **Step 2: Run it**

Run: `npx vitest bench --run benchmarks/buffer.bench.ts`

Expected: ops/s per benchmark. Two readings to make before recording anything:

- **`wide` should be markedly slower per row than `trades`** — 50 columns means
  50 map lookups and 50 null-backfill checks per row. If they are close,
  `getOrCreateColumn` is not on the hot path you think it is.
- **`delta-dict (primed + baseline confirmed)` should beat both `full-dict` and
  `delta-dict (cold)`** on this workload. It ships varint ids; the other two
  ship 100k symbol strings. If it is *not* clearly ahead, check
  `setConfirmedMaxId` was called before suspecting the encoder — without it the
  arm silently degrades into the cold case and the comparison is meaningless.

- [ ] **Step 3: Commit**

```bash
git add benchmarks/buffer.bench.ts
git commit -m "bench: add row-building benchmarks for QwpBuffer"
```

---

### Task 7: Store-and-forward benchmarks with a disk baseline

**Files:**
- Create: `benchmarks/sf.bench.ts`

**Spec §7.** The disk figure prints **before** the results so an implausible number is visible rather than silently quoted. Storage benchmarks on a degraded SSD can read an order of magnitude slow.

- [ ] **Step 1: Write the benchmark**

```ts
// benchmarks/sf.bench.ts
import { bench, describe, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { SfEngine } from "../src/qwp/sf/engine";
import { buildSegment, scanSegment } from "../src/qwp/sf/segment";

let dir: string;

/**
 * Where the SF benchmark writes. os.tmpdir() is /tmp on most Linux boxes and
 * /tmp is frequently tmpfs -- i.e. RAM. Both the dd baseline and the SF
 * benchmark would then measure memory while claiming to measure disk, and the
 * baseline would report a *great* number, so the guard fails silently in the
 * most reassuring possible direction. Point QWP_BENCH_DIR at real storage.
 */
function benchRoot(): string {
  const override = process.env.QWP_BENCH_DIR;
  if (override) return override;
  const t = tmpdir();
  if (t.startsWith("/dev/shm") || t.startsWith("/run")) {
    console.log(
      `\n[disk baseline] ${t} is almost certainly tmpfs (RAM). ` +
        "SF numbers below are NOT disk numbers. Set QWP_BENCH_DIR to real storage.",
    );
  } else {
    console.log(
      `\n[disk baseline] using ${t} — if this is tmpfs, these are RAM numbers. ` +
        "Check with: df -T " + t,
    );
  }
  return t;
}

/** Prints a dd throughput figure so a degraded disk is visible, not silent. */
function diskBaseline(path: string): void {
  try {
    const out = execFileSync(
      "dd",
      ["if=/dev/zero", `of=${join(path, "dd.tmp")}`, "bs=1M", "count=256", "oflag=direct"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    console.log(`[disk baseline] ${out.trim().split("\n").pop()}`);
  } catch {
    console.log(
      "[disk baseline] unavailable (dd missing, or O_DIRECT unsupported — " +
        "which itself suggests tmpfs). Treat SF numbers with caution.",
    );
  } finally {
    rmSync(join(path, "dd.tmp"), { force: true });
  }
}

// Engines are opened ONCE, not per iteration — see the note on withEngine below.
let memEngine: SfEngine;
let diskEngine: SfEngine;

beforeAll(async () => {
  dir = mkdtempSync(join(benchRoot(), "qwp-bench-"));
  diskBaseline(dir);
  memEngine = new SfEngine({
    segmentBytes: 4 << 20,
    maxTotalBytes: 1 << 30,
    senderId: "bench-mem",
  });
  await memEngine.open();
  diskEngine = new SfEngine({
    segmentBytes: 4 << 20,
    maxTotalBytes: 1 << 30,
    sfDir: dir,
    senderId: "bench-disk",
  });
  await diskEngine.open();
  return async () => {
    await memEngine.close();
    await diskEngine.close();
    rmSync(dir, { recursive: true, force: true });
  };
});

const FRAME = Buffer.alloc(4096, 0x41);

const APPENDS = 100;

/**
 * Engines are opened once in beforeAll, NOT per iteration.
 *
 * Creating one inside the bench body would put acquireSlot (an exclusive
 * lockfile), recovery, a dict fd open and a setInterval start inside the timed
 * window — setup that dwarfs 100 appends, so the benchmark would report
 * engine-open cost under an "append" label.
 *
 * The cost of hoisting is that the ring accumulates across iterations, so each
 * body acknowledges what it just published to keep trim running. acknowledge()
 * is cheap and is on the real ACK path anyway, so its inclusion is honest
 * rather than a distortion.
 */
async function appendBatch(e: SfEngine): Promise<void> {
  for (let i = 0; i < APPENDS; i++) await e.append(FRAME);
  e.acknowledge(e.publishedFsn);
}

describe("SfEngine.append", () => {
  bench(`memory mode / ${APPENDS} appends`, async () => {
    await appendBatch(memEngine);
  });

  bench(`disk mode / ${APPENDS} appends`, async () => {
    await appendBatch(diskEngine);
  });
});

describe("segment recovery", () => {
  const frames = Array.from({ length: 1000 }, () => FRAME);
  const seg = buildSegment(0, frames, 8 << 20);

  bench("scanSegment / 1000 frames", () => {
    scanSegment(seg);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest bench --run benchmarks/sf.bench.ts`
Expected: a `[disk baseline]` line, then results.

**Disk mode must be slower than memory mode.** If it is not, the likeliest cause
is a missing `await e.open()` — `append()` silently skips its write when `slot`
is unset, so the "disk" arm is really measuring memory mode. Check that before
concluding anything about the disk.

**Both arms are async, so both pay promise overhead.** The probe measured
`await Promise.resolve()` alone at ~1.4× cost, so at these speeds a real slice
of the memory-mode number is machinery rather than engine work. That is the
honest number for a caller, but it means memory-mode append is not comparable
to a synchronous floor — which is why this family has none.

**If the process hangs after the results**, `close()` was not reached: `open()`
starts a `setInterval` barrier that holds the event loop open.

- [ ] **Step 3: Sanity-check against the baseline**

**First confirm you are measuring disk at all.** Run `df -T $(node -p "require('os').tmpdir()")`. If the type is `tmpfs`, both the `dd` figure and every SF number are RAM measurements — and the `dd` figure will look *excellent*, which is why this check has to be explicit rather than left to judgement. Set `QWP_BENCH_DIR` to a path on real storage and re-run.

Then: if the `dd` figure is far below what the hardware should do (an NVMe SSD reporting tens of MB/s rather than hundreds), stop and fix the machine before recording any SF number. A degraded or untrimmed drive makes these results meaningless.

- [ ] **Step 4: Commit**

```bash
git add benchmarks/sf.bench.ts
git commit -m "bench: add store-and-forward benchmarks with a disk baseline"
```

---

### Task 8: End-to-end latency script

**Files:**
- Create: `benchmarks/e2e.ts`

**Spec §7.** Both flush contracts, **one server**, **three repeats**. Reports percentiles because ingest UX is gated by the tail, not the mean.

- [ ] **Step 1: Write the script**

```ts
// benchmarks/e2e.ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Sender } from "../src";
import { WORKLOADS } from "./workloads";

const ADDR = process.env.QDB_ADDR ?? "localhost:9000";
const ROWS = Number(process.env.BENCH_ROWS ?? 5000);
const WARMUP = 500;
const REPEATS = 3;

/**
 * Where the sf-on arm writes. Defaults to the OS temp dir, which on most Linux
 * boxes is /tmp and is frequently tmpfs — i.e. RAM. The sf-on number is
 * "durable locally", so measuring it against RAM makes it look dramatically
 * better than any real deployment. Set QWP_BENCH_DIR to real storage.
 */
const SF_ROOT = process.env.QWP_BENCH_DIR ?? process.env.TMPDIR ?? "/tmp";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

/**
 * Measures flush() per row.
 *
 * This is only a clean measurement BECAUSE we flush every row. Sender.at()
 * awaits tryFlush(), which fires when pendingRowCount >= auto_flush_rows
 * (1000) or the auto_flush_interval elapses -- and flush() resets both. Since
 * we flush after every row, neither trigger is ever reached, so no flush
 * happens outside the timed window. Batch rows before flushing and the samples
 * become a bimodal mixture of real flushes and near-no-ops, with p50 dominated
 * by the no-ops. If you change the flush cadence, disable auto-flush's row
 * trigger first.
 */
async function arm(config: string): Promise<number[]> {
  const sender = await Sender.fromConfig(config);
  const samples: number[] = [];
  try {
    await sender.connect();
    // Warmup rows are DISJOINT from measured rows: re-sending the same
    // timestamps would double-ingest them, which is harmless for latency but
    // breaks any later row-count assertion added to this script.
    const warm = WORKLOADS.trades.rows(WARMUP);
    const rows = WORKLOADS.trades.rows(WARMUP + ROWS).slice(WARMUP);

    for (const row of warm) {
      sender.table(row.table).symbol("symbol", row.symbols[0][1]);
      for (const [n, v] of row.doubles) sender.floatColumn(n, v);
      await sender.at(row.ts, "us");
    }
    await sender.flush();

    for (const row of rows) {
      sender.table(row.table).symbol("symbol", row.symbols[0][1]);
      for (const [n, v] of row.doubles) sender.floatColumn(n, v);
      await sender.at(row.ts, "us");
      const t0 = process.hrtime.bigint();
      await sender.flush();
      samples.push(Number(process.hrtime.bigint() - t0) / 1000); // microseconds
    }
  } finally {
    // Without this, a throw mid-loop leaks the sender and the SF barrier
    // timer keeps the process alive.
    await sender.close();
  }
  samples.sort((a, b) => a - b);
  return samples;
}

function report(label: string, runs: number[][]): void {
  console.log(`\n${label}`);
  for (const p of [50, 90, 99, 99.9]) {
    const vals = runs.map((s) => percentile(s, p));
    const lo = Math.min(...vals).toFixed(1);
    const hi = Math.max(...vals).toFixed(1);
    console.log(`  p${p}\t${lo} – ${hi} µs   (spread across ${runs.length} repeats)`);
  }
}

async function main(): Promise<void> {
  console.log(`QWP e2e latency — ${ADDR}, ${ROWS} rows, ${REPEATS} repeats per arm`);
  console.log("One server instance across both arms; no restart between them.\n");

  // SF off: flush() covers encode -> send -> server ACK.
  const sfOff: number[][] = [];
  for (let i = 0; i < REPEATS; i++) sfOff.push(await arm(`ws::addr=${ADDR};`));
  report("flush() = full server round-trip (sf off)", sfOff);

  // SF on: flush() returns once the row is durable locally. A DIFFERENT
  // contract, not a faster version of the same one.
  // A FRESH directory per run. Reusing a fixed path leaves slots behind, and
  // the next run's open() would recover those segments and replay stale frames
  // into the measurement — so run 2 would differ from run 1 for reasons that
  // have nothing to do with the code.
  const sfDir = mkdtempSync(join(SF_ROOT, "qwp-bench-e2e-"));
  console.log(`sf-on arm writing to ${sfDir}`);
  console.log(`  (check this is not tmpfs: df -T ${SF_ROOT})\n`);

  const sfOn: number[][] = [];
  try {
    for (let i = 0; i < REPEATS; i++) {
      sfOn.push(await arm(`ws::addr=${ADDR};sf_dir=${sfDir};sender_id=bench-${i};`));
    }
  } finally {
    rmSync(sfDir, { recursive: true, force: true });
  }
  report("flush() = local durability only (sf on)", sfOn);

  console.log(
    "\nThese two numbers answer different questions. sf-on is 'recoverable if I\n" +
      "crash now'; sf-off is 'the server has it'. Do not quote one as the other.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Start a server and run it**

```bash
docker run --rm -d -p 9000:9000 --name qwp-bench questdb/questdb:nightly
sleep 15
npx tsx benchmarks/e2e.ts
```

Expected: two blocks of percentiles, each with a spread across three repeats.

- [ ] **Step 3: Sanity-check the result before recording it**

- **sf-on should be faster than sf-off.** If not, either SF is not engaged (check `sf_dir` reached the transport) or the local write is pathologically slow (check the disk baseline from Task 7).
- **The spread across repeats should be narrow.** If p99 varies by more than roughly 2× between repeats, the machine is too noisy to quote — close other work and re-run rather than averaging the noise away.

- [ ] **Step 4: Tear down and commit**

```bash
docker rm -f qwp-bench
git add benchmarks/e2e.ts
git commit -m "bench: add end-to-end latency script for both flush contracts"
```

---

### Task 9: Document how to run it

**Files:**
- Create: `benchmarks/README.md`

- [ ] **Step 1: Write it**

````markdown
# QWP benchmarks

Ad hoc. No CI job, no gate. Run them when you want a number.

```bash
# Point this at REAL storage, not tmpfs — see "Am I measuring disk?" below.
export QWP_BENCH_DIR=/var/tmp/qwp-bench

pnpm bench                       # encoder, buffer, sf  (no server needed)
pnpm bench:e2e                   # needs QuestDB on :9000
QDB_ADDR=host:9000 pnpm bench:e2e
```

## Reading the output

**`hz` is callbacks per second, not rows per second.** Each encoder callback
covers 10,000 rows, so rows/s is `hz × 10_000`. This is the easiest way to
write down a number that is wrong by four orders of magnitude.

**`rme` is the relative margin of error.** Check it before believing a
difference: a 5% gap between two arms each carrying ±3% rme is not a result.

There is no p50 or p90 in `vitest bench` output. The e2e script computes its own
percentiles, which is why it is a separate script.

## Am I measuring disk?

`os.tmpdir()` is `/tmp` on most Linux boxes, and `/tmp` is frequently **tmpfs —
RAM**. If the SF benchmarks and the e2e sf-on arm run there, they measure memory
while claiming to measure disk, and the `dd` baseline reports an *excellent*
figure — so the guard confirms a false conclusion instead of catching it.

```bash
df -T "$QWP_BENCH_DIR"   # type must not be tmpfs
```

## Before you quote anything

1. **Check the disk line.** `sf.bench.ts` prints a `dd` figure first. If it is
   far below what the hardware should do, the SF numbers are meaningless —
   fix the machine, do not average around it.
2. **Check the spread.** `e2e.ts` runs every arm three times and prints a range.
   If p99 varies by more than about 2× across repeats, the machine is too busy.
3. **Do not mix the two e2e numbers.** With SF on, `flush()` returns once the
   row is durable *locally*. With SF off it waits for the *server*. They answer
   different questions and the SF-on number is not a faster version of the
   SF-off one.

## What the floors mean

`encoder.bench.ts` compares against hand-written baselines that do the minimum
byte movement — no null bitmap, no schema, no framing. The floor is not a
target. The gap between floor and encoder is what the protocol costs.

Both sides accumulate into a `sink` so neither can be optimised away. If the
encoder still beats its floor, the comparison itself is wrong — not dead-code
removal.

## What this suite does not cover

- **Gorilla's raw fallback.** Every workload has perfectly regular timestamps,
  so delta-of-delta is always 0 and the compressed path always wins. The
  fallback needs a delta-of-delta beyond signed int32 — about a 35-minute jump
  at microsecond resolution. `validate.test.ts` asserts the behaviour; these
  numbers say nothing about it.
- **Reconnect, replay and drainers.** Dominated by network and disk timing
  rather than client code, so a number there measures the environment.
- **Concurrency.** Single sender, single connection throughout.
````

- [ ] **Step 2: Commit**

```bash
git add benchmarks/README.md
git commit -m "docs: how to run the QWP benchmarks and how to read them"
```

---

## Self-Review

**1. Spec coverage**, checked clause by clause against the spec as it now stands:

| Spec | Task |
|---|---|
| §3 harness, two entry points | 3 |
| §4 five files and their reporting column | 3, 5, 6, 7, 8 |
| §5 four workloads incl. varchar in `wide` | 1 |
| §6 three floors | 2 |
| §7 guard 1 — write to real disk (`QWP_BENCH_DIR`) | 7, 8 |
| §7 guard 2 — `dd` baseline before results | 7 |
| §7 guard 3 — one server, both arms | 8 |
| §7 guard 4 — three repeats, report spread | 8 |
| §8 five assertions | 4 |
| §9 out of scope | honoured; nothing benchmarks reconnect, replay, drainers or concurrency |

No spec clause is unimplemented. The one that *was* — "SF append does not
dominate whole-flush cost" — was removed from the spec in the seventh pass
rather than turned into a task, because nothing here measures whole-flush cost
at a granularity that makes the ratio meaningful.

**2. Placeholder scan.** None. Task 4 Step 3 deliberately asks the implementer to
tighten the bytes/row bound *after* measuring — a real action, not a TODO — and
the spec now describes that wide-then-tighten approach rather than asserting an
unmeasured band.

**3. Type consistency.** `Row`/`Workload`/`WorkloadName`/`WORKLOADS` (Task 1) are
consumed in Tasks 4, 5, 6 and 8; `WORKLOADS` is keyed on the literal union so a
misspelled name fails to compile. `floorWriteLongs`/`floorInternSymbols` (Task 2)
are used in Task 5. Each bench file declares its own module-level `sink`, so the
two `_sink` exports do not collide. All `src/` imports were checked against the
shipped code and are listed under "Verified API surface".

**4. Cross-document consistency.** Every fact stated in more than one place —
`hz` versus rows/s, the tmpfs hazard, the assertion list, the bytes/row band, the
Gorilla scope limit — was reconciled across the spec, this plan and
`benchmarks/README.md` in the seventh pass. That class of drift accounted for
five of the defects found, because each correction has three homes and early
passes updated only one.

**Eighth review pass — re-read Tasks 5 and 6 after the fifth pass changed them,
and audited this Self-Review; six defects:**

25. **Neither the encoder nor its floor consumed its result**, so both could be
    optimised away — and unequally, which would produce a ratio that looks like a
    finding when the floor is eliminated and the encoder is not. The whole value
    of a floor is that the ratio is trustworthy. Every arm in Tasks 5 and 6 now
    accumulates into a module-level `sink`, built in rather than offered as a
    remedy after the fact.
26. **`Buffer` was imported and unused** in `encoder.bench.ts`; `pnpm eslint`
    would have flagged it.
27. **Task 5 encoded a different table name than Tasks 4 and 6** — it passed
    `WORKLOADS[name].name` (`"trades"`) while the others use `row.table`
    (`"bench_trades"`), so frame sizes differed between tasks measuring nominally
    the same workload. Now uses `rows[0].table` throughout.
28. **Task 6 pays a `bigint`→`number` conversion Task 5 does not**, because
    `intColumn` takes a `number` while the workloads carry `bigint`. Part of the
    gap between the two tasks is representation, not buffer overhead. Documented
    at `fill()`, with the note that all values sit well under 2^53 today and that
    raising `N` requires re-checking.
29. **The File Structure table and the README both said "four" assertions** after
    the fifth pass added a fifth.
30. **This Self-Review's coverage claim was a flat list** asserting "§8"
    wholesale — which is exactly how the missing SF-ratio assertion (defect 22)
    stayed hidden for six passes. It is now a clause-by-clause table, with a
    fourth check added for cross-document consistency, the class that produced
    five of the defects found.

**Seventh review pass — Task 9 and a spec↔plan sweep; five defects:**

20. **`benchmarks/README.md` was stale against six passes of fixes.** It is the
    artefact most likely to be read in isolation before someone quotes a number,
    and it mentioned none of: `QWP_BENCH_DIR`, that `hz` is not rows/s, `rme`,
    or the uncovered Gorilla fallback. All four now appear, with the tmpfs check
    given its own section.
21. **The spec promised output the harness does not produce.** §4 said the bench
    layers report "rows/s, bytes/s", "bytes/row" and "appends/s, µs/append".
    `vitest bench` emits `hz` and no bytes column at all. Corrected, with the
    conversion spelled out.
22. **A spec requirement had no implementing task.** §8 listed "SF append does
    not dominate whole-flush cost", which appears nowhere in Task 4 — and cannot
    meaningfully, since append and flush are benchmarked separately at different
    granularities. Dropped from the spec with the reason stated, rather than
    faked into a task.
23. **The spec's bytes/row band (40–80) contradicted the plan's (20–120)**, and
    neither had been measured. The spec now describes the wide-then-tighten
    approach instead of asserting a guessed figure.
24. **The spec's §8 list and the plan's assertions had diverged in both
    directions** — the spec omitted the gorilla-leak check and the new cold-delta
    guard; the plan omitted the SF-ratio claim. Reconciled to the five the plan
    actually implements. §5 and §7 also updated for the varchar family, the
    regular-timestamp scope limit, and the tmpfs guard.

**Sixth review pass — Tasks 7–9 line by line; six defects:**

14. **`tmpdir()` is frequently tmpfs, so the disk guard fails in the most
    reassuring direction.** Both the `dd` baseline and the SF benchmark default
    to the OS temp dir; on most Linux boxes that is `/tmp`, often RAM. The
    baseline would then report an *excellent* figure and every SF number would
    be a memory number — the guard actively confirming a false conclusion.
    Both Task 7 and Task 8 now honour `QWP_BENCH_DIR`, print the path they
    chose, and tell the reader to check `df -T`.
15. **Per-iteration engine creation made Task 7 measure the wrong thing.**
    `withEngine` put `acquireSlot`, recovery, a dict-fd open and a `setInterval`
    start *inside* the timed body — setup that dwarfs 100 appends, so the
    benchmark reported engine-open cost under an "append" label. Engines are
    now opened once in `beforeAll`, with `acknowledge(publishedFsn)` per
    iteration to keep trim running.
16. **The e2e sf-on arm contaminated its own reruns.** It wrote to a fixed
    `qwp-bench-e2e` path with per-repeat `sender_id`s and never cleaned up, so a
    second run's `open()` would recover the first run's segments and replay
    stale frames into the measurement. Now a fresh `mkdtemp` per run, removed in
    a `finally`.
17. **Warmup and measured rows were the same rows**, double-ingesting the first
    500 timestamps. Harmless for latency, but it breaks any row-count assertion
    added later. They are now disjoint slices.
18. **`arm()` had no `finally`**, so a throw mid-loop leaked the sender and left
    the SF barrier timer holding the process open.
19. **`WARMUP` was an inline literal** inside a `Math.min`, making the warmup
    size invisible at the top of the file where the other knobs live. Hoisted.

**Fifth review pass — read every code block; three defects, one of which
invalidated an earlier fix:**

11. **Priming the dictionary does not enable delta mode.** `confirmedMaxId` lives
    on the *buffer*, starts at `-1`, and only advances via
    `confirmDeltaPublished()` — which the transport's publish path calls, not
    `sealFrames()`. So a fresh `QwpBuffer` with a fully primed dict still ships
    every symbol, because `entriesFrom(-1 + 1)` returns everything. Both the
    Task 4 assertion and the Task 6 "primed" arm added in the second pass were
    therefore measuring the cold case while claiming to measure the steady
    state. Both now call `setConfirmedMaxId` as well, and Task 4 gains a
    guard test asserting that the cold case is *not* smaller — so if someone
    drops the baseline call again, a test fails instead of a number quietly
    getting worse.
12. **The Gorilla sanity check expected an impossible outcome.** Every workload
    uses `BASE_TS + i × 1000n`, so every delta-of-delta is 0 and Gorilla always
    takes the 1-bit path. The check told the reader to expect a raw fallback
    that needs a delta-of-delta beyond signed int32 — roughly a 35-minute jump
    at microsecond resolution, which no workload approaches. Rewritten, with an
    explicit statement that the fallback path is **not covered** by this suite.
13. **`WORKLOADS` was declared as a literal-keyed `Record` but implemented as
    `Record<string, Workload>`**, and Tasks 6 and 7 index it by name. The loose
    type makes a misspelled workload name a compile-time success and a runtime
    `undefined`. Now keyed on an exported `WorkloadName` union. `build()` in
    Task 4 also dropped the `strings` family, the same latent trap fixed in
    Tasks 5 and 6 last pass.

**Fourth review pass — structural, three further defects:**

8. **Validation ran last.** The assertions that check the wire format were Task 8,
   after every benchmark — so the implementer would have spent four tasks
   producing throughput numbers for code whose correctness was never checked. If
   null compaction were broken, every benchmark would have reported happily on
   wrong bytes. Validation depends only on Task 1's workloads, so it is now
   Task 4, ahead of all measurement. Tasks 4–7 shifted to 5–8 and every
   cross-reference was updated.
9. **`bench:e2e` invoked bare `tsx`.** `tsx` is deliberately not a dependency, so
   it is absent from `node_modules/.bin` and the script would have failed with
   "command not found" — while Task 8's manual command used `npx tsx` and worked,
   which would have made the failure look like a script-only problem.
10. **`beforeAll` in a `.bench.ts` file is unverified.** Task 7 depends on it for
    the temp directory and disk baseline. Now flagged as an assumption with the
    fallback (module scope) written down, rather than presented as fact.

**Third review pass — settled by actually running the harness.** A throwaway
probe against `vitest bench` 3.1.3 confirmed nested `describe` and async bodies
work, and turned up four things the plan had wrong or unstated: vitest warns that
benchmarking is experimental and asks for a pinned version (the repo had a caret
range); the reported columns include no p50 or p90; `hz` is callbacks per second
and reading it as rows/s understates by 10,000×; and `await Promise.resolve()`
alone costs ~1.4×, which is a real slice of the async `SfEngine.append` number.
All four are now recorded under "Harness facts", and Task 3 pins vitest.

**Second review pass — three further defects, fixed above:**

5. **The delta-dict benchmark measured nothing.** It built a fresh `SymbolDict`
   *inside* the bench body, so the dictionary was empty on every iteration and
   the delta carried every symbol string — the same work as full-dict. The case
   that matters is the steady state, where a confirmed dictionary lets a frame
   ship varint ids only. The dict is now primed outside the timed body, and both
   cold and primed arms are reported so the difference between them is visible.
6. **`arm()` took an unused `label` parameter**, which `pnpm eslint` would have
   flagged. Removed, with both call sites updated.
7. **The auto-flush interaction was undocumented.** `Sender.at()` awaits
   `tryFlush()`, so a flush can fire *outside* the timed window. The measurement
   is sound only because the script flushes every row, which keeps
   `pendingRowCount` at 1 and resets the interval each time. That is now stated
   at the function, with a warning that batching rows turns the samples into a
   bimodal mixture whose p50 is dominated by no-op flushes.

**First review pass — four defects found by checking this plan against the shipped code:**

1. **`SfEngine.open()` was never called** in Task 7. `append()` guards its write
   with `if (this.isDisk && this.slot)` and `slot` is set only by `open()`, so
   the "disk mode" arm would have silently measured memory mode and reported it
   under a disk label — precisely the class of wrong-but-plausible number this
   suite exists to prevent.
2. **`SfEngine.close()` was never called.** `open()` starts a `setInterval`
   durability barrier, so the bench process would hang after printing results.
3. **`benchmark` was placed at the top level of the vitest config.** It nests
   under `test`; at the top level it is silently ignored and `vitest bench` uses
   its default globs instead.
4. **The `strings` column family was dropped** by both `buildTable` (Task 5) and
   `fill` (Task 6), shrinking `wide` from the advertised 50 columns to 42 and
   removing varchar from the suite entirely.

**Async boundaries, checked against the shipped code:**

- **`Sender.at()` is `async`** (`src/sender.ts:451`) — auto-flush can trigger inside it — so Task 8's `await sender.at(...)` is correct.
- **`QwpBuffer.at()` is synchronous** (`src/qwp/buffer.ts:173`), so Task 6 calls it without `await`. Adding one there would cost a microtask tick per row and inflate the measurement.
- **`SfEngine.append` is `async`**, so Task 7's benchmarks are async and tinybench measures promise overhead alongside the append. That is the honest number for the caller, but it means memory-mode append cannot be compared against a synchronous floor — hence no floor for that family.

**One thing that cannot be settled without running:** the real bytes/row for `trades`. Task 4 ships a deliberately wide 20–120 band and Step 3 tightens it around the measured value. Until that step runs, the assertion catches only gross breakage.

**One deliberate omission.** No benchmark of the reconnect, replay, or drainer paths. They are dominated by network and disk timing rather than client code, so a number there measures the environment, not the implementation.

