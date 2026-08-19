import { bench, describe } from "vitest";
import {
  encodeQwpIngressFrame,
  QWP_COLUMN_TYPE,
  QwpSymbolDictionary,
  QwpTableBuffer,
} from "../src/qwp/core";
import {
  floorInternSymbols,
  floorWriteLongs,
  floorWriteStrings,
} from "./floors";
import { buildBenchmarkTable } from "./tables";
import { BENCHMARK_WORKLOADS } from "./workloads";

const ROWS = 10_000;
let sink = 0;

describe("QWP ingress frame encoder", () => {
  for (const name of ["trades", "wide", "sparse"] as const) {
    const table = buildBenchmarkTable(BENCHMARK_WORKLOADS[name].rows(ROWS));
    bench(`${name} / Gorilla off`, () => {
      sink += encodeQwpIngressFrame([table], { gorilla: false }).byteLength;
    });
    bench(`${name} / Gorilla on`, () => {
      sink += encodeQwpIngressFrame([table], { gorilla: true }).byteLength;
    });
  }
});

describe("encoder floors", () => {
  const longs = BENCHMARK_WORKLOADS.sparse
    .rows(ROWS)
    .flatMap((row) => row.longs.map(([, value]) => value))
    .slice(0, ROWS);
  const longTable = new QwpTableBuffer("floor_long");
  for (const value of longs) {
    longTable
      .getOrCreateColumn("value", QWP_COLUMN_TYPE.LONG)
      ?.values.push(value);
    longTable.nextRow();
  }

  bench("floor / writeBigInt64LE", () => {
    sink += floorWriteLongs(longs).byteLength;
  });
  bench("QWP / single long column", () => {
    sink += encodeQwpIngressFrame([longTable], {
      gorilla: false,
    }).byteLength;
  });

  const strings = BENCHMARK_WORKLOADS.wide
    .rows(ROWS)
    .flatMap((row) => row.strings.map(([, value]) => value))
    .slice(0, ROWS);
  const stringTable = new QwpTableBuffer("floor_varchar");
  for (const value of strings) {
    stringTable
      .getOrCreateColumn("value", QWP_COLUMN_TYPE.VARCHAR)
      ?.values.push(value);
    stringTable.nextRow();
  }

  bench("floor / UTF-8 write", () => {
    sink += floorWriteStrings(strings).byteLength;
  });
  bench("QWP / single varchar column", () => {
    sink += encodeQwpIngressFrame([stringTable], {
      gorilla: false,
    }).byteLength;
  });
});

describe("symbol interning", () => {
  const symbols = BENCHMARK_WORKLOADS.highCardinalitySymbols
    .rows(ROWS)
    .map((row) => row.symbols[0][1]);

  bench("floor / Map", () => {
    sink += floorInternSymbols(symbols).length;
  });
  bench("QwpSymbolDictionary.getOrAdd", () => {
    const dictionary = new QwpSymbolDictionary();
    for (const symbol of symbols) dictionary.getOrAdd(symbol);
    sink += dictionary.size;
  });
});

export const benchmarkSink = (): number => sink;
