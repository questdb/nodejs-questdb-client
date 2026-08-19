import { describe, it, expect } from "vitest";
import { QwpBuffer } from "../../../src/qwp/buffer";
import { SymbolDict } from "../../../src/qwp/protocol/symbolDict";
import { FLAG_DELTA_SYMBOL_DICT } from "../../../src/qwp/protocol/constants";

describe("delta -> full-dict fallback", () => {
  it("keeps ingesting after the side file becomes unwritable", () => {
    const b = new QwpBuffer();
    b.attachDict(new SymbolDict(), () => {
      throw new Error("ENOSPC");
    });
    b.table("t").symbol("s", "a");
    b.at(1n, "us");
    const frames = b.sealFrames(1 << 20); // must NOT throw
    expect(frames.length).toBe(1);
    expect(frames[0].readUInt8(5) & FLAG_DELTA_SYMBOL_DICT).toBe(0);
  });

  it("the fallback is permanent", () => {
    const b = new QwpBuffer();
    let fail = true;
    b.attachDict(new SymbolDict(), () => {
      if (fail) throw new Error("ENOSPC");
    });
    b.table("t").symbol("s", "a");
    b.at(1n, "us");
    b.sealFrames(1 << 20);
    fail = false; // side file recovers, but we must stay in full-dict mode
    b.table("t").symbol("s", "b");
    b.at(2n, "us");
    expect(b.sealFrames(1 << 20)[0].readUInt8(5) & FLAG_DELTA_SYMBOL_DICT).toBe(0);
  });
});
