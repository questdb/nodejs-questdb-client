import { Buffer } from "node:buffer";

/**
 * Hand-written baselines. Each does the minimum byte movement the equivalent
 * encoder path must also do -- no null bitmap, no schema, no framing. The gap
 * between a floor and the real encoder is the protocol's cost.
 */

export function floorWriteLongs(values: bigint[]): Buffer {
  const b = Buffer.allocUnsafe(values.length * 8);
  let o = 0;
  for (const v of values) {
    b.writeBigInt64LE(v, o);
    o += 8;
  }
  return b;
}

export function floorWriteStrings(values: string[]): Buffer {
  let total = 0;
  for (const s of values) total += Buffer.byteLength(s, "utf8");
  const b = Buffer.allocUnsafe(total);
  let o = 0;
  for (const s of values) o += b.write(s, o, "utf8");
  return b;
}

/** Naive per-row map lookup -- what the row API pays at the same cardinality. */
export function floorInternSymbols(values: string[]): number[] {
  const map = new Map<string, number>();
  const out: number[] = [];
  for (const s of values) {
    let id = map.get(s);
    if (id === undefined) {
      id = map.size;
      map.set(s, id);
    }
    out.push(id);
  }
  return out;
}
