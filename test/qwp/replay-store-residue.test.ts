import { mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  QWP_SF_DURABILITY,
  QwpNodeFileReplayStore,
  scanQwpNodeOrphanSlots,
} from "../../packages/nodejs-client/src";

const SEGMENT_HEADER_SIZE = 24;
const MANIFEST_FILE = "sf-manifest.bin";

function replayRecord(frameSequence: bigint, fill: number) {
  return { frameSequence, payload: new Uint8Array(24).fill(fill) };
}

/**
 * Rewrites a published segment into the shape a process killed between
 * activateHotSpare()'s manifest publication and its first record write leaves
 * behind: the manifest-required flag never stamped, the record region never
 * written.
 */
async function eraseSegmentRecords(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    const { size } = await handle.stat();
    await handle.write(Uint8Array.of(0), 0, 1, 5);
    await handle.write(
      new Uint8Array(size - SEGMENT_HEADER_SIZE),
      0,
      size - SEGMENT_HEADER_SIZE,
      SEGMENT_HEADER_SIZE,
    );
  } finally {
    await handle.close();
  }
}

describe("QWP file replay store crash residue", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function slot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "qwp-sf-residue-"));
    directories.push(root);
    return root;
  }

  function store(directory: string): QwpNodeFileReplayStore {
    return new QwpNodeFileReplayStore({
      directory,
      // One record per fixed segment, so the second append rotates.
      maxSegmentBytes: 32,
      maxBytes: 4096,
      durability: QWP_SF_DURABILITY.MEMORY,
    });
  }

  it("retires a record-free active segment and its manifest once the journal drains", async () => {
    const directory = await slot();
    const producer = store(directory);
    await producer.load();
    await producer.append(replayRecord(0n, 1));
    await producer.append(replayRecord(1n, 2));
    await producer.close();

    const segments = (await readdir(directory))
      .filter((name) => name.endsWith(".sfa"))
      .sort();
    expect(segments).toHaveLength(2);
    await eraseSegmentRecords(join(directory, segments[1]));

    // Recovery keeps the record-free active segment beside the older
    // record-bearing one, so the load-only empty-journal cleanup does not
    // apply. Acknowledging the surviving record then emptied the journal
    // without ever queueing that segment: it plus sf-manifest.bin survived
    // close(), invisible to every later orphan scan.
    const recovered = store(directory);
    await expect(recovered.load()).resolves.toMatchObject([
      { frameSequence: 0n },
    ]);
    expect(recovered.metrics.pendingSegments).toBe(2);
    await recovered.acknowledgeThrough(0n);
    await recovered.close();

    const remaining = await readdir(directory);
    expect(remaining.filter((name) => name.endsWith(".sfa"))).toEqual([]);
    expect(remaining).not.toContain(MANIFEST_FILE);
  });

  it("offers a manifest-only residue slot to the orphan scanner", async () => {
    // The other half of the same defect: residue written by an older client
    // must still be adopted and cleaned, even though its flag-0, record-free
    // segment reads as unassigned.
    const root = await slot();
    const directory = join(root, "sender-0");
    const producer = store(directory);
    await producer.load();
    await producer.append(replayRecord(0n, 1));
    await producer.append(replayRecord(1n, 2));
    await producer.close();

    const segments = (await readdir(directory))
      .filter((name) => name.endsWith(".sfa"))
      .sort();
    await rm(join(directory, segments[0]));
    await eraseSegmentRecords(join(directory, segments[1]));

    await expect(scanQwpNodeOrphanSlots(root)).resolves.toEqual([directory]);
  });
});
