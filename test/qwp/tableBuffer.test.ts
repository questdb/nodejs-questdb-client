import { describe, it, expect } from "vitest";
import { QwpTableBuffer } from "../../src/qwp/protocol/tableBuffer";
import { TYPE_LONG, TYPE_DOUBLE } from "../../src/qwp/protocol/constants";

describe("QwpTableBuffer", () => {
  it("back-fills nulls so all columns stay equal length", () => {
    const t = new QwpTableBuffer("trades");
    t.getOrCreateColumn("a", TYPE_LONG)!.values.push(1);
    t.nextRow();
    t.getOrCreateColumn("b", TYPE_DOUBLE)!.values.push(2.5);
    t.nextRow();
    expect(t.rowCount).toBe(2);
    for (const c of t.columns) expect(c.size).toBe(2);
    // "a" is null in row 1, "b" is null in row 0
    expect(t.columns.find((c) => c.name === "a")!.nulls).toEqual([false, true]);
    expect(t.columns.find((c) => c.name === "b")!.nulls).toEqual([true, false]);
  });

  it("locks a column's type on first sight", () => {
    const t = new QwpTableBuffer("x");
    t.getOrCreateColumn("c", TYPE_LONG);
    expect(() => t.getOrCreateColumn("c", TYPE_DOUBLE)).toThrow(/type mismatch/i);
  });

  it("ignores a duplicate column within one row (first value wins)", () => {
    const t = new QwpTableBuffer("x");
    t.getOrCreateColumn("c", TYPE_LONG)!.values.push(1);
    expect(t.getOrCreateColumn("c", TYPE_LONG)).toBeNull();
  });

  it("rejects an empty column name", () => {
    const t = new QwpTableBuffer("x");
    expect(() => t.getOrCreateColumn("", TYPE_LONG)).toThrow(/empty/i);
  });
});
