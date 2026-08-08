# QWP Node client benchmarks — design

Date: 2026-08-08
Status: approved, ready for implementation planning
Target repo: `questdb/nodejs-questdb-client`

## 1. Goal

A TypeScript benchmark suite that **validates the QWP implementation** — does the
encoder perform sensibly against a hand-written floor, what does store-and-forward
append cost in memory versus on disk, and does end-to-end flush latency look like
a working client. Ported in spirit from the Java and Rust client benchmarks.

Note the SF question is deliberately narrow: this suite measures append cost, not
what fraction of a whole flush SF represents. §8 explains why that ratio is not
asserted.

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
| `benchmarks/encoder.bench.ts` | `writeColumn`, `encodeFrame`, gorilla, `SymbolDict` | `hz`, ×floor |
| `benchmarks/buffer.bench.ts` | `QwpBuffer` builder chain → `sealFrames` | `hz` |
| `benchmarks/sf.bench.ts` | `SfEngine.append`, `scanSegment` | `hz` |
| `benchmarks/e2e.ts` | `.at()` + `flush()` vs live QuestDB | p50/p90/p99/p99.9 |
| `benchmarks/validate.test.ts` | wire-format invariants (§8) | pass/fail |

**On the reporting column.** `vitest bench` emits `hz, min, max, mean, p75, p99,
p995, p999, rme, samples` — and `hz` is **callback invocations per second**, not
rows per second. With a 10,000-row workload per callback, rows/s is `hz × 10_000`.
There is no bytes/s column and no p50 or p90; the e2e script computes its own
percentiles, which is why it is a standalone script rather than a bench file. An
earlier draft of this spec claimed rows/s and bytes/s directly, which the harness
does not produce.

## 5. Workloads

Hardcoded TypeScript objects in `benchmarks/workloads.ts`. Four shapes, chosen so
each stresses a different part of the encoder:

| Name | Shape | Stresses |
|---|---|---|
| `trades` | 1 symbol, 2 doubles, ts | the realistic default |
| `wide` | 50 data columns: 1 symbol, 20 long, 20 double, **9 varchar**, + ts | per-column overhead, schema writing, varchar |
| `highCardSymbol` | 100k distinct symbols | dictionary growth, delta vs full-dict |
| `sparse` | 8 columns, 30% nulls | null bitmap and value compaction |

The column families are spelled out deliberately. A row builder that handles
only symbols, longs and doubles silently shrinks `wide` to 42 columns and drops
varchar from the suite entirely — a mistake made twice while drafting the plan.

Rows are deterministic: `trades`, `wide` and `sparse` use a seeded xorshift,
`highCardSymbol` needs no randomness at all. Two runs on the same machine
therefore compare like with like.

**Timestamps are regularly spaced in every workload**, which means Gorilla always
takes its 1-bit delta-of-delta path and the raw fallback is never exercised. That
is a deliberate scope limit, recorded here so nobody reads these numbers as
covering it; §8 asserts the fallback's correctness instead.

## 6. Floors

| Benchmark | Floor |
|---|---|
| fixed-width column write | `buf.writeBigInt64LE` in a bare loop |
| varchar column write | `buf.write(s, o, "utf8")` in a bare loop |
| symbol intern | naive per-row `Map.get`/`set` |

The floor is not a target — it ignores null bitmaps, schema and framing. It
bounds how much of the measured time is protocol work versus raw byte movement.

An earlier draft listed a fourth, "whole-frame encode = sum of the per-column
floors". It is dropped: summing floors ignores the schema, table header and
null bitmaps that a whole frame must also write, so the ratio would flatter the
encoder by comparing it against a baseline that does strictly less work. The
three above are each measured against a column the encoder genuinely writes.

## 7. Methodology guards

Ad-hoc runs are where numbers go wrong. Four guards are part of the suite, not
advice in a README.

**Write somewhere that is actually a disk.** `os.tmpdir()` is `/tmp` on most
Linux boxes and `/tmp` is frequently **tmpfs — RAM**. Both `sf.bench.ts` and the
e2e sf-on arm would then measure memory while claiming to measure disk. This is
the worst kind of failure because it is *self-confirming*: the `dd` baseline
reports an excellent figure, so the guard below appears to pass. Both entry
points therefore honour `QWP_BENCH_DIR`, print the path they chose, and tell the
reader to check `df -T`.

**Disk baseline before SF results.** `sf.bench.ts` writes real files, and storage
benchmarks on a degraded or untrimmed SSD can read an order of magnitude slow.
The script prints a one-line `dd` throughput figure **before** its results, so an
implausible number is visible rather than silently quoted. Note this guard only
means something once the guard above is satisfied.

**One server, both arms, in `e2e.ts`.** The SF-on and SF-off arms run against a
single server instance with no restart between them. Restarting per arm makes the
first arm pay cold-start costs and turns a methodology artefact into an apparent
result.

The arms do, however, write to **separate tables**. Sharing one would let the
second arm ingest into a table already holding the first arm's rows — an
asymmetry the single-server guard is meant to remove, not introduce.

**Repeat before believing.** Every e2e arm runs 3× and the script reports the
spread across repeats, not a single number. A lone outlier cannot masquerade as a
finding.

## 8. Validation assertions

What makes this "validate the code" rather than "produce numbers". **Six**
assertions live in a single file, `benchmarks/validate.test.ts`, and run under `pnpm test` rather
than `pnpm bench` — they are correctness checks expressed through the benchmark
workloads. They run **before** any measurement task, so nobody spends four tasks
benchmarking code whose correctness was never checked.

- **bytes/row is plausible** — `trades` encodes within a band. The band ships
  deliberately wide (20–120) and is tightened around the measured value once the
  test first runs; a guessed band catches nothing, and an earlier draft of this
  spec asserted 40–80 without having measured anything.
- **compaction actually compacts** — on `sparse`, the encoded payload is
  materially smaller than the equivalent all-non-null shape. If not, nulls are
  being written as placeholder slots (design spec 6.2.1).
- **delta beats full-dict on high cardinality** — on `highCardSymbol`, a frame
  with a populated dictionary *and* a confirmed baseline emits fewer bytes than
  full-dict (design spec 5.2).
- **a cold delta batch is NOT smaller** — the guard for the above. Priming the
  dictionary without advancing `confirmedMaxId` still ships every symbol string,
  so this asserts the cold case does not win. Without it, dropping the baseline
  call degrades a number silently instead of failing a test.
- **the gorilla flag does not leak** — a LONG column encodes identically with the
  flag on and off. Gorilla applies to TIMESTAMP only.
- **gorilla actually compresses** — a regularly spaced TIMESTAMP column encodes
  to under half its uncompressed size. Without this the suite would assert only
  that gorilla does *nothing* to LONG, and would pass with an encoder that never
  compressed anything.

**Deliberately not asserted: "SF append does not dominate whole-flush cost."**
An earlier draft listed it, but nothing in this suite measures whole-flush cost
in a way that makes the ratio meaningful — `SfEngine.append` and `Sender.flush()`
are benchmarked separately and at different granularities. Asserting a ratio
across two unrelated measurements would be a number without a meaning, so it is
dropped rather than faked.

## 9. Out of scope

- Cross-language harness reuse (revisit only if the numbers here justify it).
- A workload manifest format. Workloads are TypeScript.
- **Memory and GC profiling — entirely.** `vitest bench` reports no GC
  information at all, so unlike Java's `GCProfiler` arm (§2) this suite has zero
  visibility into allocation pressure. That is a real gap rather than a
  simplification: allocation churn is a plausible cause of Node encoder slowness
  and nothing here would show it. Reach for `--cpu-prof` or `--heap-prof`
  separately if a number looks wrong and the floors do not explain it.
- Multi-connection or concurrency benchmarks.
- **Gorilla's raw fallback** — see §5; every workload has regular timestamps, so
  the fallback never fires. §8 asserts its correctness instead.
