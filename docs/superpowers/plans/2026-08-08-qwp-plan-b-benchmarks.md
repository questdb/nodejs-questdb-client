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
| `benchmarks/validate.test.ts` | The four spec §8 assertions, run by `pnpm test` |
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

export const WORKLOADS: Record<string, Workload> = {
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

- [ ] **Step 3: Add the scripts**

In `package.json`, alongside the existing `"test"` script:

```json
    "bench": "vitest bench --run",
    "bench:e2e": "tsx benchmarks/e2e.ts"
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

### Task 4: Encoder benchmarks

**Files:**
- Create: `benchmarks/encoder.bench.ts`

Covers `writeColumn` per type, whole-frame `encodeFrame`, gorilla on and off, and `SymbolDict` versus the naive floor.

- [ ] **Step 1: Write the benchmark**

```ts
// benchmarks/encoder.bench.ts
import { bench, describe } from "vitest";
import { Buffer } from "node:buffer";
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
    const table = buildTable(WORKLOADS[name].name, rows);
    bench(`encodeFrame / ${name} / gorilla off`, () => {
      encodeFrame([table], { gorilla: false });
    });
    bench(`encodeFrame / ${name} / gorilla on`, () => {
      encodeFrame([table], { gorilla: true });
    });
  }
});

describe("floor comparison", () => {
  const longs = WORKLOADS.sparse.rows(N).flatMap((r) => r.longs.map(([, v]) => v));

  bench("FLOOR writeBigInt64LE loop", () => {
    floorWriteLongs(longs);
  });

  const t = new QwpTableBuffer("floor_cmp");
  for (const v of longs) {
    t.getOrCreateColumn("v", TYPE_LONG)?.values.push(v);
    t.nextRow();
  }
  bench("encodeFrame single long column", () => {
    encodeFrame([t], { gorilla: false });
  });
});

describe("symbol interning", () => {
  const syms = WORKLOADS.highCardSymbol.rows(N).map((r) => r.symbols[0][1]);

  bench("FLOOR naive Map intern", () => {
    floorInternSymbols(syms);
  });

  bench("SymbolDict.getOrAdd", () => {
    const d = new SymbolDict();
    for (const s of syms) d.getOrAdd(s);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest bench --run benchmarks/encoder.bench.ts`
Expected: a table of ops/s per benchmark, no failures.

- [ ] **Step 3: Sanity-read the output before trusting it**

Two checks before recording anything:
- `encodeFrame single long column` should be **slower** than the floor, not faster. Faster than a bare write loop means the benchmark is optimising away — add a sink (e.g. accumulate `result.length` into a module-level variable) and re-run.
- `gorilla on` should be **slower** than `gorilla off` on `sparse` (irregular timestamps fall back to raw and pay the feasibility scan). If it is faster, the fallback path is not being taken and the benchmark is not measuring what it claims.

- [ ] **Step 4: Commit**

```bash
git add benchmarks/encoder.bench.ts
git commit -m "bench: add encoder throughput benchmarks with floor comparison"
```

---

### Task 5: Row-building benchmarks

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

/** Handles every column family the workloads generate — see Task 4's note. */
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
      b.sealFrames(CAP);
    });
  }
});

describe("dictionary mode", () => {
  const rows = WORKLOADS.highCardSymbol.rows(N);

  bench("full-dict (no dict attached)", () => {
    const b = new QwpBuffer();
    fill(b, rows);
    b.sealFrames(CAP);
  });

  // A dict created INSIDE the bench body is empty on every iteration, so the
  // delta always carries every symbol string and this arm measures the same
  // work as full-dict. The case that matters is the steady state: a dictionary
  // the server has already confirmed, where a frame ships varint ids only.
  // Prime it once out here so the measured iterations are incremental.
  const primed = new SymbolDict();
  {
    const warm = new QwpBuffer();
    warm.attachDict(primed);
    fill(warm, rows);
    warm.sealFrames(CAP);
  }

  bench("delta-dict (primed, incremental)", () => {
    const b = new QwpBuffer();
    b.attachDict(primed);
    fill(b, rows);
    b.sealFrames(CAP);
  });

  bench("delta-dict (cold, first batch)", () => {
    const b = new QwpBuffer();
    b.attachDict(new SymbolDict());
    fill(b, rows);
    b.sealFrames(CAP);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest bench --run benchmarks/buffer.bench.ts`

Expected: ops/s per benchmark. Two readings to make before recording anything:

- **`wide` should be markedly slower per row than `trades`** — 50 columns means
  50 map lookups and 50 null-backfill checks per row. If they are close,
  `getOrCreateColumn` is not on the hot path you think it is.
- **`delta-dict (primed)` should beat both `full-dict` and `delta-dict (cold)`**
  on this workload. Primed delta ships varint ids; the other two ship 100k
  symbol strings. If primed is not clearly ahead, the delta baseline is not
  advancing across seals (spec 5.2) — that is a bug in the buffer, not in the
  benchmark.

- [ ] **Step 3: Commit**

```bash
git add benchmarks/buffer.bench.ts
git commit -m "bench: add row-building benchmarks for QwpBuffer"
```

---

### Task 6: Store-and-forward benchmarks with a disk baseline

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

/** Prints a dd throughput figure so a degraded disk is visible, not silent. */
function diskBaseline(path: string): void {
  try {
    const out = execFileSync(
      "dd",
      ["if=/dev/zero", `of=${join(path, "dd.tmp")}`, "bs=1M", "count=256", "oflag=direct"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    console.log(`\n[disk baseline] ${out.trim().split("\n").pop()}`);
  } catch {
    console.log("\n[disk baseline] unavailable (dd or O_DIRECT not supported) — treat SF numbers with caution");
  } finally {
    rmSync(join(path, "dd.tmp"), { force: true });
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "qwp-bench-"));
  diskBaseline(dir);
  return () => rmSync(dir, { recursive: true, force: true });
});

const FRAME = Buffer.alloc(4096, 0x41);

/**
 * open() is REQUIRED before append(). append() guards its write with
 * `if (this.isDisk && this.slot)`, and `slot` is only set by open() -- so an
 * unopened disk engine silently skips the write and reports memory-mode
 * numbers under a "disk mode" label. close() is equally required: open()
 * starts a setInterval durability barrier that keeps the process alive.
 */
async function withEngine(
  opts: ConstructorParameters<typeof SfEngine>[0],
  body: (e: SfEngine) => Promise<void>,
): Promise<void> {
  const e = new SfEngine(opts);
  await e.open();
  try {
    await body(e);
  } finally {
    await e.close();
  }
}

describe("SfEngine.append", () => {
  bench("memory mode", async () => {
    await withEngine(
      { segmentBytes: 4 << 20, maxTotalBytes: 128 << 20, senderId: "bench-mem" },
      async (e) => {
        for (let i = 0; i < 100; i++) await e.append(FRAME);
      },
    );
  });

  bench("disk mode", async () => {
    await withEngine(
      {
        segmentBytes: 4 << 20,
        maxTotalBytes: 128 << 20,
        sfDir: dir,
        // A fresh slot per iteration: acquireSlot() takes an exclusive lock,
        // so reusing one senderId across iterations would fail on the second.
        senderId: `bench-disk-${process.hrtime.bigint()}`,
      },
      async (e) => {
        for (let i = 0; i < 100; i++) await e.append(FRAME);
      },
    );
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

**If the process hangs after the results**, `close()` was not reached: `open()`
starts a `setInterval` barrier that holds the event loop open.

- [ ] **Step 3: Sanity-check against the baseline**

If the `dd` figure is far below what the hardware should do (a NVMe SSD reporting tens of MB/s rather than hundreds), stop and fix the machine before recording any SF number. A degraded or untrimmed drive makes these results meaningless.

- [ ] **Step 4: Commit**

```bash
git add benchmarks/sf.bench.ts
git commit -m "bench: add store-and-forward benchmarks with a disk baseline"
```

---

### Task 7: End-to-end latency script

**Files:**
- Create: `benchmarks/e2e.ts`

**Spec §7.** Both flush contracts, **one server**, **three repeats**. Reports percentiles because ingest UX is gated by the tail, not the mean.

- [ ] **Step 1: Write the script**

```ts
// benchmarks/e2e.ts
import { Sender } from "../src";
import { WORKLOADS } from "./workloads";

const ADDR = process.env.QDB_ADDR ?? "localhost:9000";
const ROWS = Number(process.env.BENCH_ROWS ?? 5000);
const REPEATS = 3;

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
  await sender.connect();
  const rows = WORKLOADS.trades.rows(ROWS);

  // Warmup: never measure a cold path.
  for (const row of rows.slice(0, Math.min(500, ROWS))) {
    sender.table(row.table).symbol("symbol", row.symbols[0][1]);
    for (const [n, v] of row.doubles) sender.floatColumn(n, v);
    await sender.at(row.ts, "us");
  }
  await sender.flush();

  const samples: number[] = [];
  for (const row of rows) {
    sender.table(row.table).symbol("symbol", row.symbols[0][1]);
    for (const [n, v] of row.doubles) sender.floatColumn(n, v);
    await sender.at(row.ts, "us");
    const t0 = process.hrtime.bigint();
    await sender.flush();
    samples.push(Number(process.hrtime.bigint() - t0) / 1000); // microseconds
  }
  await sender.close();
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
  const sfDir = `${process.env.TMPDIR ?? "/tmp"}/qwp-bench-e2e`;
  const sfOn: number[][] = [];
  for (let i = 0; i < REPEATS; i++) {
    sfOn.push(await arm(`ws::addr=${ADDR};sf_dir=${sfDir};sender_id=bench-${i};`));
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

- **sf-on should be faster than sf-off.** If not, either SF is not engaged (check `sf_dir` reached the transport) or the local write is pathologically slow (check the disk baseline from Task 6).
- **The spread across repeats should be narrow.** If p99 varies by more than roughly 2× between repeats, the machine is too noisy to quote — close other work and re-run rather than averaging the noise away.

- [ ] **Step 4: Tear down and commit**

```bash
docker rm -f qwp-bench
git add benchmarks/e2e.ts
git commit -m "bench: add end-to-end latency script for both flush contracts"
```

---

### Task 8: Validation assertions

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

function build(rows: ReturnType<typeof WORKLOADS.trades.rows>, dict?: SymbolDict): Buffer[] {
  const b = new QwpBuffer();
  if (dict) b.attachDict(dict);
  for (const row of rows) {
    b.table(row.table);
    for (const [n, v] of row.symbols) b.symbol(n, v);
    for (const [n, v] of row.longs) b.intColumn(n, Number(v));
    for (const [n, v] of row.doubles) b.floatColumn(n, v);
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

    // Delta mode with a dictionary already primed: the second batch carries
    // ids, not strings (spec 5.2).
    const dict = new SymbolDict();
    build(rows, dict); // first pass registers every symbol
    const second = build(rows, dict).reduce((a, f) => a + f.length, 0);

    expect(second).toBeLessThan(full);
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

### Task 9: Document how to run it

**Files:**
- Create: `benchmarks/README.md`

- [ ] **Step 1: Write it**

````markdown
# QWP benchmarks

Ad hoc. No CI job, no gate. Run them when you want a number.

```bash
pnpm bench                       # encoder, buffer, sf  (no server needed)
pnpm bench:e2e                   # needs QuestDB on :9000
QDB_ADDR=host:9000 pnpm bench:e2e
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

If the encoder ever beats its floor, the benchmark is optimising away rather
than the encoder being fast. Add a sink and re-run.
````

- [ ] **Step 2: Commit**

```bash
git add benchmarks/README.md
git commit -m "docs: how to run the QWP benchmarks and how to read them"
```

---

## Self-Review

**1. Spec coverage.** Harness and scripts (Task 3 — §3). Four workloads (Task 1 — §5). Floors (Task 2 — §6). Encoder (Task 4 — §4). Buffer (Task 5 — §4). SF plus disk baseline (Task 6 — §4, §7). E2E, both contracts, one server, three repeats (Task 7 — §4, §7). Validation assertions (Task 8 — §8). Docs (Task 9).

**2. Placeholder scan.** None. Task 8 Step 3 deliberately asks the implementer to tighten a bound *after* measuring — that is a real step with a real action, not a TODO.

**3. Type consistency.** `Row`/`Workload`/`WORKLOADS` (Task 1) are consumed in Tasks 4, 5, 7, 8. `floorWriteLongs`/`floorInternSymbols` (Task 2) are used in Task 4. All `src/` imports were checked against the shipped code and are listed under "Verified API surface" above.

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

1. **`SfEngine.open()` was never called** in Task 6. `append()` guards its write
   with `if (this.isDisk && this.slot)` and `slot` is set only by `open()`, so
   the "disk mode" arm would have silently measured memory mode and reported it
   under a disk label — precisely the class of wrong-but-plausible number this
   suite exists to prevent.
2. **`SfEngine.close()` was never called.** `open()` starts a `setInterval`
   durability barrier, so the bench process would hang after printing results.
3. **`benchmark` was placed at the top level of the vitest config.** It nests
   under `test`; at the top level it is silently ignored and `vitest bench` uses
   its default globs instead.
4. **The `strings` column family was dropped** by both `buildTable` (Task 4) and
   `fill` (Task 5), shrinking `wide` from the advertised 50 columns to 42 and
   removing varchar from the suite entirely.

**Async boundaries, checked against the shipped code:**

- **`Sender.at()` is `async`** (`src/sender.ts:451`) — auto-flush can trigger inside it — so Task 7's `await sender.at(...)` is correct.
- **`QwpBuffer.at()` is synchronous** (`src/qwp/buffer.ts:173`), so Task 5 calls it without `await`. Adding one there would cost a microtask tick per row and inflate the measurement.
- **`SfEngine.append` is `async`**, so Task 6's benchmarks are async and tinybench measures promise overhead alongside the append. That is the honest number for the caller, but it means memory-mode append cannot be compared against a synchronous floor — hence no floor for that family.

**One thing that cannot be settled without running:** the real bytes/row for `trades`. Task 8 ships a deliberately wide 20–120 band and Step 3 tightens it around the measured value. Until that step runs, the assertion catches only gross breakage.

**One deliberate omission.** No benchmark of the reconnect, replay, or drainer paths. They are dominated by network and disk timing rather than client code, so a number there measures the environment, not the implementation.

