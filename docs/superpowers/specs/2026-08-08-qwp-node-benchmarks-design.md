# QWP Node client benchmarks — design

Date: 2026-08-08
Status: approved, ready for implementation planning
Target repo: `questdb/nodejs-questdb-client`

## 1. Goal

A TypeScript benchmark suite that **validates the QWP implementation** — does the
encoder perform sensibly, does store-and-forward add what we expect, does
end-to-end latency look like a working client. Ported in spirit from the Java and
Rust client benchmarks.

Run **ad hoc**. No CI job, no PR gate, no nightly. The consumer is a developer
asking "is this fast enough, and did my change hurt it".

### 1.1 Non-goals

- Publishable Node-vs-Java-vs-Rust comparisons. Cross-language numbers need
  matched harnesses and controlled machines; nothing here licenses that claim.
- Automated regression gating.
- Benchmarking the query client, the facade, or ILP. QWP ingest only.

## 2. What the reference clients measure

Two deliberately different philosophies, both worth porting:

| | Java `QwpIngressLatencyBenchmark` | Rust `benches/column_sender.rs` |
|---|---|---|
| Harness | JMH + `GCProfiler` | criterion |
| Measures | **latency** of `.at() + flush()` | **throughput**, rows/s and bytes/s |
| Server | live QuestDB (9000 + 8812) | none — encoder only |
| Reports | `SampleTime` p50/p90/p99/p99.9 **and** `AverageTime` | each family against a hand-written floor |

Java also ships two SF micro-benchmarks — `CursorEngineAppendLatencyBenchmark`
and `SegmentManagerPassBarrierBenchmark` — which map onto our `sf/engine.ts` and
`sf/segment.ts`.

Two ideas are worth taking wholesale:

**Rust's floors.** Every family is measured against a hand-written baseline: raw
`extend_from_slice` for column append, a naive per-row HashMap for symbol
interning. A result then reads "within N× of the floor" rather than as a bare
number that tells you nothing about headroom.

**Java's two contracts.** With SF on, `flush()` returns once the row is durable
on the local segment — the number to quote when the app's contract is "the row is
recoverable if I crash now". With SF off, `flush()` covers the full encode → send
→ ACK round-trip. Java ships both because they answer different questions;
conflating them is the easiest way to misreport.

## 3. Harness

`vitest bench` for the three pure layers. Vitest 3.1.3 is already a
devDependency and uses tinybench underneath, so **no new tooling**. A standalone
script for end-to-end, because it needs a live server and reports percentiles
rather than ops/s.

```
pnpm bench       # vitest bench — encoder, buffer, sf
pnpm bench:e2e   # node benchmarks/e2e.ts — needs QuestDB on :9000
```

## 4. Layers

| File | Layer | Reports |
|---|---|---|
| `benchmarks/workloads.ts` | shared fixtures | — |
| `benchmarks/encoder.bench.ts` | `writeColumn`, `encodeFrame`, gorilla, `SymbolDict` | rows/s, bytes/s, ×floor |
| `benchmarks/buffer.bench.ts` | `QwpBuffer` builder chain → `sealFrames` | rows/s, bytes/row |
| `benchmarks/sf.bench.ts` | `SfEngine.append`, `scanSegment` | appends/s, µs/append |
| `benchmarks/e2e.ts` | `.at()` + `flush()` vs live QuestDB | p50/p90/p99/p99.9 |

## 5. Workloads

Hardcoded TypeScript objects in `benchmarks/workloads.ts`. Four shapes, chosen so
each stresses a different part of the encoder:

| Name | Shape | Stresses |
|---|---|---|
| `trades` | 1 symbol, 2 doubles, ts | the realistic default |
| `wide` | 50 mixed columns | per-column overhead, schema writing |
| `highCardSymbol` | 100k distinct symbols | dictionary growth, delta vs full-dict |
| `sparse` | 8 columns, 30% nulls | null bitmap and value compaction |

Each workload is a generator producing deterministic rows from a fixed seed, so
two runs on the same machine compare like with like.

## 6. Floors

| Benchmark | Floor |
|---|---|
| fixed-width column write | `buf.writeBigInt64LE` in a bare loop |
| varchar column write | `buf.write(s, o, "utf8")` in a bare loop |
| symbol intern | naive per-row `Map.get`/`set` |
| whole-frame encode | sum of the per-column floors |

The floor is not a target — it ignores null bitmaps, schema and framing. It
bounds how much of the measured time is protocol work versus raw byte movement.

## 7. Methodology guards

Ad-hoc runs are where numbers go wrong. Three guards are part of the suite, not
advice in a README.

**Disk baseline before SF results.** `sf.bench.ts` writes real files, and storage
benchmarks on a degraded or untrimmed SSD can read an order of magnitude slow.
The script prints a one-line `dd` throughput figure **before** its results, so an
implausible number is visible rather than silently quoted.

**One server, both arms, in `e2e.ts`.** The SF-on and SF-off arms run against a
single server instance with no restart between them. Restarting per arm makes the
first arm pay cold-start costs and turns a methodology artefact into an apparent
result.

**Repeat before believing.** Every e2e arm runs 3× and the script reports the
spread across repeats, not a single number. A lone outlier cannot masquerade as a
finding.

## 8. Validation assertions

What makes this "validate the code" rather than "produce numbers". Each
benchmark file asserts an invariant and fails loudly if it breaks:

- **bytes/row is plausible** — `trades` encodes to 40–80 bytes/row. Well under
  means values are being dropped; well over means framing overhead has regressed.
- **SF append does not dominate** — in memory mode, `SfEngine.append` is a small
  fraction of whole-flush cost. If it dominates, the ring is doing more work than
  publishing a buffer should.
- **delta beats full-dict on high cardinality** — on `highCardSymbol`, delta mode
  emits strictly fewer bytes than full-dict after the first frame. If not, the
  delta baseline is not advancing (spec 5.2).
- **compaction actually compacts** — on `sparse`, the encoded column payload is
  smaller than the equivalent all-non-null column. If not, nulls are being
  written as placeholder slots (spec 6.2.1).

These are the cheapest possible check that the wire-format rules the design spec
spent most of its length on are actually holding at runtime.

## 9. Out of scope

- Cross-language harness reuse (revisit only if the numbers here justify it).
- A workload manifest format. Workloads are TypeScript.
- Memory/GC profiling beyond what tinybench reports.
- Multi-connection or concurrency benchmarks.
