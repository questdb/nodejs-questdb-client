# QWP benchmarks

Ad hoc. No CI job, no gate. Run them when you want a number.

```bash
# Point this at REAL storage, not tmpfs — see "Am I measuring disk?" below.
export QWP_BENCH_DIR=/var/tmp/qwp-bench

pnpm bench                       # encoder, buffer, sf  (no server needed)
pnpm bench:e2e                   # needs QuestDB on :9000
QDB_ADDR=host:9000 pnpm bench:e2e

pnpm typecheck:bench             # tsc over src + benchmarks
pnpm lint:bench                  # eslint over benchmarks/
```

**If `pnpm <script>` fails before running anything**, that is this repo's
ignored-builds check, not your benchmark. Every earlier QWP handoff hit it. Call
the binary directly instead — the scripts above are still the canonical
definitions, and they work wherever the gate is satisfied:

```bash
./node_modules/.bin/vitest bench --run benchmarks/          # pnpm bench
./node_modules/.bin/tsx benchmarks/e2e.ts                   # pnpm bench:e2e
./node_modules/.bin/tsc -p tsconfig.bench.json --noEmit     # pnpm typecheck:bench
```

## Reading the output

**`hz` is callbacks per second, not rows per second.** Each encoder callback
covers 10,000 rows, so rows/s is `hz × 10_000`. This is the easiest way to
write down a number that is wrong by four orders of magnitude.

**The disk arm spikes every tenth iteration, and that is real.** `APPENDS × 4 KiB
= 400 KiB` per iteration against `segmentBytes: 4 << 20`, so a segment roll fires
on roughly every 10th body. A roll closes the active fd, creates the next `.sfa`,
writes its header, and rewrites the whole 8 KiB `sf-manifest.bin` (`persistManifest`
in `sf/engine.ts`, added by the C2 work in handoff 8 — *after* this plan was first
drafted). At the default durability there is no `fsync` on that path, so the spike
is syscalls and a file creation rather than a device round-trip. Read **p75 as
steady-state append cost** and `max`/`p999` as roughly the cost of a roll: a
bimodal distribution here is the benchmark working, not noise or GC.

It also means **the memory arm is not the disk arm minus the disk.** Memory mode
never reaches `persistFrame`, so it never rolls and never writes a manifest — the
gap between the two arms is segment management *plus* writing, not writing alone.
Don't quote the ratio as "the cost of durability".

**`rme` is the relative margin of error.** Check it before believing a
difference: a 5% gap between two arms each carrying ±3% rme is not a result.

There is no p50 or p90 in `vitest bench` output. The e2e script computes its own
percentiles, which is why it is a separate script.

**sf-on is not always faster than sf-off.** `e2e.ts` runs the two flush
contracts on one server, and the SF engagement is real (the slot dir gets a
`.sfa` + `sf-manifest.bin`). On a same-host server the localhost round-trip can
be *faster* than a disk-backed append, so sf-on can legitimately come out
slower — check that SF is engaged (slot files appear) and the disk baseline is
sane before reading anything into the sign of the gap. They answer different
questions regardless: sf-on is "recoverable if I crash now"; sf-off is "the
server has it". Do not quote one as the other.

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
removal. (A flat LONG column lands *at* its floor by design: the encoder uses
the same `writeBigInt64LE` primitive, so near-parity is the correct result.)

## What this suite does not cover

- **Gorilla's raw fallback.** Every workload has perfectly regular timestamps,
  so delta-of-delta is always 0 and the compressed path always wins. The
  fallback needs a delta-of-delta beyond signed int32 — about a 35-minute jump
  at microsecond resolution. `validate.test.ts` asserts the behaviour; these
  numbers say nothing about it.
- **Reconnect, replay and drainers.** Dominated by network and disk timing
  rather than client code, so a number there measures the environment.
- **Concurrency.** Single sender, single connection throughout.
