import { bench, describe } from "vitest";
import { QwpBuffer } from "../src/qwp/buffer";
import { SymbolDict } from "../src/qwp/protocol/symbolDict";
import { WORKLOADS } from "./workloads";

const N = 10_000;
const CAP = 1 << 30; // large enough that nothing splits

/** See Task 5's note — consumes results so nothing is optimised away. */
let sink = 0;

/**
 * Handles every column family the workloads generate — see Task 5's note.
 *
 * Note `Number(v)`: `intColumn` takes a `number` while the workloads carry
 * `bigint`, so this layer pays a per-value conversion the encoder benchmarks in
 * Task 5 do not (they push the bigint straight into `values`). The two tasks are
 * therefore not directly comparable — some of the gap is representation, not
 * buffer overhead. All generated values are well under 2^53, so no precision is
 * lost; raise N or change a generator and re-check that.
 */
function fill(b: QwpBuffer, rows: ReturnType<typeof WORKLOADS.trades.rows>): void {
  for (const row of rows) {
    b.table(row.table);
    for (const [n, v] of row.symbols) b.symbol(n, v);
    for (const [n, v] of row.longs) b.intColumn(n, Number(v));
    for (const [n, v] of row.doubles) b.floatColumn(n, v);
    for (const [n, v] of row.strings) b.stringColumn(n, v);
    // QwpBuffer.at() is synchronous (src/qwp/buffer.ts:173) — do NOT await it.
    b.at(row.ts, "us");
  }
}

describe("QwpBuffer build + seal", () => {
  for (const name of ["trades", "wide", "sparse"] as const) {
    const rows = WORKLOADS[name].rows(N);
    bench(`build+seal / ${name}`, () => {
      const b = new QwpBuffer();
      fill(b, rows);
      // sealFrames returns Buffer[]; sum BYTES, not the array length --
      // `.length` here would be the frame count (always 1 under CAP) and
      // would leave the encoded contents unobserved.
      for (const f of b.sealFrames(CAP)) sink += f.length;
    });
  }
});

describe("dictionary mode", () => {
  const rows = WORKLOADS.highCardSymbol.rows(N);

  bench("full-dict (no dict attached)", () => {
    const b = new QwpBuffer();
    fill(b, rows);
    for (const f of b.sealFrames(CAP)) sink += f.length;
  });

  // Steady state needs BOTH halves: a populated dictionary and a confirmed
  // baseline. confirmedMaxId lives on the buffer, starts at -1, and only moves
  // via confirmDeltaPublished() from the transport's publish path -- so a
  // fresh buffer with a primed dict still ships every symbol, because
  // entriesFrom(-1 + 1) returns everything. Priming the dict alone measures
  // nothing new.
  const primed = new SymbolDict();
  {
    const warm = new QwpBuffer();
    warm.attachDict(primed);
    fill(warm, rows);
    warm.sealFrames(CAP);
  }

  bench("delta-dict (primed + baseline confirmed)", () => {
    const b = new QwpBuffer();
    b.attachDict(primed);
    b.setConfirmedMaxId(primed.size() - 1);
    fill(b, rows);
    for (const f of b.sealFrames(CAP)) sink += f.length;
  });

  bench("delta-dict (cold, first batch)", () => {
    const b = new QwpBuffer();
    b.attachDict(new SymbolDict());
    fill(b, rows);
    for (const f of b.sealFrames(CAP)) sink += f.length;
  });
});

export const _sink = () => sink;
