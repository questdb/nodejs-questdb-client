import { QwpProtocolError } from "./errors";

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function encodeUtf8(value: string): Uint8Array {
  return UTF8_ENCODER.encode(value);
}

export function utf8Length(value: string): number {
  return encodeUtf8(value).length;
}

export function decodeUtf8(value: Uint8Array): string {
  try {
    return UTF8_DECODER.decode(value);
  } catch (error) {
    throw new QwpProtocolError(
      `invalid UTF-8 payload: ${(error as Error).message}`,
    );
  }
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function checkedLength(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

/** A growable, runtime-neutral little-endian byte writer. */
export class QwpByteWriter {
  private bytes: Uint8Array;
  private view: DataView;
  private cursor = 0;

  constructor(initialCapacity = 128) {
    checkedLength(initialCapacity, "initialCapacity");
    this.bytes = new Uint8Array(Math.max(initialCapacity, 1));
    this.view = new DataView(this.bytes.buffer);
  }

  get length(): number {
    return this.cursor;
  }

  private ensure(additional: number): void {
    checkedLength(additional, "additional byte count");
    const required = this.cursor + additional;
    if (required <= this.bytes.length) return;
    let capacity = this.bytes.length;
    while (capacity < required) capacity = Math.max(capacity * 2, required);
    const next = new Uint8Array(capacity);
    next.set(this.bytes.subarray(0, this.cursor));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  writeUint8(value: number): this {
    this.ensure(1);
    this.view.setUint8(this.cursor, value);
    this.cursor++;
    return this;
  }

  writeInt8(value: number): this {
    this.ensure(1);
    this.view.setInt8(this.cursor, value);
    this.cursor++;
    return this;
  }

  writeUint16(value: number): this {
    this.ensure(2);
    this.view.setUint16(this.cursor, value, true);
    this.cursor += 2;
    return this;
  }

  writeInt16(value: number): this {
    this.ensure(2);
    this.view.setInt16(this.cursor, value, true);
    this.cursor += 2;
    return this;
  }

  writeUint32(value: number): this {
    this.ensure(4);
    this.view.setUint32(this.cursor, value, true);
    this.cursor += 4;
    return this;
  }

  writeInt32(value: number): this {
    this.ensure(4);
    this.view.setInt32(this.cursor, value, true);
    this.cursor += 4;
    return this;
  }

  writeBigUint64(value: bigint): this {
    this.ensure(8);
    this.view.setBigUint64(this.cursor, BigInt.asUintN(64, value), true);
    this.cursor += 8;
    return this;
  }

  writeBigInt64(value: bigint): this {
    this.ensure(8);
    this.view.setBigInt64(this.cursor, BigInt.asIntN(64, value), true);
    this.cursor += 8;
    return this;
  }

  writeFloat32(value: number): this {
    this.ensure(4);
    this.view.setFloat32(this.cursor, value, true);
    this.cursor += 4;
    return this;
  }

  writeFloat64(value: number): this {
    this.ensure(8);
    this.view.setFloat64(this.cursor, value, true);
    this.cursor += 8;
    return this;
  }

  writeBytes(value: Uint8Array): this {
    this.ensure(value.length);
    this.bytes.set(value, this.cursor);
    this.cursor += value.length;
    return this;
  }

  writeUtf8(value: string): this {
    return this.writeBytes(encodeUtf8(value));
  }

  writeZeroes(count: number): this {
    this.ensure(count);
    this.bytes.fill(0, this.cursor, this.cursor + count);
    this.cursor += count;
    return this;
  }

  patchUint8(offset: number, value: number): void {
    if (offset < 0 || offset >= this.cursor) {
      throw new RangeError(`patch offset ${offset} is outside written bytes`);
    }
    this.view.setUint8(offset, value);
  }

  patchUint16(offset: number, value: number): void {
    if (offset < 0 || offset + 2 > this.cursor) {
      throw new RangeError(`patch offset ${offset} is outside written bytes`);
    }
    this.view.setUint16(offset, value, true);
  }

  patchUint32(offset: number, value: number): void {
    if (offset < 0 || offset + 4 > this.cursor) {
      throw new RangeError(`patch offset ${offset} is outside written bytes`);
    }
    this.view.setUint32(offset, value, true);
  }

  toUint8Array(): Uint8Array {
    return this.bytes.slice(0, this.cursor);
  }
}

/** A bounds-checked, runtime-neutral little-endian byte reader. */
export class QwpByteReader {
  private readonly view: DataView;
  private cursor: number;
  private readonly end: number;

  constructor(
    readonly bytes: Uint8Array,
    offset = 0,
    length = bytes.length - offset,
  ) {
    checkedLength(offset, "offset");
    checkedLength(length, "length");
    if (offset + length > bytes.length) {
      throw new QwpProtocolError("reader range exceeds payload length");
    }
    this.cursor = offset;
    this.end = offset + length;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get position(): number {
    return this.cursor;
  }

  get remaining(): number {
    return this.end - this.cursor;
  }

  private ensureAvailable(length: number, label: string): void {
    if (length < 0 || this.cursor + length > this.end) {
      throw new QwpProtocolError(
        `truncated QWP payload while reading ${label}`,
      );
    }
  }

  readUint8(label = "uint8"): number {
    this.ensureAvailable(1, label);
    return this.view.getUint8(this.cursor++);
  }

  readInt8(label = "int8"): number {
    this.ensureAvailable(1, label);
    return this.view.getInt8(this.cursor++);
  }

  readUint16(label = "uint16"): number {
    this.ensureAvailable(2, label);
    const value = this.view.getUint16(this.cursor, true);
    this.cursor += 2;
    return value;
  }

  readInt16(label = "int16"): number {
    this.ensureAvailable(2, label);
    const value = this.view.getInt16(this.cursor, true);
    this.cursor += 2;
    return value;
  }

  readUint32(label = "uint32"): number {
    this.ensureAvailable(4, label);
    const value = this.view.getUint32(this.cursor, true);
    this.cursor += 4;
    return value;
  }

  readInt32(label = "int32"): number {
    this.ensureAvailable(4, label);
    const value = this.view.getInt32(this.cursor, true);
    this.cursor += 4;
    return value;
  }

  readBigUint64(label = "uint64"): bigint {
    this.ensureAvailable(8, label);
    const value = this.view.getBigUint64(this.cursor, true);
    this.cursor += 8;
    return value;
  }

  readBigInt64(label = "int64"): bigint {
    this.ensureAvailable(8, label);
    const value = this.view.getBigInt64(this.cursor, true);
    this.cursor += 8;
    return value;
  }

  readFloat32(label = "float32"): number {
    this.ensureAvailable(4, label);
    const value = this.view.getFloat32(this.cursor, true);
    this.cursor += 4;
    return value;
  }

  readFloat64(label = "float64"): number {
    this.ensureAvailable(8, label);
    const value = this.view.getFloat64(this.cursor, true);
    this.cursor += 8;
    return value;
  }

  readBytes(length: number, label = "bytes"): Uint8Array {
    checkedLength(length, "byte length");
    this.ensureAvailable(length, label);
    const value = this.bytes.subarray(this.cursor, this.cursor + length);
    this.cursor += length;
    return value;
  }

  readUtf8(length: number, label = "UTF-8 string"): string {
    return decodeUtf8(this.readBytes(length, label));
  }

  expectEnd(label = "QWP payload"): void {
    if (this.remaining !== 0) {
      throw new QwpProtocolError(
        `${label} has ${this.remaining} unexpected trailing byte(s)`,
      );
    }
  }
}
