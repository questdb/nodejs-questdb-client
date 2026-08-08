import { bench, describe, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
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
  // spawnSync so stderr (where dd writes the "N bytes copied, M s, X MB/s"
  // summary) is captured alongside stdout — the plan's execFileSync captured
  // only stdout and printed an empty baseline, defeating its purpose.
  const r = spawnSync(
    "dd",
    ["if=/dev/zero", `of=${join(path, "dd.tmp")}`, "bs=1M", "count=256", "oflag=direct"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const out = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join(" ").trim();
  if (out) console.log(`[disk baseline] ${out.split("\n").pop()}`);
  else {
    console.log(
      "[disk baseline] unavailable (dd missing, or O_DIRECT unsupported — " +
        "which itself suggests tmpfs). Treat SF numbers with caution.",
    );
  }
  rmSync(join(path, "dd.tmp"), { force: true });
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

// A synthetic 4 KiB frame, NOT a real encoded frame. SF does not inspect
// contents, so the shape does not matter — but the SIZE does: a real `trades`
// frame at 10k rows is tens of KiB, and appends amortise syscall cost over
// their size. Read the disk-mode number as "cost of a 4 KiB append", and scale
// FRAME up if you want to model a realistic flush.
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
