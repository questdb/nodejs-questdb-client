import { Buffer } from "node:buffer";

/** Unsigned LEB128. 7 data bits per byte; high bit set means another byte follows. */
export function writeVarint(buf: Buffer, offset: number, value: number): number {
  if (value < 0 || !Number.isInteger(value)) {
    throw new Error(`varint requires a non-negative integer, got ${value}`);
  }
  let v = value;
  let o = offset;
  while (v >= 0x80) {
    buf[o++] = (v & 0x7f) | 0x80;
    v = Math.floor(v / 128);
  }
  buf[o++] = v;
  return o;
}

export function varintSize(value: number): number {
  let v = value;
  let n = 1;
  while (v >= 0x80) {
    v = Math.floor(v / 128);
    n++;
  }
  return n;
}

export function readVarint(
  buf: Buffer,
  offset: number,
): { value: number; offset: number } {
  let value = 0;
  let shift = 1;
  let o = offset;
  for (;;) {
    if (o >= buf.length) throw new Error("incomplete varint");
    const b = buf[o++];
    value += (b & 0x7f) * shift;
    if ((b & 0x80) === 0) break;
    shift *= 128;
  }
  return { value, offset: o };
}
