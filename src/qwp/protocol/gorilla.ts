import { Buffer } from "node:buffer";
import { BitWriter } from "./bits";

const INT32_MIN = -2147483648n;
const INT32_MAX = 2147483647n;

function bitsRequired(dod: bigint): number {
  if (dod === 0n) return 1;
  if (dod >= -64n && dod <= 63n) return 9;
  if (dod >= -256n && dod <= 255n) return 12;
  if (dod >= -2048n && dod <= 2047n) return 16;
  return 36;
}

/** Encoded size in bytes, or -1 when a delta-of-delta leaves int32 range. */
export function gorillaSize(ts: bigint[]): number {
  if (ts.length === 0) return 0;
  if (ts.length === 1) return 8;
  if (ts.length === 2) return 16;
  let prevTs = ts[1];
  let prevDelta = ts[1] - ts[0];
  let bits = 0;
  for (let i = 2; i < ts.length; i++) {
    const delta = ts[i] - prevTs;
    const dod = delta - prevDelta;
    if (dod < INT32_MIN || dod > INT32_MAX) return -1;
    bits += bitsRequired(dod);
    prevDelta = delta;
    prevTs = ts[i];
  }
  return 16 + Math.ceil(bits / 8);
}

export function encodeGorilla(ts: bigint[]): Buffer {
  const size = gorillaSize(ts);
  if (size < 0) throw new Error("gorilla: delta-of-delta out of int32 range");
  const out = Buffer.alloc(size);
  out.writeBigInt64LE(ts[0], 0);
  if (ts.length === 1) return out;
  out.writeBigInt64LE(ts[1], 8);
  if (ts.length === 2) return out;

  const w = new BitWriter(size - 16);
  let prevTs = ts[1];
  let prevDelta = ts[1] - ts[0];
  for (let i = 2; i < ts.length; i++) {
    const delta = ts[i] - prevTs;
    const dod = delta - prevDelta;
    // Prefixes are BIT-REVERSED because packing is LSB-first (spec 6.3.2).
    if (dod === 0n) {
      w.writeBits(0b0, 1);
    } else if (dod >= -64n && dod <= 63n) {
      w.writeBits(0b01, 2); // logical '10'
      w.writeBits(Number(dod & 0x7fn), 7);
    } else if (dod >= -256n && dod <= 255n) {
      w.writeBits(0b011, 3); // logical '110'
      w.writeBits(Number(dod & 0x1ffn), 9);
    } else if (dod >= -2048n && dod <= 2047n) {
      w.writeBits(0b0111, 4); // logical '1110'
      w.writeBits(Number(dod & 0xfffn), 12);
    } else {
      w.writeBits(0b1111, 4); // logical '1111'
      w.writeBits(Number(dod & 0xffffffffn), 32);
    }
    prevDelta = delta;
    prevTs = ts[i];
  }
  w.finish().copy(out, 16);
  return out;
}
