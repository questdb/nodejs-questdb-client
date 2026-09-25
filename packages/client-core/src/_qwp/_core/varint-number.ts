import { QwpByteReader } from "./bytes";
import { QwpProtocolError } from "./errors";

/**
 * Reads an unsigned LEB128 uint64 with the exact validation and reader
 * advancement of readQwpVarint(), but accumulates encodings of up to 7 bytes
 * (49 bits, always exact) in a plain number and returns it without touching
 * BigInt. Counts, lengths, and symbol IDs take this path on every cell, so
 * building each one as a BigInt only to convert it back dominated decoding.
 * 8..10-byte encodings, including zero-padded small values, fall back to
 * BigInt and return a bigint.
 *
 * Deliberately not re-exported from the `_core` barrel, so it stays out of
 * both public packages.
 *
 * @internal
 */
export function readQwpVarintSmall(reader: QwpByteReader): number | bigint {
  let byte = reader.readUint8("varint");
  if ((byte & 0x80) === 0) return byte;
  let value = byte & 0x7f;
  let scale = 0x80;
  for (let index = 1; index < 7; index++) {
    byte = reader.readUint8("varint");
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return value;
    scale *= 0x80;
  }
  let big = BigInt(value);
  for (let index = 7; index < 10; index++) {
    byte = reader.readUint8("varint");
    if (index === 9 && (byte & 0xfe) !== 0) {
      throw new QwpProtocolError("QWP varint exceeds uint64 range");
    }
    big |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if ((byte & 0x80) === 0) return big;
  }
  throw new QwpProtocolError("QWP varint exceeds 10 bytes");
}
