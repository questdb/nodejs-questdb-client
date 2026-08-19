import { it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sender } from "../src";
import { BENCHMARK_WORKLOADS } from "./workloads";

const ADDRESS = process.env.QDB_ADDR ?? "localhost:9000";
const ROWS = Number(process.env.BENCH_ROWS ?? 5000);
const WARMUP_ROWS = Number(process.env.BENCH_WARMUP_ROWS ?? 500);
const REPEATS = Number(process.env.BENCH_REPEATS ?? 3);
const TIMESTAMP_STRIDE = 1_000_000_000n;
const SF_ROOT = process.env.QWP_BENCH_DIR ?? tmpdir();

type SenderExtraOptions = NonNullable<Parameters<typeof Sender.fromConfig>[1]>;

interface ArmOptions {
  label: string;
  table: string;
  configuration: (repeat: number, sfDirectory: string) => string;
  extraOptions?: SenderExtraOptions;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function percentile(
  sorted: readonly number[],
  percentileValue: number,
): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

async function measureArm(
  options: ArmOptions,
  repeat: number,
  sfDirectory: string,
): Promise<number[]> {
  const sender = await Sender.fromConfig(
    options.configuration(repeat, sfDirectory),
    options.extraOptions,
  );
  const samples: number[] = [];
  const timestampOffset = BigInt(repeat) * TIMESTAMP_STRIDE;
  try {
    await sender.connect();
    const allRows = BENCHMARK_WORKLOADS.trades.rows(WARMUP_ROWS + ROWS);
    for (const row of allRows.slice(0, WARMUP_ROWS)) {
      sender
        .table(options.table)
        .symbol("symbol", row.symbols[0][1])
        .floatColumn("price", row.doubles[0][1])
        .floatColumn("amount", row.doubles[1][1]);
      await sender.at(row.timestamp + timestampOffset);
    }
    await sender.flush();

    for (const row of allRows.slice(WARMUP_ROWS)) {
      sender
        .table(options.table)
        .symbol("symbol", row.symbols[0][1])
        .floatColumn("price", row.doubles[0][1])
        .floatColumn("amount", row.doubles[1][1]);
      await sender.at(row.timestamp + timestampOffset);
      const started = process.hrtime.bigint();
      await sender.flush();
      samples.push(Number(process.hrtime.bigint() - started) / 1000);
    }
  } finally {
    await sender.close();
  }
  return samples.sort((left, right) => left - right);
}

function report(label: string, runs: readonly number[][]): void {
  console.log(`\n${label}`);
  for (const value of [50, 90, 99, 99.9]) {
    const samples = runs.map((run) => percentile(run, value));
    const minimum = Math.min(...samples).toFixed(1);
    const maximum = Math.max(...samples).toFixed(1);
    console.log(
      `  p${value}\t${minimum} - ${maximum} us (${runs.length} repeats)`,
    );
  }
}

it("measures QWP ingress completion boundaries", async () => {
  positiveInteger(ROWS, "BENCH_ROWS");
  nonNegativeInteger(WARMUP_ROWS, "BENCH_WARMUP_ROWS");
  positiveInteger(REPEATS, "BENCH_REPEATS");

  await mkdir(SF_ROOT, { recursive: true });
  const sfDirectory = await mkdtemp(join(SF_ROOT, "qwp-bench-e2e-"));
  console.log(
    `QWP E2E latency: ${ADDRESS}, ${ROWS} rows, ${REPEATS} repeats per arm`,
  );
  console.log(`SF directory: ${sfDirectory}`);
  console.log(
    `Verify real storage before quoting SF results: df -T ${SF_ROOT}`,
  );

  const arms: ArmOptions[] = [
    {
      label: "flush() = local WebSocket publication",
      table: "bench_e2e_publication",
      configuration: () => `ws::addr=${ADDRESS};auto_flush=off`,
      extraOptions: {
        qwp: { sender: { autoFlush: false, closeFlushTimeoutMs: 0 } },
      },
    },
    {
      label: "flush() = server protocol ACK",
      table: "bench_e2e_ack",
      configuration: () => `ws::addr=${ADDRESS};auto_flush=off`,
      extraOptions: {
        qwp: {
          sender: {
            autoFlush: false,
            awaitServerAck: true,
            closeFlushTimeoutMs: 0,
          },
        },
      },
    },
    {
      label: "flush() = local SF append durability",
      table: "bench_e2e_sf",
      configuration: (repeat, directory) =>
        `ws::addr=${ADDRESS};auto_flush=off;sf_dir=${directory};` +
        `sender_id=bench-${repeat};sf_durability=append`,
      extraOptions: {
        qwp: { sender: { autoFlush: false, closeFlushTimeoutMs: 0 } },
      },
    },
  ];

  if (process.env.QWP_BENCH_DURABLE_ACK === "1") {
    arms.push({
      label: "flush() = server durable ACK",
      table: "bench_e2e_durable_ack",
      configuration: () =>
        `ws::addr=${ADDRESS};auto_flush=off;request_durable_ack=on`,
      extraOptions: {
        qwp: {
          sender: {
            autoFlush: false,
            awaitDurableAck: true,
            closeFlushTimeoutMs: 0,
          },
        },
      },
    });
  }

  try {
    for (const arm of arms) {
      const runs: number[][] = [];
      for (let repeat = 0; repeat < REPEATS; repeat++) {
        runs.push(await measureArm(arm, repeat, sfDirectory));
      }
      report(arm.label, runs);
    }
  } finally {
    await rm(sfDirectory, { recursive: true, force: true });
  }
});
