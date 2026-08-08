import { Buffer } from "node:buffer";
import { crc32c } from "./crc32c";
import { writeVarint, varintSize, readVarint } from "../protocol/varint";

export const DICT_HEADER = (() => {
  const b = Buffer.alloc(8);
  b.write("SYD1", 0, "ascii");
  b.writeUInt8(1, 4);
  return b;
})();

/** One chunk = exactly the symbols one frame introduces (spec 8.1.6). */
export function encodeChunk(entries: string[]): Buffer {
  let entryBytes = 0;
  for (const s of entries) {
    const n = Buffer.byteLength(s, "utf8");
    entryBytes += varintSize(n) + n;
  }
  const head = Buffer.alloc(
    varintSize(entries.length) + varintSize(entryBytes),
  );
  let ho = writeVarint(head, 0, entries.length);
  ho = writeVarint(head, ho, entryBytes);

  const body = Buffer.alloc(entryBytes);
  let bo = 0;
  for (const s of entries) {
    const n = Buffer.byteLength(s, "utf8");
    bo = writeVarint(body, bo, n);
    body.write(s, bo, "utf8");
    bo += n;
  }

  // CRC covers BOTH header varints and the entry region.
  const crcInput = Buffer.concat([head.subarray(0, ho), body]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32LE(crc32c(crcInput), 0);
  return Buffer.concat([head.subarray(0, ho), body, tail]);
}

export interface DecodedDictFile {
  entries: string[];
  /** Byte offset immediately after the last fully validated chunk. */
  validBytes: number;
}

export function decodeDictFileState(file: Buffer): DecodedDictFile {
  if (
    file.length < DICT_HEADER.length ||
    file.subarray(0, 4).toString("ascii") !== "SYD1"
  ) {
    throw new Error("symbol dict: bad magic");
  }
  const out: string[] = [];
  let o = DICT_HEADER.length;
  let validBytes = o;
  while (o < file.length) {
    const start = o;
    let count: number;
    let entryBytes: number;
    try {
      const r = readVarint(file, o);
      count = r.value;
      o = r.offset;
      const r2 = readVarint(file, o);
      entryBytes = r2.value;
      o = r2.offset;
    } catch {
      break;
    }
    if (o + entryBytes + 4 > file.length) break;
    const crcInput = file.subarray(start, o + entryBytes);
    if (crc32c(crcInput) !== file.readUInt32LE(o + entryBytes)) {
      // The complete declared chunk and CRC are present: this is detectable
      // corruption, not a torn tail that is safe to truncate.
      throw new Error("symbol dict: chunk CRC mismatch");
    }

    const chunkEntries: string[] = [];
    let eo = o;
    try {
      for (let i = 0; i < count; i++) {
        const rl = readVarint(file, eo);
        eo = rl.offset;
        if (eo + rl.value > o + entryBytes)
          throw new Error("entry exceeds chunk");
        chunkEntries.push(file.subarray(eo, eo + rl.value).toString("utf8"));
        eo += rl.value;
      }
    } catch {
      throw new Error("symbol dict: corrupt chunk entries");
    }
    if (eo !== o + entryBytes) {
      throw new Error("symbol dict: corrupt chunk length");
    }
    out.push(...chunkEntries);
    o += entryBytes + 4;
    validBytes = o;
  }
  return { entries: out, validBytes };
}

export function decodeDictFile(file: Buffer): string[] {
  return decodeDictFileState(file).entries;
}
