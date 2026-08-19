import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QwpNodeFileReplayStore } from "../../src/qwp/node";

const FIXTURE_DIRECTORY = join(process.cwd(), "test/qwp/fixtures/sfa");

describe("QWP SFA cross-client persistence", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function directory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "qwp-sfa-interop-"));
    directories.push(path);
    return path;
  }

  it("recovers and extends a segment written by the Java client", async () => {
    const path = await directory();
    await writeFile(
      join(path, "sf-initial.sfa"),
      await fixture("java-two-frame.sfa.hex"),
    );

    const store = new QwpNodeFileReplayStore({ directory: path });
    await expect(store.load()).resolves.toEqual([
      { frameSequence: 42n, payload: bytes("one") },
      { frameSequence: 43n, payload: bytes("two-two") },
    ]);
    await store.append({ frameSequence: 44n, payload: bytes("!") });
    await store.close();

    const recovered = new QwpNodeFileReplayStore({ directory: path });
    await expect(recovered.load()).resolves.toEqual([
      { frameSequence: 42n, payload: bytes("one") },
      { frameSequence: 43n, payload: bytes("two-two") },
      { frameSequence: 44n, payload: bytes("!") },
    ]);
    await recovered.close();
  });

  it("repairs the Java segment fixture at its valid CRC prefix", async () => {
    const path = await directory();
    const segmentPath = join(path, "sf-initial.sfa");
    await writeFile(
      segmentPath,
      await fixture("java-two-frame-torn-tail.sfa.hex"),
    );

    const store = new QwpNodeFileReplayStore({ directory: path });
    await expect(store.load()).resolves.toEqual([
      { frameSequence: 42n, payload: bytes("one") },
    ]);
    const repaired = await readFile(segmentPath);
    expect(repaired.subarray(35).every((value) => value === 0)).toBe(true);
    await store.close();
  });

  it("writes the same normalized segment bytes as Java", async () => {
    const path = await directory();
    const store = new QwpNodeFileReplayStore({
      directory: path,
      maxSegmentBytes: 32,
    });
    await store.load();
    await store.append({ frameSequence: 42n, payload: bytes("one") });
    await store.append({ frameSequence: 43n, payload: bytes("two-two") });
    await store.close();

    const [segmentName] = (await readdir(path)).filter((name) =>
      name.endsWith(".sfa"),
    );
    const actual = await readFile(join(path, segmentName));
    const expected = await fixture("java-two-frame.sfa.hex");
    // Java fixture timestamps are normalized and predate required manifests.
    actual.writeUInt8(0, 5);
    expected.subarray(16, 24).copy(actual, 16);
    expect(actual).toEqual(expected);
  });

  it("adopts Java's initial segment without retaining its empty hot spare", async () => {
    const path = await directory();
    const initial = await fixture("java-two-frame.sfa.hex");
    await writeFile(join(path, "sf-initial.sfa"), initial);
    const spare = Buffer.alloc(initial.byteLength);
    initial.subarray(0, 24).copy(spare);
    spare.writeBigUInt64LE(44n, 8);
    await writeFile(join(path, "sf-0000000000000000.sfa"), spare);

    const store = new QwpNodeFileReplayStore({ directory: path });
    await expect(store.load()).resolves.toEqual([
      { frameSequence: 42n, payload: bytes("one") },
      { frameSequence: 43n, payload: bytes("two-two") },
    ]);
    expect(
      (await readdir(path)).filter((name) => name.endsWith(".sfa")),
    ).toEqual(["sf-initial.sfa"]);
    await store.close();
  });

  it("loads and extends Java symbol-dictionary chunks", async () => {
    const path = await directory();
    await writeFile(
      join(path, ".symbol-dict"),
      await fixture("java-two-chunk.symbol-dict.hex"),
    );

    const store = new QwpNodeFileReplayStore({ directory: path });
    await store.load();
    await expect(store.loadSymbolDictionary()).resolves.toEqual([
      "one",
      "two",
      "three",
    ]);
    await store.appendSymbolDictionary(3, ["four"]);
    await store.append({ frameSequence: 0n, payload: Uint8Array.of(1) });
    await store.close();

    const recovered = new QwpNodeFileReplayStore({ directory: path });
    await recovered.load();
    await expect(recovered.loadSymbolDictionary()).resolves.toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
    await recovered.close();
  });

  it("writes the same symbol-dictionary bytes as Java", async () => {
    const path = await directory();
    const dictionaryPath = join(path, ".symbol-dict");
    const store = new QwpNodeFileReplayStore({ directory: path });
    await store.load();
    await store.appendSymbolDictionary(0, ["one"]);
    await store.appendSymbolDictionary(1, ["two", "three"]);

    await expect(readFile(dictionaryPath)).resolves.toEqual(
      await fixture("java-two-chunk.symbol-dict.hex"),
    );
    await store.close();
  });

  it("truncates a torn Java dictionary fixture to its valid chunk", async () => {
    const path = await directory();
    const dictionaryPath = join(path, ".symbol-dict");
    await writeFile(
      dictionaryPath,
      await fixture("java-two-chunk-torn-tail.symbol-dict.hex"),
    );

    const store = new QwpNodeFileReplayStore({ directory: path });
    await store.load();
    await expect(store.loadSymbolDictionary()).resolves.toEqual(["one"]);
    expect((await stat(dictionaryPath)).size).toBe(18);
    await store.close();
  });
});

async function fixture(name: string): Promise<Buffer> {
  const text = await readFile(join(FIXTURE_DIRECTORY, name), "utf8");
  return Buffer.from(text.replaceAll(/\s/g, ""), "hex");
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
