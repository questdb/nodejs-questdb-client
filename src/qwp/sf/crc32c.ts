import { Buffer } from "node:buffer";

// Castagnoli polynomial, reversed: 0x82F63B78. NOT the zlib/ISO-HDLC one.
const TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function crc32c(buf: Buffer, seed = 0): number {
  let c = ~seed;
  for (let i = 0; i < buf.length; i++) {
    c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (~c) >>> 0;
}
