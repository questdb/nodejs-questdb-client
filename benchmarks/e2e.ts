import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Sender } from "../src";
import { WORKLOADS } from "./workloads";

const ADDR = process.env.QDB_ADDR ?? "localhost:9000";
const ROWS = Number(process.env.BENCH_ROWS ?? 5000);
const WARMUP = 500;
const REPEATS = 3;
/** Wide enough that repeat N never overlaps repeat N-1's timestamp range. */
const REPEAT_TS_STRIDE = 1_000_000_000n;

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
 *
 * `tsOffset` keeps each repeat APPENDING. Workload rows are deterministic, so
 * without it every repeat would resend the same timestamp range into the same
 * table — and after repeat 1 those rows are older than what is already
 * committed, which puts QuestDB on its out-of-order commit path. Repeat 1 would
 * measure append while repeats 2 and 3 measure O3, and the "spread across
 * repeats" guard would read that as machine noise.
 *
 * The same hazard exists a second time, through the symbol dictionary, and the
 * defence is easy to delete by accident. Each repeat builds a FRESH Sender, and
 * the sf-on arm passes `sender_id=bench-${i}` — a different id per repeat, so a
 * different slot directory and therefore a cold `.symbol-dict` every time.
 * Collapse that to a fixed `sender_id` and repeat 1 pays full-dict encoding plus
 * write-ahead symbol persistence while repeats 2 and 3 recover the dictionary
 * and run in delta mode (spec 5.2, 8.1.6). Delta wiring is live end-to-end as of
 * handoff 6, so this is a real difference now, not a latent one. Keep the id
 * per-repeat; it is load-bearing for comparability, not just for slot locking.
 */
async function arm(config: string, table: string, tsOffset: bigint): Promise<number[]> {
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
      sender.table(table).symbol("symbol", row.symbols[0][1]);
      for (const [n, v] of row.doubles) sender.floatColumn(n, v);
      await sender.at(row.ts + tsOffset, "us");
    }
    await sender.flush();

    for (const row of rows) {
      sender.table(table).symbol("symbol", row.symbols[0][1]);
      for (const [n, v] of row.doubles) sender.floatColumn(n, v);
      await sender.at(row.ts + tsOffset, "us");
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
  // Each arm has its OWN table. Sharing one would let the second arm ingest
  // into a table already holding the first arm's rows — an asymmetry the
  // "one server, no restart" guard exists to remove, not introduce.
  const sfOff: number[][] = [];
  for (let i = 0; i < REPEATS; i++) {
    sfOff.push(
      await arm(`ws::addr=${ADDR};`, "bench_e2e_sfoff", BigInt(i) * REPEAT_TS_STRIDE),
    );
  }
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
      sfOn.push(
        await arm(
          `ws::addr=${ADDR};sf_dir=${sfDir};sender_id=bench-${i};`,
          "bench_e2e_sfon",
          BigInt(i) * REPEAT_TS_STRIDE,
        ),
      );
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
