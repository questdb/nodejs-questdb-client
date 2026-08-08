import { describe, it, expect } from "vitest";
import {
  encodeChunk,
  decodeDictFile,
  DICT_HEADER,
} from "../../../src/qwp/sf/symbolDictFile";
import { SymbolDict } from "../../../src/qwp/protocol/symbolDict";

describe("persisted symbol dictionary", () => {
  it("round-trips chunks in order", () => {
    const file = Buffer.concat([
      DICT_HEADER,
      encodeChunk(["a", "b"]),
      encodeChunk(["c"]),
    ]);
    expect(decodeDictFile(file)).toEqual(["a", "b", "c"]);
  });

  it("rejects a complete chunk with a bad CRC", () => {
    const file = Buffer.concat([
      DICT_HEADER,
      encodeChunk(["a"]),
      encodeChunk(["b"]),
    ]);
    file[file.length - 1] ^= 0xff;
    expect(() => decodeDictFile(file)).toThrow(/CRC mismatch/i);
  });

  it("recovery preserves positional ids and does NOT de-duplicate", () => {
    const file = Buffer.concat([DICT_HEADER, encodeChunk(["x", "x"])]);
    const entries = decodeDictFile(file);
    const dict = new SymbolDict();
    for (const e of entries) dict.addRecovered(e);
    expect(dict.size()).toBe(2); // collapsing would renumber every later symbol
  });

  it("rejects a bad magic", () => {
    expect(() => decodeDictFile(Buffer.from("NOPE0000"))).toThrow(/magic/i);
  });
});
