import { QwpByteReader, QwpByteWriter } from "./bytes";
import { QwpProtocolError } from "./errors";

const MAX_UINT64 = 0xffffffffffffffffn;

function toBigInt(value: number | bigint): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(
        `varint requires a non-negative safe integer, got ${value}`,
      );
    }
    return BigInt(value);
  }
  if (value < 0n || value > MAX_UINT64) {
    throw new RangeError(`varint is outside the uint64 range: ${value}`);
  }
  return value;
}

/** Returns the encoded byte count of an unsigned LEB128 uint64. */
export function qwpVarintSize(value: number | bigint): number {
  let remaining = toBigInt(value);
  let size = 1;
  while (remaining >= 0x80n) {
    remaining >>= 7n;
    size++;
  }
  return size;
}

/** Writes an unsigned LEB128 uint64. */
export function writeQwpVarint(
  writer: QwpByteWriter,
  value: number | bigint,
): void {
  let remaining = toBigInt(value);
  while (remaining >= 0x80n) {
    writer.writeUint8(Number(remaining & 0x7fn) | 0x80);
    remaining >>= 7n;
  }
  writer.writeUint8(Number(remaining));
}

/** Reads an unsigned LEB128 uint64. */
export function readQwpVarint(reader: QwpByteReader): bigint {
  let value = 0n;
  for (let index = 0; index < 10; index++) {
    const byte = reader.readUint8("varint");
    if (index === 9 && (byte & 0xfe) !== 0) {
      throw new QwpProtocolError("QWP varint exceeds uint64 range");
    }
    value |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if ((byte & 0x80) === 0) return value;
  }
  throw new QwpProtocolError("QWP varint exceeds 10 bytes");
}

export function readQwpVarintNumber(
  reader: QwpByteReader,
  label = "varint",
): number {
  const value = readQwpVarint(reader);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new QwpProtocolError(
      `${label} exceeds JavaScript's safe integer range`,
    );
  }
  return Number(value);
}

export function encodeQwpVarint(value: number | bigint): Uint8Array {
  const writer = new QwpByteWriter(qwpVarintSize(value));
  writeQwpVarint(writer, value);
  return writer.toUint8Array();
}

export function decodeQwpVarint(
  bytes: Uint8Array,
  offset = 0,
): { value: bigint; offset: number } {
  const reader = new QwpByteReader(bytes, offset);
  const value = readQwpVarint(reader);
  return { value, offset: reader.position };
}
