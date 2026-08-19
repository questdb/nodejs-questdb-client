import { describe, expect, it } from "vitest";
import {
  encodeQwpIngressFrame,
  QWP_COLUMN_TYPE,
  QwpSymbolDictionary,
  QwpTableBuffer,
} from "../src/qwp/core";
import { buildBenchmarkTable } from "./tables";
import { BENCHMARK_WORKLOADS, type BenchmarkRow } from "./workloads";

const BASE_TIMESTAMP = 1_700_000_000_000_000n;

function encode(
  rows: readonly BenchmarkRow[],
  dictionary?: QwpSymbolDictionary,
  confirmedMaxSymbolId?: number,
): Uint8Array {
  return encodeQwpIngressFrame([buildBenchmarkTable(rows)], {
    dictionary,
    confirmedMaxSymbolId,
  });
}

describe("benchmark wire-format invariants", () => {
  it("encodes trades to a plausible number of bytes per row", () => {
    const rows = BENCHMARK_WORKLOADS.trades.rows(10_000);
    const bytesPerRow = encode(rows).byteLength / rows.length;
    expect(bytesPerRow).toBeGreaterThan(14);
    expect(bytesPerRow).toBeLessThan(24);
  });

  it("compacts null values instead of writing placeholders", () => {
    const sparse = BENCHMARK_WORKLOADS.sparse.rows(2000);
    const sparseBytes = encode(sparse).byteLength;
    const dense = sparse.map((row) => ({
      ...row,
      nulls: [],
      longs: ["a", "b", "c", "d", "e", "f", "g", "h"].map(
        (name) => [name, 1n] as [string, bigint],
      ),
    }));
    expect(sparseBytes).toBeLessThan(encode(dense).byteLength * 0.9);
  });

  it("emits fewer bytes after a symbol-dictionary baseline is confirmed", () => {
    const rows = BENCHMARK_WORKLOADS.highCardinalitySymbols.rows(5000);
    const fullBytes = encode(rows).byteLength;
    const dictionary = new QwpSymbolDictionary();
    encode(rows, dictionary, -1);
    const deltaBytes = encode(rows, dictionary, dictionary.size - 1).byteLength;
    expect(deltaBytes).toBeLessThan(fullBytes);
  });

  it("does not treat a populated but unconfirmed dictionary as steady state", () => {
    const rows = BENCHMARK_WORKLOADS.highCardinalitySymbols.rows(5000);
    const fullBytes = encode(rows).byteLength;
    const dictionary = new QwpSymbolDictionary();
    encode(rows, dictionary, -1);
    const coldBytes = encode(rows, dictionary, -1).byteLength;
    expect(coldBytes).toBeGreaterThan(fullBytes * 0.9);
  });

  it("does not apply Gorilla encoding to long columns", () => {
    const table = new QwpTableBuffer("gorilla_long");
    for (let index = 0; index < 5000; index++) {
      table
        .getOrCreateColumn("value", QWP_COLUMN_TYPE.LONG)
        ?.values.push(BigInt(index));
      table.nextRow();
    }
    expect(encodeQwpIngressFrame([table], { gorilla: true }).byteLength).toBe(
      encodeQwpIngressFrame([table], { gorilla: false }).byteLength,
    );
  });

  it("compresses regularly spaced timestamps with Gorilla encoding", () => {
    const table = new QwpTableBuffer("gorilla_timestamp");
    for (let index = 0; index < 5000; index++) {
      table
        .getOrCreateColumn("timestamp", QWP_COLUMN_TYPE.TIMESTAMP)
        ?.values.push(BASE_TIMESTAMP + BigInt(index) * 1000n);
      table.nextRow();
    }
    const uncompressed = encodeQwpIngressFrame([table], {
      gorilla: false,
    }).byteLength;
    const compressed = encodeQwpIngressFrame([table], {
      gorilla: true,
    }).byteLength;
    expect(compressed).toBeLessThan(uncompressed / 2);
  });
});
