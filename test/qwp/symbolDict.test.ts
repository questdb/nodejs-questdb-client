import { describe, it, expect } from "vitest";
import { SymbolDict } from "../../src/qwp/protocol/symbolDict";
import { MAX_SYMBOL_DICTIONARY_SIZE } from "../../src/qwp/protocol/constants";

describe("SymbolDict", () => {
  it("assigns dense ids from 0 and de-dupes on getOrAdd", () => {
    const d = new SymbolDict();
    expect(d.getOrAdd("a")).toBe(0);
    expect(d.getOrAdd("b")).toBe(1);
    expect(d.getOrAdd("a")).toBe(0);
    expect(d.size()).toBe(2);
  });

  it("returns entries above a baseline", () => {
    const d = new SymbolDict();
    d.getOrAdd("a");
    d.getOrAdd("b");
    d.getOrAdd("c");
    expect(d.entriesFrom(1)).toEqual(["b", "c"]);
  });

  it("addRecovered never de-duplicates", () => {
    const d = new SymbolDict();
    d.addRecovered("x");
    d.addRecovered("x");
    expect(d.size()).toBe(2); // positional ids must be preserved
  });

  it("enforces the dictionary cap at registration time", () => {
    const d = new SymbolDict();
    expect(MAX_SYMBOL_DICTIONARY_SIZE).toBe(1_000_000);
    expect(() => d.checkCap(MAX_SYMBOL_DICTIONARY_SIZE)).toThrow(/dictionary/i);
  });
});
