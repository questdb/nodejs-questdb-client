import { Buffer } from "node:buffer";

/** Minimum byte movement for a flat int64 column, without QWP framing. */
export function floorWriteLongs(values: readonly bigint[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const value of values) {
    view.setBigInt64(offset, BigInt.asIntN(64, value), true);
    offset += 8;
  }
  return bytes;
}

/** Minimum UTF-8 copying work, without offsets, nulls, or QWP framing. */
export function floorWriteStrings(values: readonly string[]): Buffer {
  let length = 0;
  for (const value of values) length += Buffer.byteLength(value, "utf8");
  const bytes = Buffer.allocUnsafe(length);
  let offset = 0;
  for (const value of values) offset += bytes.write(value, offset, "utf8");
  return bytes;
}

/** Naive per-row symbol interning baseline. */
export function floorInternSymbols(values: readonly string[]): number[] {
  const ids = new Map<string, number>();
  const result: number[] = [];
  for (const value of values) {
    let id = ids.get(value);
    if (id === undefined) {
      id = ids.size;
      ids.set(value, id);
    }
    result.push(id);
  }
  return result;
}
