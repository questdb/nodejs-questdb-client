import { beforeAll, bench, describe } from "vitest";
import { mkdtemp, mkdir, open, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  QWP_SF_DURABILITY,
  QwpNodeFileReplayStore,
  type QwpSfDurability,
} from "../src/qwp-node/file-replay-store";

const FRAME = new Uint8Array(4096).fill(0x41);
const APPENDS = 100;
const RECOVERY_FRAMES = 1000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 4 * 1024 * 1024;

interface StoreState {
  store: QwpNodeFileReplayStore;
  nextSequence: bigint;
}

let root: string;
let pageCache: StoreState;
let periodic: StoreState;
let durable: StoreState;
let recoveryDirectory: string;
let lazyReader: QwpNodeFileReplayStore;
let lazySequences: bigint[];
let lazyCursor = 0;
let sink = 0;

async function diskBaseline(directory: string): Promise<void> {
  const path = join(directory, "disk-baseline.tmp");
  const file = await open(path, "wx", 0o600);
  const block = new Uint8Array(4 * 1024 * 1024);
  const blocks = 64;
  const started = process.hrtime.bigint();
  try {
    for (let index = 0; index < blocks; index++) await file.write(block);
    await file.sync();
  } finally {
    await file.close();
    await unlink(path).catch(() => undefined);
  }
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  const mebibytes = (block.byteLength * blocks) / (1024 * 1024);
  console.log(
    `[disk baseline] ${mebibytes} MiB write + fsync: ${(mebibytes / seconds).toFixed(1)} MiB/s`,
  );
}

async function createStore(
  name: string,
  durability: QwpSfDurability,
): Promise<StoreState> {
  const directory = join(root, name);
  const store = new QwpNodeFileReplayStore({
    directory,
    durability,
    checkpointIntervalMs:
      durability === QWP_SF_DURABILITY.PERIODIC ? 1000 : undefined,
    maxBytes: MAX_BYTES,
    maxSegmentBytes: MAX_SEGMENT_BYTES,
  });
  await store.loadReferences();
  return { store, nextSequence: 0n };
}

async function appendBatch(state: StoreState): Promise<void> {
  for (let index = 0; index < APPENDS; index++) {
    await state.store.append({
      frameSequence: state.nextSequence++,
      payload: FRAME,
    });
  }
  // Keep one record live so repeated iterations exercise steady-state segment
  // use instead of retiring the active segment after every benchmark body.
  await state.store.acknowledgeThrough(state.nextSequence - 2n);
}

async function seedBacklog(directory: string): Promise<void> {
  const store = new QwpNodeFileReplayStore({
    directory,
    durability: QWP_SF_DURABILITY.MEMORY,
    maxBytes: MAX_BYTES,
    maxSegmentBytes: MAX_SEGMENT_BYTES,
  });
  await store.loadReferences();
  for (let index = 0; index < RECOVERY_FRAMES; index++) {
    await store.append({ frameSequence: BigInt(index), payload: FRAME });
  }
  await store.close();
}

beforeAll(async () => {
  const configuredRoot = process.env.QWP_BENCH_DIR ?? tmpdir();
  await mkdir(configuredRoot, { recursive: true });
  root = await mkdtemp(join(configuredRoot, "qwp-bench-"));
  console.log(`[store-and-forward] benchmark directory: ${root}`);
  console.log(
    `[store-and-forward] verify real storage when quoting results: df -T ${configuredRoot}`,
  );
  await diskBaseline(root);

  [pageCache, periodic, durable] = await Promise.all([
    createStore("page-cache", QWP_SF_DURABILITY.MEMORY),
    createStore("periodic", QWP_SF_DURABILITY.PERIODIC),
    createStore("append", QWP_SF_DURABILITY.APPEND),
  ]);

  recoveryDirectory = join(root, "recovery");
  const lazyDirectory = join(root, "lazy-read");
  await seedBacklog(recoveryDirectory);
  await seedBacklog(lazyDirectory);
  lazyReader = new QwpNodeFileReplayStore({
    directory: lazyDirectory,
    durability: QWP_SF_DURABILITY.MEMORY,
    maxBytes: MAX_BYTES,
    maxSegmentBytes: MAX_SEGMENT_BYTES,
  });
  lazySequences = (await lazyReader.loadReferences()).map(
    (reference) => reference.frameSequence,
  );

  return async () => {
    await Promise.all([
      pageCache.store.close(),
      periodic.store.close(),
      durable.store.close(),
      lazyReader.close(),
    ]);
    await rm(root, { recursive: true, force: true });
  };
});

describe(`QwpNodeFileReplayStore / ${APPENDS} appends`, () => {
  bench("durability=memory (page-cache write)", async () => {
    await appendBatch(pageCache);
  });

  bench("durability=periodic", async () => {
    await appendBatch(periodic);
  });

  bench("durability=append (fsync per frame)", async () => {
    await appendBatch(durable);
  });
});

describe("store-and-forward recovery", () => {
  bench(`recover ${RECOVERY_FRAMES} frame references`, async () => {
    const store = new QwpNodeFileReplayStore({
      directory: recoveryDirectory,
      durability: QWP_SF_DURABILITY.MEMORY,
      maxBytes: MAX_BYTES,
      maxSegmentBytes: MAX_SEGMENT_BYTES,
    });
    const references = await store.loadReferences();
    sink += references.length;
    await store.close();
  });

  bench("lazy read / 4 KiB payload", async () => {
    const sequence = lazySequences[lazyCursor++ % lazySequences.length];
    sink += (await lazyReader.readPayload(sequence)).byteLength;
  });
});

export const persistenceBenchmarkSink = (): number => sink;
