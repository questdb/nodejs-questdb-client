import { decodeUtf8, QwpByteReader } from "./bytes";
import {
  QWP_COLUMN_TYPE,
  QWP_FLAG_DELTA_SYMBOL_DICTIONARY,
  QWP_FLAG_GORILLA,
  QWP_FLAG_ZSTD,
  QWP_MAX_COLUMN_NAME_LENGTH,
  QWP_MAX_COLUMNS_PER_TABLE,
  QWP_MAX_TABLE_NAME_LENGTH,
  QWP_RESET_MASK_DICTIONARY,
  QwpColumnType,
} from "./constants";
import { QwpResultBatchMessage } from "./egress";
import { QwpProtocolError } from "./errors";
import { readQwpVarint } from "./varint";
import { decompressQwpZstdFrame } from "./zstd";

const MAX_ARRAY_DIMENSION_LENGTH = (1 << 28) - 1;
const MAX_ARRAY_ELEMENTS = 268_435_327;
const MAX_CONNECTION_SYMBOLS = 8_388_608;
const MAX_ROWS_PER_BATCH = 1_048_576;

export interface QwpDecimalValue {
  unscaled: bigint;
  scale: number;
}

export interface QwpUuidValue {
  low: bigint;
  high: bigint;
}

export interface QwpLong256Value {
  /** Little-endian 64-bit words; word 0 is least significant. */
  words: readonly [bigint, bigint, bigint, bigint];
}

export interface QwpGeohashValue {
  bits: bigint;
  precisionBits: number;
}

export interface QwpResultArrayValue {
  dimensions: readonly number[];
  values: readonly number[] | readonly bigint[];
}

export type QwpResultValue =
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | QwpDecimalValue
  | QwpUuidValue
  | QwpLong256Value
  | QwpGeohashValue
  | QwpResultArrayValue
  | null;

export interface QwpResultColumnSchema {
  name: string;
  type: QwpColumnType;
}

export interface QwpResultColumn extends QwpResultColumnSchema {
  values: readonly QwpResultValue[];
  scale?: number;
  precisionBits?: number;
}

export class QwpResultBatch {
  constructor(
    readonly requestId: bigint,
    readonly batchSequence: bigint,
    readonly tableName: string,
    readonly rowCount: number,
    readonly columns: readonly QwpResultColumn[],
  ) {}

  get(rowIndex: number, columnIndex: number): QwpResultValue {
    if (
      !Number.isInteger(rowIndex) ||
      rowIndex < 0 ||
      rowIndex >= this.rowCount
    ) {
      throw new RangeError(`row index out of range: ${rowIndex}`);
    }
    const column = this.columns[columnIndex];
    if (!column)
      throw new RangeError(`column index out of range: ${columnIndex}`);
    return column.values[rowIndex];
  }

  *rows(): IterableIterator<readonly QwpResultValue[]> {
    for (let row = 0; row < this.rowCount; row++) {
      yield this.columns.map((column) => column.values[row]);
    }
  }
}

interface NullLayout {
  nulls: boolean[];
  nonNullCount: number;
}

class QwpBitReader {
  private bitPosition = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get bytesConsumed(): number {
    return Math.ceil(this.bitPosition / 8);
  }

  readBit(): number {
    if (this.bitPosition >= this.bytes.length * 8) {
      throw new QwpProtocolError("truncated QWP Gorilla bitstream");
    }
    const result =
      (this.bytes[this.bitPosition >>> 3] >>> (this.bitPosition & 7)) & 1;
    this.bitPosition++;
    return result;
  }

  readSigned(bitCount: number): bigint {
    let value = 0n;
    for (let bit = 0; bit < bitCount; bit++) {
      if (this.readBit() !== 0) value |= 1n << BigInt(bit);
    }
    const sign = 1n << BigInt(bitCount - 1);
    return (value & sign) === 0n ? value : value - (1n << BigInt(bitCount));
  }
}

function readCount(
  reader: QwpByteReader,
  maximum: number,
  label: string,
): number {
  const value = readQwpVarint(reader);
  if (value > BigInt(maximum)) {
    throw new QwpProtocolError(`${label} out of range: ${value}`);
  }
  return Number(value);
}

function readNullLayout(reader: QwpByteReader, rowCount: number): NullLayout {
  const flag = reader.readUint8("column null flag");
  if (flag !== 0 && flag !== 1) {
    throw new QwpProtocolError(`invalid column null flag: ${flag}`);
  }
  const nulls = new Array<boolean>(rowCount).fill(false);
  if (flag === 0) return { nulls, nonNullCount: rowCount };

  const bitmap = reader.readBytes(
    Math.ceil(rowCount / 8),
    "column null bitmap",
  );
  let nonNullCount = rowCount;
  for (let row = 0; row < rowCount; row++) {
    if ((bitmap[row >>> 3] & (1 << (row & 7))) !== 0) {
      nulls[row] = true;
      nonNullCount--;
    }
  }
  return { nulls, nonNullCount };
}

function expandNulls<T extends QwpResultValue>(
  dense: readonly T[],
  layout: NullLayout,
): QwpResultValue[] {
  const values = new Array<QwpResultValue>(layout.nulls.length);
  let denseIndex = 0;
  for (let row = 0; row < layout.nulls.length; row++) {
    values[row] = layout.nulls[row] ? null : dense[denseIndex++];
  }
  return values;
}

function readSignedLittleEndian(
  reader: QwpByteReader,
  byteCount: number,
  label: string,
): bigint {
  const bytes = reader.readBytes(byteCount, label);
  let value = 0n;
  for (let index = 0; index < byteCount; index++) {
    value |= BigInt(bytes[index]) << BigInt(index * 8);
  }
  const bits = BigInt(byteCount * 8);
  const sign = 1n << (bits - 1n);
  return (value & sign) === 0n ? value : value - (1n << bits);
}

function readStringValues(
  reader: QwpByteReader,
  count: number,
  binary: boolean,
): (string | Uint8Array)[] {
  const offsets = new Array<number>(count + 1);
  for (let index = 0; index <= count; index++) {
    offsets[index] = reader.readUint32("variable-width column offset");
  }
  if (offsets[0] !== 0) {
    throw new QwpProtocolError(
      "variable-width column must start at offset zero",
    );
  }
  for (let index = 1; index < offsets.length; index++) {
    if (offsets[index] < offsets[index - 1]) {
      throw new QwpProtocolError(
        `variable-width column offsets are not monotonic at index ${index}`,
      );
    }
  }
  const bytes = reader.readBytes(offsets[count], "variable-width column data");
  const values = new Array<string | Uint8Array>(count);
  for (let index = 0; index < count; index++) {
    const value = bytes.subarray(offsets[index], offsets[index + 1]);
    values[index] = binary ? value.slice() : decodeUtf8(value);
  }
  return values;
}

function decodeGorillaValues(reader: QwpByteReader, count: number): bigint[] {
  if (count < 3) {
    throw new QwpProtocolError(
      `Gorilla-encoded column has fewer than three values: ${count}`,
    );
  }
  const first = reader.readBigInt64("first Gorilla timestamp");
  const second = reader.readBigInt64("second Gorilla timestamp");
  const values = [first, second];
  const bits = new QwpBitReader(
    reader.bytes.subarray(reader.position, reader.position + reader.remaining),
  );
  let previousTimestamp = second;
  let previousDelta = BigInt.asIntN(64, second - first);
  for (let index = 2; index < count; index++) {
    let deltaOfDelta: bigint;
    let prefixOnes = 0;
    while (prefixOnes < 4 && bits.readBit() !== 0) prefixOnes++;
    switch (prefixOnes) {
      case 0:
        deltaOfDelta = 0n;
        break;
      case 1:
        deltaOfDelta = bits.readSigned(7);
        break;
      case 2:
        deltaOfDelta = bits.readSigned(9);
        break;
      case 3:
        deltaOfDelta = bits.readSigned(12);
        break;
      default:
        deltaOfDelta = bits.readSigned(32);
    }
    const delta = BigInt.asIntN(64, previousDelta + deltaOfDelta);
    const timestamp = BigInt.asIntN(64, previousTimestamp + delta);
    values.push(timestamp);
    previousDelta = delta;
    previousTimestamp = timestamp;
  }
  reader.readBytes(bits.bytesConsumed, "Gorilla bitstream");
  return values;
}

function readTimestampValues(
  reader: QwpByteReader,
  count: number,
  gorilla: boolean,
): bigint[] {
  if (!gorilla) {
    return Array.from({ length: count }, () =>
      reader.readBigInt64("timestamp value"),
    );
  }
  const encoding = reader.readUint8("timestamp encoding");
  if (encoding === 0) {
    return Array.from({ length: count }, () =>
      reader.readBigInt64("timestamp value"),
    );
  }
  if (encoding !== 1) {
    throw new QwpProtocolError(`unknown timestamp encoding: ${encoding}`);
  }
  return decodeGorillaValues(reader, count);
}

function readArrayValue(
  reader: QwpByteReader,
  type: QwpColumnType,
): QwpResultArrayValue {
  const dimensions = reader.readUint8("array dimension count");
  if (dimensions < 1 || dimensions > 32) {
    throw new QwpProtocolError(
      `array dimension count out of range: ${dimensions}`,
    );
  }
  const shape = new Array<number>(dimensions);
  let elementCount = 1;
  for (let index = 0; index < dimensions; index++) {
    const length = reader.readInt32("array dimension length");
    if (length < 0 || length > MAX_ARRAY_DIMENSION_LENGTH) {
      throw new QwpProtocolError(
        `array dimension length out of range: ${length}`,
      );
    }
    shape[index] = length;
    elementCount *= length;
    if (elementCount > MAX_ARRAY_ELEMENTS) {
      throw new QwpProtocolError(
        `array element count exceeds ${MAX_ARRAY_ELEMENTS}`,
      );
    }
  }
  if (elementCount > Math.floor(reader.remaining / 8)) {
    throw new QwpProtocolError("truncated array payload");
  }
  if (type === QWP_COLUMN_TYPE.DOUBLE_ARRAY) {
    return {
      dimensions: shape,
      values: Array.from({ length: elementCount }, () =>
        reader.readFloat64("double array element"),
      ),
    };
  }
  return {
    dimensions: shape,
    values: Array.from({ length: elementCount }, () =>
      reader.readBigInt64("long array element"),
    ),
  };
}

/** Stateful decoder for connection-scoped QWP result batches. */
export class QwpResultBatchDecoder {
  private readonly symbolDictionary: string[] = [];
  private schema?: QwpResultColumnSchema[];
  private expectedBatchSequence = 0n;

  resetQuerySchema(): void {
    this.schema = undefined;
    this.expectedBatchSequence = 0n;
  }

  applyCacheReset(resetMask: number): void {
    if ((resetMask & QWP_RESET_MASK_DICTIONARY) !== 0) {
      this.symbolDictionary.length = 0;
    }
  }

  decode(message: QwpResultBatchMessage): QwpResultBatch {
    if (message.tableCount !== 1) {
      throw new QwpProtocolError(
        `RESULT_BATCH must contain exactly one table, got ${message.tableCount}`,
      );
    }
    if (message.batchSequence !== this.expectedBatchSequence) {
      throw new QwpProtocolError(
        `unexpected RESULT_BATCH sequence [expected=${this.expectedBatchSequence}, actual=${message.batchSequence}]`,
      );
    }

    const body =
      (message.flags & QWP_FLAG_ZSTD) !== 0
        ? decompressQwpZstdFrame(message.body)
        : message.body;
    const reader = new QwpByteReader(body);
    const deltaMode = (message.flags & QWP_FLAG_DELTA_SYMBOL_DICTIONARY) !== 0;
    if (deltaMode) this.readDeltaDictionary(reader);

    const tableNameLength = readCount(
      reader,
      QWP_MAX_TABLE_NAME_LENGTH,
      "table name length",
    );
    const tableName = reader.readUtf8(tableNameLength, "table name");
    const rowCount = readCount(reader, MAX_ROWS_PER_BATCH, "result row count");

    if (message.batchSequence === 0n) {
      const columnCount = readCount(
        reader,
        QWP_MAX_COLUMNS_PER_TABLE,
        "result column count",
      );
      this.schema = Array.from({ length: columnCount }, () => {
        const nameLength = readCount(
          reader,
          QWP_MAX_COLUMN_NAME_LENGTH,
          "column name length",
        );
        const name = reader.readUtf8(nameLength, "column name");
        const type = reader.readUint8("column type") as QwpColumnType;
        if (!Object.values(QWP_COLUMN_TYPE).includes(type)) {
          throw new QwpProtocolError(
            `unsupported QWP result column type: 0x${type.toString(16)}`,
          );
        }
        return { name, type };
      });
    } else if (!this.schema) {
      throw new QwpProtocolError(
        "continuation RESULT_BATCH arrived before its schema-bearing batch",
      );
    }

    const columns = this.schema!.map((column) =>
      this.readColumn(reader, column, rowCount, deltaMode, message.flags),
    );
    reader.expectEnd("RESULT_BATCH");
    this.expectedBatchSequence++;
    return new QwpResultBatch(
      message.requestId,
      message.batchSequence,
      tableName,
      rowCount,
      columns,
    );
  }

  private readColumn(
    reader: QwpByteReader,
    schema: QwpResultColumnSchema,
    rowCount: number,
    deltaMode: boolean,
    flags: number,
  ): QwpResultColumn {
    const layout = readNullLayout(reader, rowCount);
    const count = layout.nonNullCount;
    let dense: QwpResultValue[];
    let scale: number | undefined;
    let precisionBits: number | undefined;

    switch (schema.type) {
      case QWP_COLUMN_TYPE.BOOLEAN: {
        const bytes = reader.readBytes(Math.ceil(count / 8), "boolean values");
        dense = Array.from(
          { length: count },
          (_, index) => (bytes[index >>> 3] & (1 << (index & 7))) !== 0,
        );
        break;
      }
      case QWP_COLUMN_TYPE.BYTE:
        dense = Array.from({ length: count }, () =>
          reader.readInt8("byte value"),
        );
        break;
      case QWP_COLUMN_TYPE.SHORT:
        dense = Array.from({ length: count }, () =>
          reader.readInt16("short value"),
        );
        break;
      case QWP_COLUMN_TYPE.CHAR:
        dense = Array.from({ length: count }, () =>
          String.fromCharCode(reader.readUint16("char value")),
        );
        break;
      case QWP_COLUMN_TYPE.INT:
      case QWP_COLUMN_TYPE.IPV4:
        dense = Array.from({ length: count }, () =>
          reader.readInt32("int value"),
        );
        break;
      case QWP_COLUMN_TYPE.FLOAT:
        dense = Array.from({ length: count }, () =>
          reader.readFloat32("float value"),
        );
        break;
      case QWP_COLUMN_TYPE.DOUBLE:
        dense = Array.from({ length: count }, () =>
          reader.readFloat64("double value"),
        );
        break;
      case QWP_COLUMN_TYPE.LONG:
        dense = Array.from({ length: count }, () =>
          reader.readBigInt64("long value"),
        );
        break;
      case QWP_COLUMN_TYPE.DATE:
      case QWP_COLUMN_TYPE.TIMESTAMP:
      case QWP_COLUMN_TYPE.TIMESTAMP_NANOS:
        dense = readTimestampValues(
          reader,
          count,
          (flags & QWP_FLAG_GORILLA) !== 0,
        );
        break;
      case QWP_COLUMN_TYPE.VARCHAR:
        dense = readStringValues(reader, count, false);
        break;
      case QWP_COLUMN_TYPE.BINARY:
        dense = readStringValues(reader, count, true);
        break;
      case QWP_COLUMN_TYPE.SYMBOL:
        dense = this.readSymbols(reader, count, rowCount, deltaMode);
        break;
      case QWP_COLUMN_TYPE.UUID:
        dense = Array.from({ length: count }, () => ({
          low: reader.readBigUint64("UUID low bits"),
          high: reader.readBigUint64("UUID high bits"),
        }));
        break;
      case QWP_COLUMN_TYPE.LONG256:
        dense = Array.from({ length: count }, () => ({
          words: [
            reader.readBigInt64("LONG256 word 0"),
            reader.readBigInt64("LONG256 word 1"),
            reader.readBigInt64("LONG256 word 2"),
            reader.readBigInt64("LONG256 word 3"),
          ] as const,
        }));
        break;
      case QWP_COLUMN_TYPE.DECIMAL64:
      case QWP_COLUMN_TYPE.DECIMAL128:
      case QWP_COLUMN_TYPE.DECIMAL256: {
        scale = reader.readUint8("decimal scale");
        const bytes =
          schema.type === QWP_COLUMN_TYPE.DECIMAL64
            ? 8
            : schema.type === QWP_COLUMN_TYPE.DECIMAL128
              ? 16
              : 32;
        dense = Array.from({ length: count }, () => ({
          unscaled: readSignedLittleEndian(reader, bytes, "decimal value"),
          scale: scale!,
        }));
        break;
      }
      case QWP_COLUMN_TYPE.GEOHASH: {
        precisionBits = readCount(reader, 60, "geohash precision");
        if (precisionBits < 1) {
          throw new QwpProtocolError(
            `geohash precision out of range: ${precisionBits}`,
          );
        }
        const byteCount = Math.ceil(precisionBits / 8);
        dense = Array.from({ length: count }, () => {
          const bytes = reader.readBytes(byteCount, "geohash value");
          let bits = 0n;
          for (let index = 0; index < bytes.length; index++) {
            bits |= BigInt(bytes[index]) << BigInt(index * 8);
          }
          return { bits, precisionBits: precisionBits! };
        });
        break;
      }
      case QWP_COLUMN_TYPE.DOUBLE_ARRAY:
      case QWP_COLUMN_TYPE.LONG_ARRAY:
        dense = Array.from({ length: count }, () =>
          readArrayValue(reader, schema.type),
        );
        break;
      default:
        throw new QwpProtocolError(
          `unsupported QWP result column type: ${String(schema.type)}`,
        );
    }

    return {
      ...schema,
      values: expandNulls(dense, layout),
      ...(scale === undefined ? {} : { scale }),
      ...(precisionBits === undefined ? {} : { precisionBits }),
    };
  }

  private readDeltaDictionary(reader: QwpByteReader): void {
    const start = readCount(
      reader,
      MAX_CONNECTION_SYMBOLS,
      "delta dictionary start",
    );
    const count = readCount(
      reader,
      MAX_CONNECTION_SYMBOLS,
      "delta dictionary count",
    );
    if (start !== this.symbolDictionary.length) {
      throw new QwpProtocolError(
        `delta symbol dictionary is out of sync [expected=${this.symbolDictionary.length}, actual=${start}]`,
      );
    }
    if (start + count > MAX_CONNECTION_SYMBOLS) {
      throw new QwpProtocolError(
        `symbol dictionary exceeds ${MAX_CONNECTION_SYMBOLS} entries`,
      );
    }
    for (let index = 0; index < count; index++) {
      const length = readCount(reader, reader.remaining, "symbol length");
      this.symbolDictionary.push(reader.readUtf8(length, "symbol"));
    }
  }

  private readSymbols(
    reader: QwpByteReader,
    count: number,
    rowCount: number,
    deltaMode: boolean,
  ): string[] {
    let dictionary: readonly string[];
    if (deltaMode) {
      dictionary = this.symbolDictionary;
    } else {
      const size = readCount(reader, rowCount, "symbol dictionary size");
      const local = new Array<string>(size);
      for (let index = 0; index < size; index++) {
        const length = readCount(reader, reader.remaining, "symbol length");
        local[index] = reader.readUtf8(length, "symbol");
      }
      dictionary = local;
    }
    return Array.from({ length: count }, () => {
      const id = readCount(reader, dictionary.length, "symbol ID");
      if (id >= dictionary.length) {
        throw new QwpProtocolError(`symbol ID out of range: ${id}`);
      }
      return dictionary[id];
    });
  }
}
