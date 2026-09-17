# QWP benchmarks

These benchmarks are diagnostic tools, not CI performance gates. Run them on a
quiet, pinned machine and compare commits on the same host.

```bash
# Encoder, high-level sender, egress, and store-and-forward benchmarks.
pnpm bench

# Live QuestDB on localhost:9000.
pnpm bench:e2e

# Override the live server and sample sizes.
QDB_ADDR=host:9000 BENCH_ROWS=10000 pnpm bench:e2e

# Use real storage for persistence measurements.
QWP_BENCH_DIR=/var/tmp/qwp-bench pnpm bench

pnpm typecheck:bench
pnpm lint:bench
pnpm format:bench
pnpm vitest run benchmarks/*.test.ts
```

Set `QWP_BENCH_DURABLE_ACK=1` for an additional live durable-ACK arm. The
server must advertise durable acknowledgements. The default E2E run measures
local WebSocket publication, protocol ACK, and local store-and-forward append
as separate completion contracts.

## Workloads

- `trades`: one low-cardinality symbol, two doubles, and a designated timestamp.
- `wide`: 50 data columns across symbol, long, double, and varchar families.
- `sparse`: eight potential long columns with deterministic 30% nulls.
- `highCardinalitySymbols`: one distinct symbol per row up to 100,000 values.

All workloads use a deterministic xorshift generator. Encoder floors perform
only the minimum int64, UTF-8, or `Map` work, without QWP schema, null, or frame
overhead. They are comparison baselines, not performance targets.

## Reading Vitest output

Vitest reports benchmark callbacks per second (`hz`):

- encoder and sender callbacks process 10,000 rows;
- materialized/view egress callbacks process 10,000 rows;
- the compressed egress callback processes 100 rows;
- persistence append callbacks write 100 4 KiB frames.

Multiply `hz` by the corresponding unit count before reporting rows or appends
per second. Check `rme` before treating small differences as meaningful.

The persistence suite prints a 256 MiB write-and-fsync baseline. It benchmarks
all three file-store policies:

- `memory`: file writes relying on operating-system page-cache writeback;
- `periodic`: file writes plus background checkpoints;
- `append`: a persistence barrier after every frame.

It also measures full recovery of 1,000 frame references and lazy 4 KiB payload
reads. Segment rolls, hot-spare provisioning, checkpoint timers, and background
trimming can make the distribution bimodal. Report percentiles or the complete
distribution rather than only its mean.

Each append callback also acknowledges its preceding prefix, retaining one live
record so the journal remains in steady state without exhausting its configured
capacity. The reported number therefore includes normal ACK bookkeeping and trim
scheduling.

Confirm that `QWP_BENCH_DIR` is not tmpfs before describing any result as disk
performance. The directory and the baseline must live on the same filesystem.

## E2E completion boundaries

The live benchmark flushes every measured row so each sample contains a real
completion boundary. Its arms are deliberately not interchangeable:

- local publication means the WebSocket accepted the frame;
- protocol ACK means QuestDB accepted the frame;
- local SF append means the frame crossed the configured local persistence
  boundary;
- optional durable ACK means the server reported durable upload.

Each repetition uses a disjoint timestamp range. Store-and-forward repetitions
also use distinct sender IDs so recovered dictionaries and replay slots do not
turn later repetitions into warm-recovery measurements.
