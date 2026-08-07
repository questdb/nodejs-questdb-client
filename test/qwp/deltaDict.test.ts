import { describe, it, expect } from "vitest";
import { encodeFrame } from "../../src/qwp/protocol/frameEncoder";
import { QwpTableBuffer } from "../../src/qwp/protocol/tableBuffer";
import { SymbolDict } from "../../src/qwp/protocol/symbolDict";
import { TYPE_SYMBOL, FLAG_DELTA_SYMBOL_DICT } from "../../src/qwp/protocol/constants";
import { readVarint } from "../../src/qwp/protocol/varint";

describe("delta symbol dictionary", () => {
  it("sets the flag and emits only newly-seen symbols", () => {
    const dict = new SymbolDict();
    dict.getOrAdd("already"); // id 0, already confirmed
    const t = new QwpTableBuffer("t");
    t.getOrCreateColumn("s", TYPE_SYMBOL)!.values.push(dict.getOrAdd("fresh")); // id 1
    t.nextRow();

    const f = encodeFrame([t], { gorilla: false, dict, confirmedMaxId: 0 });
    expect(f.readUInt8(5) & FLAG_DELTA_SYMBOL_DICT).toBe(FLAG_DELTA_SYMBOL_DICT);

    let o = 12;
    const start = readVarint(f, o);
    o = start.offset;
    const count = readVarint(f, o);
    expect(start.value).toBe(1); // confirmedMaxId + 1
    expect(count.value).toBe(1); // only "fresh"
  });

  it("emits an empty delta when nothing new was registered", () => {
    const dict = new SymbolDict();
    dict.getOrAdd("a");
    const t = new QwpTableBuffer("t");
    t.getOrCreateColumn("s", TYPE_SYMBOL)!.values.push(0);
    t.nextRow();
    const f = encodeFrame([t], { gorilla: false, dict, confirmedMaxId: 0 });
    let o = 12;
    const start = readVarint(f, o);
    const count = readVarint(f, start.offset);
    expect(count.value).toBe(0);
  });
});
