import { describe, it, expect } from "vitest";
import { QwpBuffer } from "../src/qwp/buffer";
import { SymbolDict } from "../src/qwp/protocol/symbolDict";
import { QwpTableBuffer } from "../src/qwp/protocol/tableBuffer";
import { encodeFrame } from "../src/qwp/protocol/frameEncoder";
import { TYPE_LONG, TYPE_TIMESTAMP } from "../src/qwp/protocol/constants";
import { WORKLOADS } from "./workloads";

const CAP = 1 << 30;
const BASE = 1_700_000_000_000_000n;

/**
 * `confirmedMaxId` lives on the BUFFER, starts at -1, and only advances via
 * confirmDeltaPublished(), which the transport's publish path calls -- not
 * sealFrames(). So a fresh QwpBuffer with a fully primed dictionary still
 * ships every symbol, because entriesFrom(-1 + 1) returns everything. Priming
 * the dict alone does nothing; the baseline has to be set too, which is what
 * `confirmed` simulates.
 */
function build(
  rows: ReturnType<typeof WORKLOADS.trades.rows>,
  dict?: SymbolDict,
  confirmed?: number,
): Buffer[] {
  const b = new QwpBuffer();
  if (dict) b.attachDict(dict);
  if (confirmed !== undefined) b.setConfirmedMaxId(confirmed);
  for (const row of rows) {
    b.table(row.table);
    for (const [n, v] of row.symbols) b.symbol(n, v);
    for (const [n, v] of row.longs) b.intColumn(n, Number(v));
    for (const [n, v] of row.doubles) b.floatColumn(n, v);
    for (const [n, v] of row.strings) b.stringColumn(n, v);
    b.at(row.ts, "us");
  }
  return b.sealFrames(CAP);
}

describe("wire-format invariants", () => {
  it("trades encodes to a plausible bytes/row", () => {
    const rows = WORKLOADS.trades.rows(10_000);
    const bytes = build(rows).reduce((a, f) => a + f.length, 0);
    const perRow = bytes / rows.length;
    // Measured ~17.1 bytes/row (gorilla on by default in QwpBuffer): 8 (price)
    // + 8 (amount) + ~1 (symbol id) + ~0.1 (gorilla-compressed timestamp, since
    // trades timestamps are perfectly regular, delta-of-delta = 0) + ~0 table
    // header amortised over 10k rows. Well under ~4 means a value is being
    // dropped (losing either double drops ~8 bytes/row); well over means
    // framing overhead has regressed. Band tightened from the original 20-120
    // guess around this measured figure.
    expect(perRow).toBeGreaterThan(14);
    expect(perRow).toBeLessThan(24);
  });

  it("null values are compacted, not written as placeholders", () => {
    const rows = WORKLOADS.sparse.rows(2000);
    const sparseBytes = build(rows).reduce((a, f) => a + f.length, 0);

    // Same shape with every value present.
    const dense = rows.map((r) => ({
      ...r,
      nulls: [],
      longs: ["a", "b", "c", "d", "e", "f", "g", "h"].map(
        (n) => [n, 1n] as [string, bigint],
      ),
    }));
    const denseBytes = build(dense).reduce((a, f) => a + f.length, 0);

    // ~30% nulls must produce a materially smaller payload (spec 6.2.1).
    expect(sparseBytes).toBeLessThan(denseBytes * 0.9);
  });

  it("delta mode emits fewer bytes than full-dict on high cardinality", () => {
    const rows = WORKLOADS.highCardSymbol.rows(5000);
    const full = build(rows).reduce((a, f) => a + f.length, 0);

    // Steady state: the dictionary is populated AND the server has confirmed
    // those ids, so the frame carries varint ids and an empty delta section.
    // Both halves are required -- see the note on build() above.
    const dict = new SymbolDict();
    build(rows, dict); // first pass registers every symbol in the dict
    const second = build(rows, dict, dict.size() - 1).reduce((a, f) => a + f.length, 0);

    expect(second).toBeLessThan(full);
  });

  it("a cold delta batch is NOT smaller — the baseline is what saves bytes", () => {
    // Guards the mistake above: priming the dict without advancing the
    // confirmed baseline still ships every symbol string, so this must land
    // in the same range as full-dict rather than winning.
    const rows = WORKLOADS.highCardSymbol.rows(5000);
    const full = build(rows).reduce((a, f) => a + f.length, 0);

    const dict = new SymbolDict();
    build(rows, dict);
    const coldAgain = build(rows, dict).reduce((a, f) => a + f.length, 0);

    // Both ship every symbol string once — cold delta in the delta section,
    // full-dict in a per-column inline dictionary — so they should land within
    // a few percent. A 0.5 threshold would also pass if the baseline were
    // partially advancing, which is the bug this guards.
    expect(coldAgain).toBeGreaterThan(full * 0.9);
  });

  it("the gorilla flag does not leak into non-timestamp columns", () => {
    const t = new QwpTableBuffer("g");
    for (let i = 0; i < 5000; i++) {
      t.getOrCreateColumn("v", TYPE_LONG)?.values.push(BigInt(i));
      t.nextRow();
    }
    const off = encodeFrame([t], { gorilla: false }).length;
    const on = encodeFrame([t], { gorilla: true }).length;
    // LONG is not gorilla-encoded, so these must match EXACTLY. A difference
    // means the flag is reaching a column type it should not touch.
    expect(on).toBe(off);
  });

  it("gorilla actually shrinks a regularly spaced timestamp column", () => {
    // The positive case. Without this, the suite asserts only that gorilla does
    // nothing to LONG — it would pass with the encoder never compressing at all.
    const t = new QwpTableBuffer("g_ts");
    for (let i = 0; i < 5000; i++) {
      t.getOrCreateColumn("ts", TYPE_TIMESTAMP)?.values.push(BASE + BigInt(i) * 1000n);
      t.nextRow();
    }
    const off = encodeFrame([t], { gorilla: false }).length;
    const on = encodeFrame([t], { gorilla: true }).length;
    // Constant spacing means every delta-of-delta is 0 — one bit per row after
    // the first two raw values, versus 8 bytes each uncompressed.
    expect(on).toBeLessThan(off / 2);
  });
});
