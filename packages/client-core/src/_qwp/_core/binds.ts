import { encodeUtf8, QwpByteWriter } from "./bytes";
import { QWP_COLUMN_TYPE, QWP_MAX_COLUMNS_PER_TABLE } from "./constants";
import { writeQwpVarint } from "./varint";

const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const DECIMAL64_MAX_SCALE = 18;
const DECIMAL128_MAX_SCALE = 38;
const DECIMAL256_MAX_SCALE = 76;
const GEOHASH_MIN_BITS = 1;
const GEOHASH_MAX_BITS = 60;
const NULL_FLAG = 0x01;
const NULL_BITMAP = 0x01;
const NON_NULL_FLAG = 0x00;

export type QwpInt64 = number | bigint;

/** Phase-1 scalar bind types exposed by the Java reference client. */
export type QwpBindType =
  | typeof QWP_COLUMN_TYPE.BOOLEAN
  | typeof QWP_COLUMN_TYPE.BYTE
  | typeof QWP_COLUMN_TYPE.SHORT
  | typeof QWP_COLUMN_TYPE.INT
  | typeof QWP_COLUMN_TYPE.LONG
  | typeof QWP_COLUMN_TYPE.FLOAT
  | typeof QWP_COLUMN_TYPE.DOUBLE
  | typeof QWP_COLUMN_TYPE.TIMESTAMP
  | typeof QWP_COLUMN_TYPE.DATE
  | typeof QWP_COLUMN_TYPE.UUID
  | typeof QWP_COLUMN_TYPE.LONG256
  | typeof QWP_COLUMN_TYPE.GEOHASH
  | typeof QWP_COLUMN_TYPE.VARCHAR
  | typeof QWP_COLUMN_TYPE.TIMESTAMP_NANOS
  | typeof QWP_COLUMN_TYPE.DECIMAL64
  | typeof QWP_COLUMN_TYPE.DECIMAL128
  | typeof QWP_COLUMN_TYPE.DECIMAL256
  | typeof QWP_COLUMN_TYPE.CHAR;

export type QwpBindSetter = (binds: QwpBindValues) => void;

export interface QwpEncodedBinds {
  count: number;
  payload: Uint8Array;
}

function checkedIndex(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("bind index must be a non-negative safe integer");
  }
  return value;
}

function checkedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function checkedInt64(value: QwpInt64, label: string): bigint {
  let integer: bigint;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`${label} must be a safe integer or bigint`);
    }
    integer = BigInt(value);
  } else if (typeof value === "bigint") {
    integer = value;
  } else {
    throw new TypeError(`${label} must be a safe integer or bigint`);
  }
  if (integer < INT64_MIN || integer > INT64_MAX) {
    throw new RangeError(`${label} must fit in int64`);
  }
  return integer;
}

function checkedUint64Bits(value: QwpInt64, label: string): bigint {
  let integer: bigint;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`${label} must be a safe integer or bigint`);
    }
    integer = BigInt(value);
  } else if (typeof value === "bigint") {
    integer = value;
  } else {
    throw new TypeError(`${label} must be a safe integer or bigint`);
  }
  if (integer < INT64_MIN || integer > UINT64_MAX) {
    throw new RangeError(`${label} must fit in 64 bits`);
  }
  return BigInt.asUintN(64, integer);
}

function checkedScale(value: number, maximum: number, label: string): number {
  return checkedInteger(value, 0, maximum, `${label} scale`);
}

/**
 * Browser-safe typed positional bind encoder.
 *
 * Setters must be called in ascending zero-based index order. SQL placeholders
 * are one-based, so index 0 binds `$1`, index 1 binds `$2`, and so on.
 */
export class QwpBindValues {
  private writer = new QwpByteWriter();
  private expectedIndex = 0;

  get count(): number {
    return this.expectedIndex;
  }

  reset(): this {
    this.writer = new QwpByteWriter();
    this.expectedIndex = 0;
    return this;
  }

  setBoolean(index: number, value: boolean): this {
    if (typeof value !== "boolean") {
      throw new TypeError("BOOLEAN bind value must be a boolean");
    }
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.BOOLEAN, false);
    this.writer.writeUint8(value ? 1 : 0);
    return this;
  }

  setByte(index: number, value: number): this {
    const checked = checkedInteger(value, -0x80, 0x7f, "BYTE bind");
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.BYTE, false);
    this.writer.writeInt8(checked);
    return this;
  }

  setShort(index: number, value: number): this {
    const checked = checkedInteger(value, -0x8000, 0x7fff, "SHORT bind");
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.SHORT, false);
    this.writer.writeInt16(checked);
    return this;
  }

  setChar(index: number, value: string): this {
    if (typeof value !== "string" || value.length !== 1) {
      throw new TypeError("CHAR bind value must be one UTF-16 code unit");
    }
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.CHAR, false);
    this.writer.writeUint16(value.charCodeAt(0));
    return this;
  }

  setInt(index: number, value: number): this {
    const checked = checkedInteger(value, -0x80000000, 0x7fffffff, "INT bind");
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.INT, false);
    this.writer.writeInt32(checked);
    return this;
  }

  setLong(index: number, value: QwpInt64): this {
    const checked = checkedInt64(value, "LONG bind");
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.LONG, false);
    this.writer.writeBigInt64(checked);
    return this;
  }

  setFloat(index: number, value: number): this {
    if (typeof value !== "number") {
      throw new TypeError("FLOAT bind value must be a number");
    }
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.FLOAT, false);
    this.writer.writeFloat32(value);
    return this;
  }

  setDouble(index: number, value: number): this {
    if (typeof value !== "number") {
      throw new TypeError("DOUBLE bind value must be a number");
    }
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.DOUBLE, false);
    this.writer.writeFloat64(value);
    return this;
  }

  /** Binds a DATE expressed as milliseconds since the Unix epoch. */
  setDate(index: number, millisecondsSinceEpoch: QwpInt64): this {
    const checked = checkedInt64(millisecondsSinceEpoch, "DATE bind");
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.DATE, false);
    this.writer.writeBigInt64(checked);
    return this;
  }

  /** Binds a TIMESTAMP expressed as microseconds since the Unix epoch. */
  setTimestampMicros(index: number, microsecondsSinceEpoch: QwpInt64): this {
    const checked = checkedInt64(microsecondsSinceEpoch, "TIMESTAMP bind");
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.TIMESTAMP, false);
    this.writer.writeBigInt64(checked);
    return this;
  }

  /** Binds a TIMESTAMP_NS expressed as nanoseconds since the Unix epoch. */
  setTimestampNanos(index: number, nanosecondsSinceEpoch: QwpInt64): this {
    const checked = checkedInt64(nanosecondsSinceEpoch, "TIMESTAMP_NANOS bind");
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.TIMESTAMP_NANOS, false);
    this.writer.writeBigInt64(checked);
    return this;
  }

  setVarchar(index: number, value: string | null): this {
    if (value === null) return this.setNull(index, QWP_COLUMN_TYPE.VARCHAR);
    if (typeof value !== "string") {
      throw new TypeError("VARCHAR bind value must be a string or null");
    }
    const utf8 = encodeUtf8(value);
    if (utf8.length > 0x7fffffff) {
      throw new RangeError("VARCHAR bind exceeds the int32 wire length limit");
    }
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.VARCHAR, false);
    this.writer.writeUint32(0).writeUint32(utf8.length).writeBytes(utf8);
    return this;
  }

  setUuid(index: number, value: string | null): this;
  setUuid(index: number, low: QwpInt64, high: QwpInt64): this;
  setUuid(
    index: number,
    valueOrLow: string | null | QwpInt64,
    high?: QwpInt64,
  ): this {
    if (valueOrLow === null) return this.setNull(index, QWP_COLUMN_TYPE.UUID);
    let lowBits: bigint;
    let highBits: bigint;
    if (typeof valueOrLow === "string") {
      const match =
        /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(
          valueOrLow,
        );
      if (!match) {
        throw new TypeError("UUID bind value must use canonical UUID syntax");
      }
      const hex = match.slice(1).join("");
      highBits = BigInt(`0x${hex.slice(0, 16)}`);
      lowBits = BigInt(`0x${hex.slice(16)}`);
    } else {
      if (high === undefined) {
        throw new TypeError("UUID limb form requires both low and high limbs");
      }
      lowBits = checkedUint64Bits(valueOrLow, "UUID low limb");
      highBits = checkedUint64Bits(high, "UUID high limb");
    }
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.UUID, false);
    this.writer.writeBigUint64(lowBits).writeBigUint64(highBits);
    return this;
  }

  setLong256(
    index: number,
    word0: QwpInt64,
    word1: QwpInt64,
    word2: QwpInt64,
    word3: QwpInt64,
  ): this {
    const words = [word0, word1, word2, word3].map((word, wordIndex) =>
      checkedInt64(word, `LONG256 word ${wordIndex}`),
    );
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.LONG256, false);
    for (const word of words) this.writer.writeBigInt64(word);
    return this;
  }

  setGeohash(index: number, precisionBits: number, value: QwpInt64): this {
    const precision = checkedInteger(
      precisionBits,
      GEOHASH_MIN_BITS,
      GEOHASH_MAX_BITS,
      "GEOHASH precision",
    );
    const mask = (1n << BigInt(precision)) - 1n;
    let bits = checkedInt64(value, "GEOHASH bind") & mask;
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.GEOHASH, false);
    writeQwpVarint(this.writer, precision);
    const byteCount = Math.ceil(precision / 8);
    for (let byteIndex = 0; byteIndex < byteCount; byteIndex++) {
      this.writer.writeUint8(Number(bits & 0xffn));
      bits >>= 8n;
    }
    return this;
  }

  setDecimal64(index: number, scale: number, unscaled: QwpInt64): this {
    const checked = checkedScale(scale, DECIMAL64_MAX_SCALE, "DECIMAL64");
    const value = checkedInt64(unscaled, "DECIMAL64 unscaled value");
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.DECIMAL64, false);
    this.writer.writeUint8(checked).writeBigInt64(value);
    return this;
  }

  setDecimal128(
    index: number,
    scale: number,
    low: QwpInt64,
    high: QwpInt64,
  ): this {
    const checked = checkedScale(scale, DECIMAL128_MAX_SCALE, "DECIMAL128");
    const lowBits = checkedInt64(low, "DECIMAL128 low limb");
    const highBits = checkedInt64(high, "DECIMAL128 high limb");
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.DECIMAL128, false);
    this.writer
      .writeUint8(checked)
      .writeBigInt64(lowBits)
      .writeBigInt64(highBits);
    return this;
  }

  setDecimal256(
    index: number,
    scale: number,
    lowLow: QwpInt64,
    lowHigh: QwpInt64,
    highLow: QwpInt64,
    highHigh: QwpInt64,
  ): this {
    const checked = checkedScale(scale, DECIMAL256_MAX_SCALE, "DECIMAL256");
    const limbs = [lowLow, lowHigh, highLow, highHigh].map((limb, limbIndex) =>
      checkedInt64(limb, `DECIMAL256 limb ${limbIndex}`),
    );
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.DECIMAL256, false);
    this.writer.writeUint8(checked);
    for (const limb of limbs) this.writer.writeBigInt64(limb);
    return this;
  }

  setNull(index: number, type: QwpBindType): this {
    this.assertBindType(type);
    switch (type) {
      case QWP_COLUMN_TYPE.DECIMAL64:
        return this.setNullDecimal64(index, 0);
      case QWP_COLUMN_TYPE.DECIMAL128:
        return this.setNullDecimal128(index, 0);
      case QWP_COLUMN_TYPE.DECIMAL256:
        return this.setNullDecimal256(index, 0);
      case QWP_COLUMN_TYPE.GEOHASH:
        return this.setNullGeohash(index, GEOHASH_MIN_BITS);
      default:
        this.advance(index);
        this.writeHeader(type, true);
        return this;
    }
  }

  setNullDecimal64(index: number, scale: number): this {
    const checked = checkedScale(scale, DECIMAL64_MAX_SCALE, "DECIMAL64");
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.DECIMAL64, true);
    this.writer.writeUint8(checked);
    return this;
  }

  setNullDecimal128(index: number, scale: number): this {
    const checked = checkedScale(scale, DECIMAL128_MAX_SCALE, "DECIMAL128");
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.DECIMAL128, true);
    this.writer.writeUint8(checked);
    return this;
  }

  setNullDecimal256(index: number, scale: number): this {
    const checked = checkedScale(scale, DECIMAL256_MAX_SCALE, "DECIMAL256");
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.DECIMAL256, true);
    this.writer.writeUint8(checked);
    return this;
  }

  setNullGeohash(index: number, precisionBits: number): this {
    const precision = checkedInteger(
      precisionBits,
      GEOHASH_MIN_BITS,
      GEOHASH_MAX_BITS,
      "GEOHASH precision",
    );
    this.advance(index);
    this.writeHeader(QWP_COLUMN_TYPE.GEOHASH, true);
    writeQwpVarint(this.writer, precision);
    return this;
  }

  toUint8Array(): Uint8Array {
    return this.writer.toUint8Array();
  }

  private advance(index: number): void {
    const checked = checkedIndex(index);
    if (checked !== this.expectedIndex) {
      throw new Error(
        `bind index out of order: expected ${this.expectedIndex}, got ${checked}`,
      );
    }
    if (this.expectedIndex >= QWP_MAX_COLUMNS_PER_TABLE) {
      throw new RangeError(
        `too many binds: exceeds ${QWP_MAX_COLUMNS_PER_TABLE}`,
      );
    }
    this.expectedIndex++;
  }

  private assertBindType(type: number): asserts type is QwpBindType {
    switch (type) {
      case QWP_COLUMN_TYPE.BOOLEAN:
      case QWP_COLUMN_TYPE.BYTE:
      case QWP_COLUMN_TYPE.SHORT:
      case QWP_COLUMN_TYPE.CHAR:
      case QWP_COLUMN_TYPE.INT:
      case QWP_COLUMN_TYPE.LONG:
      case QWP_COLUMN_TYPE.FLOAT:
      case QWP_COLUMN_TYPE.DOUBLE:
      case QWP_COLUMN_TYPE.DATE:
      case QWP_COLUMN_TYPE.TIMESTAMP:
      case QWP_COLUMN_TYPE.TIMESTAMP_NANOS:
      case QWP_COLUMN_TYPE.UUID:
      case QWP_COLUMN_TYPE.LONG256:
      case QWP_COLUMN_TYPE.GEOHASH:
      case QWP_COLUMN_TYPE.VARCHAR:
      case QWP_COLUMN_TYPE.DECIMAL64:
      case QWP_COLUMN_TYPE.DECIMAL128:
      case QWP_COLUMN_TYPE.DECIMAL256:
        return;
      default:
        throw new RangeError(
          `unsupported QWP bind type 0x${type.toString(16)}`,
        );
    }
  }

  private writeHeader(type: QwpBindType, isNull: boolean): void {
    this.writer.writeUint8(type).writeUint8(isNull ? NULL_FLAG : NON_NULL_FLAG);
    if (isNull) this.writer.writeUint8(NULL_BITMAP);
  }
}

/** Runs a setter callback and returns the exact QUERY_REQUEST bind section. */
export function encodeQwpBinds(setter: QwpBindSetter): QwpEncodedBinds {
  if (typeof setter !== "function") {
    throw new TypeError("binds must be a function");
  }
  const values = new QwpBindValues();
  const result = setter(values) as unknown;
  if (
    result !== null &&
    (typeof result === "object" || typeof result === "function") &&
    "then" in result &&
    typeof result.then === "function"
  ) {
    throw new TypeError("binds callback must be synchronous");
  }
  return { count: values.count, payload: values.toUint8Array() };
}
