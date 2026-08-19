import { bench, describe } from "vitest";
import { QwpTableBuffer } from "../src/qwp/protocol/tableBuffer";
import { encodeFrame } from "../src/qwp/protocol/frameEncoder";
import { SymbolDict } from "../src/qwp/protocol/symbolDict";
import {
  TYPE_LONG,
  TYPE_DOUBLE,
  TYPE_SYMBOL,
  TYPE_TIMESTAMP,
  TYPE_VARCHAR,
} from "../src/qwp/protocol/constants";
import { WORKLOADS } from "./workloads";
import { floorWriteLongs, floorWriteStrings, floorInternSymbols } from "./floors";

const N = 10_000;

/**
 * Consumes every result so neither the encoder nor the floor can be optimised
 * away. Built in rather than added reactively: a floor that gets eliminated
 * while the encoder does not (or vice versa) produces a ratio that looks like
 * a finding, and the whole point of the floor is that the ratio is trustworthy.
 */
let sink = 0;

/**
 * Every column family the workloads generate must be handled here. Dropping
 * one silently shrinks the benchmark: omitting `strings` turns `wide` from the
 * advertised 50 columns into 42 and stops exercising varchar entirely.
 */
function buildTable(name: string, rows: ReturnType<typeof WORKLOADS.trades.rows>): QwpTableBuffer {
  const t = new QwpTableBuffer(name);
  for (const row of rows) {
    for (const [n, v] of row.symbols) t.getOrCreateColumn(n, TYPE_SYMBOL)?.values.push(v);
    for (const [n, v] of row.longs) t.getOrCreateColumn(n, TYPE_LONG)?.values.push(v);
    for (const [n, v] of row.doubles) t.getOrCreateColumn(n, TYPE_DOUBLE)?.values.push(v);
    for (const [n, v] of row.strings) t.getOrCreateColumn(n, TYPE_VARCHAR)?.values.push(v);
    t.getOrCreateColumn("timestamp", TYPE_TIMESTAMP)?.values.push(row.ts);
    t.nextRow();
  }
  return t;
}

describe("frame encode", () => {
  for (const name of ["trades", "wide", "sparse"] as const) {
    const rows = WORKLOADS[name].rows(N);
    // Use the workload's own table name, matching Tasks 4 and 6. Passing
    // WORKLOADS[name].name instead ("trades" vs "bench_trades") would encode a
    // different table-name length and make frame sizes differ between tasks
    // measuring nominally the same workload.
    const table = buildTable(rows[0].table, rows);
    bench(`encodeFrame / ${name} / gorilla off`, () => {
      sink += encodeFrame([table], { gorilla: false }).length;
    });
    bench(`encodeFrame / ${name} / gorilla on`, () => {
      sink += encodeFrame([table], { gorilla: true }).length;
    });
  }
});

describe("floor comparison", () => {
  const longs = WORKLOADS.sparse.rows(N).flatMap((r) => r.longs.map(([, v]) => v));

  bench("FLOOR writeBigInt64LE loop", () => {
    sink += floorWriteLongs(longs).length;
  });

  const t = new QwpTableBuffer("floor_cmp");
  for (const v of longs) {
    t.getOrCreateColumn("v", TYPE_LONG)?.values.push(v);
    t.nextRow();
  }
  bench("encodeFrame single long column", () => {
    sink += encodeFrame([t], { gorilla: false }).length;
  });
});

describe("varchar floor comparison", () => {
  // `wide` strings are "v0".."v99" — 2 to 3 bytes each. With a 4-byte offset
  // per value, the offset array outweighs the payload, so this arm chiefly
  // measures offset-table overhead rather than string copying. That is the
  // interesting comparison for short symbols-as-text, but do not read it as a
  // large-varchar number.
  const strs = WORKLOADS.wide.rows(N).flatMap((r) => r.strings.map(([, v]) => v));

  bench("FLOOR utf8 write loop", () => {
    sink += floorWriteStrings(strs).length;
  });

  const tv = new QwpTableBuffer("floor_varchar");
  for (const v of strs) {
    tv.getOrCreateColumn("s", TYPE_VARCHAR)?.values.push(v);
    tv.nextRow();
  }
  bench("encodeFrame single varchar column", () => {
    sink += encodeFrame([tv], { gorilla: false }).length;
  });
});

describe("symbol interning", () => {
  const syms = WORKLOADS.highCardSymbol.rows(N).map((r) => r.symbols[0][1]);

  bench("FLOOR naive Map intern", () => {
    sink += floorInternSymbols(syms).length;
  });

  bench("SymbolDict.getOrAdd", () => {
    const d = new SymbolDict();
    for (const s of syms) d.getOrAdd(s);
    sink += d.size();
  });
});

// Keeps `sink` observable so the compiler cannot treat it as dead.
export const _sink = () => sink;
