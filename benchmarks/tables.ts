import { QWP_COLUMN_TYPE, QwpTableBuffer } from "../src/qwp/core";
import type { BenchmarkRow } from "./workloads";

export function buildBenchmarkTable(
  rows: readonly BenchmarkRow[],
): QwpTableBuffer {
  const table = new QwpTableBuffer(rows[0].table);
  for (const row of rows) {
    for (const [name, value] of row.symbols) {
      table.getOrCreateColumn(name, QWP_COLUMN_TYPE.SYMBOL)?.values.push(value);
    }
    for (const [name, value] of row.longs) {
      table.getOrCreateColumn(name, QWP_COLUMN_TYPE.LONG)?.values.push(value);
    }
    for (const [name, value] of row.doubles) {
      table.getOrCreateColumn(name, QWP_COLUMN_TYPE.DOUBLE)?.values.push(value);
    }
    for (const [name, value] of row.strings) {
      table
        .getOrCreateColumn(name, QWP_COLUMN_TYPE.VARCHAR)
        ?.values.push(value);
    }
    table
      .getOrCreateColumn("", QWP_COLUMN_TYPE.TIMESTAMP)
      ?.values.push(row.timestamp);
    table.nextRow();
  }
  return table;
}
