import { describe, it, expect } from "vitest";
import { QwpBuffer } from "../../src/qwp/buffer";
import { SymbolDict } from "../../src/qwp/protocol/symbolDict";
import { FLAG_DELTA_SYMBOL_DICT } from "../../src/qwp/protocol/constants";
import { readVarint } from "../../src/qwp/protocol/varint";

/** Reads the delta header (deltaStart, count) immediately after the 12-byte frame header. */
function deltaHeader(f: Buffer): { start: number; count: number } {
  const start = readVarint(f, 12);
  const count = readVarint(f, start.offset);
  return { start: start.value, count: count.value };
}

describe("delta publish ordering (spec 5.2)", () => {
  it("seals write-ahead but advances the baseline only at publish time", () => {
    const dict = new SymbolDict();
    dict.getOrAdd("base"); // id 0, already confirmed
    const persisted: string[][] = [];
    const b = new QwpBuffer();
    b.setConfirmedMaxId(0);
    b.attachDict(dict, (es) => persisted.push(es));

    b.table("t").symbol("s", "alpha"); // id 1
    b.at(1n, "us");
    const f1 = b.sealFrames(1 << 20);

    // Write-ahead happened before encoding...
    expect(persisted).toEqual([["alpha"]]);
    // ...and the frame still carries alpha as a delta (baseline is still 0).
    expect(f1[0].readUInt8(5) & FLAG_DELTA_SYMBOL_DICT).toBe(FLAG_DELTA_SYMBOL_DICT);
    expect(deltaHeader(f1[0])).toEqual({ start: 1, count: 1 });
    // ...but the baseline itself must NOT have moved yet (spec 5.2).
    expect(b.pendingDeltaTarget).toBe(1);

    // Simulate a successful ring append (the transport's publish time).
    b.confirmDeltaPublished();

    // A second batch reuses the now-confirmed alpha and introduces only beta.
    b.table("t").symbol("s", "beta"); // id 2
    b.at(2n, "us");
    const f2 = b.sealFrames(1 << 20);
    // alpha must not be re-persisted (it was already confirmed).
    expect(persisted).toEqual([["alpha"], ["beta"]]);
    // The second frame's delta begins at id 2 and carries just beta.
    expect(deltaHeader(f2[0])).toEqual({ start: 2, count: 1 });
  });

  it("a failed persist never advances the baseline (one-way delta->full-dict)", () => {
    const dict = new SymbolDict();
    const b = new QwpBuffer();
    let calls = 0;
    b.attachDict(dict, () => {
      calls++;
      throw new Error("ENOSPC");
    });
    b.table("t").symbol("s", "a");
    b.at(1n, "us");
    b.sealFrames(1 << 20);
    expect(calls).toBe(1);
    // Degraded to full-dict: the delta baseline is not consulted (-1).
    expect(b.pendingDeltaTarget).toBe(-1);
  });

  it("in delta mode only the first split part ships the new symbols", () => {
    const dict = new SymbolDict();
    const persisted: string[][] = [];
    const b = new QwpBuffer();
    b.attachDict(dict, (es) => persisted.push(es));
    // Two tables each introducing a distinct symbol; a small cap forces a split.
    b.table("a").symbol("s", "x1");
    b.at(1n, "us");
    b.table("b").symbol("s", "y1");
    b.at(2n, "us");
    const parts = b.sealFrames(50);
    expect(parts.length).toBe(2);

    // Part 0 carries the whole batch delta (both new symbols found id 2, id 3).
    expect(deltaHeader(parts[0])).toEqual({ start: 0, count: 2 });
    // Part 1 re-ships nothing: its ids were registered by part 0, so its delta
    // is empty and pinned to the post-batch baseline (spec 5.2). deltaStart is
    // baseline + 1, i.e. dict.size() when the baseline is the dict tail.
    expect(deltaHeader(parts[1])).toEqual({ start: dict.size(), count: 0 });
    expect(persisted.flat()).toEqual(["x1", "y1"]);
  });
});
