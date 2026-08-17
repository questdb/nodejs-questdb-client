import { encodeUtf8, QwpByteReader, QwpByteWriter, utf8Length } from "./bytes";
import {
  QWP_COLUMN_TYPE,
  QWP_ENCODING_GORILLA,
  QWP_ENCODING_UNCOMPRESSED,
  QWP_FLAG_DEFER_COMMIT,
  QWP_FLAG_DELTA_SYMBOL_DICTIONARY,
  QWP_FLAG_DURABLE_ACK_POLL,
  QWP_FLAG_GORILLA,
  QWP_HEADER_SIZE,
  QWP_MAX_ERROR_MESSAGE_LENGTH,
  QWP_MAX_ROWS_PER_TABLE,
  QWP_MAX_SYMBOL_DICTIONARY_SIZE,
  QWP_STATUS,
  QwpColumnType,
} from "./constants";
import { decodeQwpFrame, writeQwpFrameHeader } from "./frame";
import { QwpProtocolError } from "./errors";
import { encodeQwpGorilla, qwpGorillaSize } from "./gorilla";
import { QwpSymbolDictionary } from "./symbol-dictionary";
import {
  QwpArrayValue,
  QwpColumnBuffer,
  QwpSymbolValue,
  QwpTableBuffer,
} from "./table";
import { qwpVarintSize, readQwpVarintNumber, writeQwpVarint } from "./varint";

export interface QwpIngressEncodeOptions {
  gorilla?: boolean;
  /** Present means connection-scoped delta dictionary mode. */
  dictionary?: QwpSymbolDictionary;
  /** Highest global symbol ID already published on this logical connection. */
  confirmedMaxSymbolId?: number;
  deferCommit?: boolean;
}

interface ColumnEncodeOptions {
  gorilla: boolean;
  deltaSymbols: boolean;
  dictionary?: QwpSymbolDictionary;
}

export interface QwpIngressTableResult {
  name: string;
  sequenceTransaction: bigint;
}

export interface QwpIngressResponse {
  status: number;
  sequence: bigint | null;
  tables: QwpIngressTableResult[];
  errorMessage?: string;
}

function symbolText(value: unknown): string {
  return typeof value === "string" ? value : (value as QwpSymbolValue).text;
}

function symbolId(value: unknown, dictionary: QwpSymbolDictionary): number {
  if (typeof value === "string") return dictionary.getOrAdd(value);
  const id = typeof value === "number" ? value : (value as QwpSymbolValue).id;
  if (!Number.isSafeInteger(id) || id < 0 || id >= dictionary.size) {
    throw new Error(`QWP symbol ID is outside the dictionary: ${id}`);
  }
  if (typeof value !== "number") {
    const symbol = value as QwpSymbolValue;
    if (dictionary.valueAt(id) !== symbol.text) {
      throw new Error(
        `QWP symbol value does not match dictionary ID ${id}: '${symbol.text}'`,
      );
    }
  }
  return id;
}

function nullCount(column: QwpColumnBuffer): number {
  let count = 0;
  for (const value of column.nulls) if (value) count++;
  return count;
}

function fixedWidth(type: QwpColumnType): number | undefined {
  switch (type) {
    case QWP_COLUMN_TYPE.BYTE:
      return 1;
    case QWP_COLUMN_TYPE.SHORT:
    case QWP_COLUMN_TYPE.CHAR:
      return 2;
    case QWP_COLUMN_TYPE.INT:
    case QWP_COLUMN_TYPE.FLOAT:
    case QWP_COLUMN_TYPE.IPV4:
      return 4;
    case QWP_COLUMN_TYPE.LONG:
    case QWP_COLUMN_TYPE.DOUBLE:
    case QWP_COLUMN_TYPE.DATE:
      return 8;
    case QWP_COLUMN_TYPE.UUID:
      return 16;
    case QWP_COLUMN_TYPE.LONG256:
      return 32;
    default:
      return undefined;
  }
}

function qwpStringSize(value: string): number {
  const length = utf8Length(value);
  return qwpVarintSize(length) + length;
}

function writeQwpString(writer: QwpByteWriter, value: string): void {
  const bytes = encodeUtf8(value);
  writeQwpVarint(writer, bytes.length);
  writer.writeBytes(bytes);
}

function binaryValue(value: unknown, width?: number): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error("QWP binary values must be Uint8Array instances");
  }
  if (width !== undefined && value.length !== width) {
    throw new Error(
      `QWP binary value has length ${value.length}; expected ${width}`,
    );
  }
  return value;
}

function columnPayloadSize(
  column: QwpColumnBuffer,
  rowCount: number,
  options: ColumnEncodeOptions,
): number {
  let size = 1;
  if (nullCount(column) > 0) size += Math.ceil(rowCount / 8);
  const valueCount = column.values.length;

  if (column.type === QWP_COLUMN_TYPE.BOOLEAN) {
    return size + Math.ceil(valueCount / 8);
  }

  if (
    column.type === QWP_COLUMN_TYPE.TIMESTAMP ||
    column.type === QWP_COLUMN_TYPE.TIMESTAMP_NANOS
  ) {
    if (!options.gorilla) return size + valueCount * 8;
    const timestamps = column.values.map((value) => BigInt(value as bigint));
    const gorillaSize = timestamps.length > 2 ? qwpGorillaSize(timestamps) : -1;
    return size + 1 + (gorillaSize > 0 ? gorillaSize : valueCount * 8);
  }

  const width = fixedWidth(column.type);
  if (width !== undefined) return size + valueCount * width;

  if (column.type === QWP_COLUMN_TYPE.SYMBOL) {
    if (options.deltaSymbols) {
      for (const value of column.values) {
        size += qwpVarintSize(symbolId(value, options.dictionary!));
      }
      return size;
    }
    const dictionary = [
      ...new Set(column.values.map((value) => symbolText(value))),
    ];
    size += qwpVarintSize(dictionary.length);
    for (const value of dictionary) size += qwpStringSize(value);
    for (const value of column.values) {
      size += qwpVarintSize(dictionary.indexOf(symbolText(value)));
    }
    return size;
  }

  if (
    column.type === QWP_COLUMN_TYPE.VARCHAR ||
    column.type === QWP_COLUMN_TYPE.BINARY
  ) {
    let dataLength = 0;
    for (const value of column.values) {
      dataLength +=
        column.type === QWP_COLUMN_TYPE.VARCHAR
          ? utf8Length(value as string)
          : binaryValue(value).length;
    }
    return size + (valueCount + 1) * 4 + dataLength;
  }

  if (
    column.type === QWP_COLUMN_TYPE.DOUBLE_ARRAY ||
    column.type === QWP_COLUMN_TYPE.LONG_ARRAY
  ) {
    for (const value of column.values) {
      const array = value as QwpArrayValue;
      size += 1 + array.dimensions.length * 4 + array.values.length * 8;
    }
    return size;
  }

  if (column.type === QWP_COLUMN_TYPE.GEOHASH) {
    const precision = column.geohashPrecision ?? 1;
    return (
      size + qwpVarintSize(precision) + valueCount * Math.ceil(precision / 8)
    );
  }

  if (column.type === QWP_COLUMN_TYPE.DECIMAL64) {
    return size + 1 + valueCount * 8;
  }
  if (column.type === QWP_COLUMN_TYPE.DECIMAL128) {
    return size + 1 + valueCount * 16;
  }
  if (column.type === QWP_COLUMN_TYPE.DECIMAL256) {
    return size + 1 + valueCount * 32;
  }

  throw new Error(`unsupported QWP column type 0x${column.type.toString(16)}`);
}

function writeNullHeader(
  writer: QwpByteWriter,
  column: QwpColumnBuffer,
  rowCount: number,
): void {
  if (nullCount(column) === 0) {
    writer.writeUint8(0);
    return;
  }
  writer.writeUint8(1);
  const bitmap = new Uint8Array(Math.ceil(rowCount / 8));
  for (let row = 0; row < rowCount; row++) {
    if (column.nulls[row]) bitmap[row >>> 3] |= 1 << (row & 7);
  }
  writer.writeBytes(bitmap);
}

function writeSignedLittleEndian(
  writer: QwpByteWriter,
  value: bigint,
  width: number,
): void {
  let remaining = BigInt.asIntN(width * 8, value);
  for (let index = 0; index < width; index++) {
    writer.writeUint8(Number(remaining & 0xffn));
    remaining >>= 8n;
  }
}

function writeColumn(
  writer: QwpByteWriter,
  column: QwpColumnBuffer,
  rowCount: number,
  options: ColumnEncodeOptions,
): void {
  writeNullHeader(writer, column, rowCount);

  switch (column.type) {
    case QWP_COLUMN_TYPE.BOOLEAN: {
      const bitmap = new Uint8Array(Math.ceil(column.values.length / 8));
      column.values.forEach((value, index) => {
        if (value) bitmap[index >>> 3] |= 1 << (index & 7);
      });
      writer.writeBytes(bitmap);
      return;
    }
    case QWP_COLUMN_TYPE.BYTE:
      for (const value of column.values) writer.writeInt8(Number(value));
      return;
    case QWP_COLUMN_TYPE.SHORT:
      for (const value of column.values) writer.writeInt16(Number(value));
      return;
    case QWP_COLUMN_TYPE.CHAR:
      for (const value of column.values) {
        const text = value as string;
        if (text.length !== 1) {
          throw new Error("QWP CHAR values must contain one UTF-16 code unit");
        }
        writer.writeUint16(text.charCodeAt(0));
      }
      return;
    case QWP_COLUMN_TYPE.INT:
      for (const value of column.values) writer.writeInt32(Number(value));
      return;
    case QWP_COLUMN_TYPE.IPV4:
      for (const value of column.values)
        writer.writeUint32(Number(value) >>> 0);
      return;
    case QWP_COLUMN_TYPE.FLOAT:
      for (const value of column.values) writer.writeFloat32(Number(value));
      return;
    case QWP_COLUMN_TYPE.LONG:
    case QWP_COLUMN_TYPE.DATE:
      for (const value of column.values) {
        writer.writeBigInt64(BigInt(value as number | bigint));
      }
      return;
    case QWP_COLUMN_TYPE.TIMESTAMP:
    case QWP_COLUMN_TYPE.TIMESTAMP_NANOS: {
      const timestamps = column.values.map((value) => BigInt(value as bigint));
      if (!options.gorilla) {
        for (const timestamp of timestamps) writer.writeBigInt64(timestamp);
        return;
      }
      const gorillaSize =
        timestamps.length > 2 ? qwpGorillaSize(timestamps) : -1;
      if (gorillaSize > 0) {
        writer.writeUint8(QWP_ENCODING_GORILLA);
        writer.writeBytes(encodeQwpGorilla(timestamps));
      } else {
        writer.writeUint8(QWP_ENCODING_UNCOMPRESSED);
        for (const timestamp of timestamps) writer.writeBigInt64(timestamp);
      }
      return;
    }
    case QWP_COLUMN_TYPE.DOUBLE:
      for (const value of column.values) writer.writeFloat64(Number(value));
      return;
    case QWP_COLUMN_TYPE.UUID:
      for (const value of column.values) {
        writer.writeBytes(binaryValue(value, 16));
      }
      return;
    case QWP_COLUMN_TYPE.LONG256:
      for (const value of column.values) {
        writer.writeBytes(binaryValue(value, 32));
      }
      return;
    case QWP_COLUMN_TYPE.SYMBOL: {
      if (options.deltaSymbols) {
        for (const value of column.values) {
          writeQwpVarint(writer, symbolId(value, options.dictionary!));
        }
        return;
      }
      const dictionary = [
        ...new Set(column.values.map((value) => symbolText(value))),
      ];
      writeQwpVarint(writer, dictionary.length);
      for (const value of dictionary) writeQwpString(writer, value);
      for (const value of column.values) {
        writeQwpVarint(writer, dictionary.indexOf(symbolText(value)));
      }
      return;
    }
    case QWP_COLUMN_TYPE.VARCHAR:
    case QWP_COLUMN_TYPE.BINARY: {
      const parts = column.values.map((value) =>
        column.type === QWP_COLUMN_TYPE.VARCHAR
          ? encodeUtf8(value as string)
          : binaryValue(value),
      );
      let cumulative = 0;
      writer.writeUint32(0);
      for (const part of parts) {
        cumulative += part.length;
        writer.writeUint32(cumulative);
      }
      for (const part of parts) writer.writeBytes(part);
      return;
    }
    case QWP_COLUMN_TYPE.DOUBLE_ARRAY:
    case QWP_COLUMN_TYPE.LONG_ARRAY:
      for (const value of column.values) {
        const array = value as QwpArrayValue;
        writer.writeUint8(array.dimensions.length);
        for (const dimension of array.dimensions) writer.writeUint32(dimension);
        for (const item of array.values) {
          if (column.type === QWP_COLUMN_TYPE.DOUBLE_ARRAY) {
            writer.writeFloat64(Number(item));
          } else {
            writer.writeBigInt64(BigInt(item));
          }
        }
      }
      return;
    case QWP_COLUMN_TYPE.GEOHASH: {
      const precision = column.geohashPrecision ?? 1;
      writeQwpVarint(writer, precision);
      const width = Math.ceil(precision / 8);
      for (const value of column.values) {
        let remaining = BigInt(value as bigint);
        for (let index = 0; index < width; index++) {
          writer.writeUint8(Number(remaining & 0xffn));
          remaining >>= 8n;
        }
      }
      return;
    }
    case QWP_COLUMN_TYPE.DECIMAL64:
    case QWP_COLUMN_TYPE.DECIMAL128:
    case QWP_COLUMN_TYPE.DECIMAL256: {
      writer.writeUint8(column.decimalScale ?? 0);
      const width =
        column.type === QWP_COLUMN_TYPE.DECIMAL64
          ? 8
          : column.type === QWP_COLUMN_TYPE.DECIMAL128
            ? 16
            : 32;
      for (const value of column.values) {
        writeSignedLittleEndian(writer, BigInt(value as bigint), width);
      }
      return;
    }
    default:
      throw new Error("unsupported QWP column type");
  }
}

function tableSize(
  table: QwpTableBuffer,
  options: ColumnEncodeOptions,
): number {
  let size =
    qwpStringSize(table.name) +
    qwpVarintSize(table.rowCount) +
    qwpVarintSize(table.columns.length);
  for (const column of table.columns) size += qwpStringSize(column.name) + 1;
  for (const column of table.columns) {
    size += columnPayloadSize(column, table.rowCount, options);
  }
  return size;
}

function validateTableForEncoding(table: QwpTableBuffer): void {
  for (const column of table.columns) {
    if (
      column.size !== table.rowCount ||
      column.nulls.length !== table.rowCount
    ) {
      throw new Error(
        `table '${table.name}' has an unfinished row in column '${column.name}'`,
      );
    }
    let nonNullCount = 0;
    for (const isNull of column.nulls) if (!isNull) nonNullCount++;
    if (nonNullCount !== column.values.length) {
      throw new Error(
        `table '${table.name}' column '${column.name}' has ${nonNullCount} non-null row(s) but ${column.values.length} value(s)`,
      );
    }
  }
}

/** Encodes one QWP v1 ingress message. */
export function encodeQwpIngressFrame(
  tables: readonly QwpTableBuffer[],
  options: QwpIngressEncodeOptions = {},
): Uint8Array {
  const dictionarySize = options.dictionary?.size;
  try {
    return encodeQwpIngressFrameInternal(tables, options);
  } catch (error) {
    if (dictionarySize !== undefined)
      options.dictionary!.truncate(dictionarySize);
    throw error;
  }
}

function encodeQwpIngressFrameInternal(
  tables: readonly QwpTableBuffer[],
  options: QwpIngressEncodeOptions,
): Uint8Array {
  if (tables.length > 0xffff) {
    throw new Error("QWP frame contains more than 65535 tables");
  }
  for (const table of tables) {
    validateTableForEncoding(table);
    if (table.rowCount > QWP_MAX_ROWS_PER_TABLE) {
      throw new Error(
        `table '${table.name}' contains ${table.rowCount} rows; maximum is ${QWP_MAX_ROWS_PER_TABLE}`,
      );
    }
  }

  const gorilla = options.gorilla ?? true;
  const deltaSymbols = options.dictionary !== undefined;
  if (deltaSymbols) {
    const published = options.confirmedMaxSymbolId ?? -1;
    if (
      !Number.isSafeInteger(published) ||
      published < -1 ||
      published >= options.dictionary!.size
    ) {
      throw new RangeError(
        `published symbol dictionary ID is out of range [id=${published}, size=${options.dictionary!.size}]`,
      );
    }
  }
  if (deltaSymbols) {
    // Resolve string values before calculating the delta prefix and frame size.
    for (const table of tables) {
      for (const column of table.columns) {
        if (column.type !== QWP_COLUMN_TYPE.SYMBOL) continue;
        for (const value of column.values) {
          if (typeof value === "string") options.dictionary!.getOrAdd(value);
        }
      }
    }
  }
  const deltaStart = deltaSymbols
    ? (options.confirmedMaxSymbolId ?? -1) + 1
    : 0;
  const dictionaryEntries = deltaSymbols
    ? options.dictionary!.entriesFrom(deltaStart)
    : [];
  const columnOptions = {
    gorilla,
    deltaSymbols,
    dictionary: options.dictionary,
  };

  let flags = 0;
  if (gorilla) flags |= QWP_FLAG_GORILLA;
  if (deltaSymbols) flags |= QWP_FLAG_DELTA_SYMBOL_DICTIONARY;
  if (options.deferCommit) flags |= QWP_FLAG_DEFER_COMMIT;

  let payloadLength = 0;
  if (deltaSymbols) {
    payloadLength +=
      qwpVarintSize(deltaStart) + qwpVarintSize(dictionaryEntries.length);
    for (const entry of dictionaryEntries)
      payloadLength += qwpStringSize(entry);
  }
  for (const table of tables) payloadLength += tableSize(table, columnOptions);

  const writer = new QwpByteWriter(QWP_HEADER_SIZE + payloadLength);
  writeQwpFrameHeader(writer, {
    flags,
    tableCount: tables.length,
    payloadLength,
  });
  if (deltaSymbols) {
    writeQwpVarint(writer, deltaStart);
    writeQwpVarint(writer, dictionaryEntries.length);
    for (const entry of dictionaryEntries) writeQwpString(writer, entry);
  }
  for (const table of tables) {
    writeQwpString(writer, table.name);
    writeQwpVarint(writer, table.rowCount);
    writeQwpVarint(writer, table.columns.length);
    for (const column of table.columns) {
      writeQwpString(writer, column.name);
      writer.writeUint8(column.type);
    }
    for (const column of table.columns) {
      writeColumn(writer, column, table.rowCount, columnOptions);
    }
  }
  const result = writer.toUint8Array();
  if (result.length !== QWP_HEADER_SIZE + payloadLength) {
    throw new Error(
      `QWP frame size mismatch [expected=${QWP_HEADER_SIZE + payloadLength}, actual=${result.length}]`,
    );
  }
  return result;
}

export interface QwpIngressSymbolDictionaryDelta {
  readonly startId: number;
  readonly entries: readonly string[];
}

/** Reads the connection-scoped dictionary prefix from a delta ingress frame. */
export function decodeQwpIngressSymbolDictionaryDelta(
  bytes: Uint8Array,
): QwpIngressSymbolDictionaryDelta | undefined {
  const frame = decodeQwpFrame(bytes);
  if ((frame.flags & QWP_FLAG_DELTA_SYMBOL_DICTIONARY) === 0) return undefined;
  const reader = new QwpByteReader(frame.payload);
  const startId = readQwpVarintNumber(reader, "symbol dictionary start ID");
  const count = readQwpVarintNumber(reader, "symbol dictionary entry count");
  if (startId + count > QWP_MAX_SYMBOL_DICTIONARY_SIZE) {
    throw new QwpProtocolError(
      `QWP symbol dictionary exceeds maximum size ${QWP_MAX_SYMBOL_DICTIONARY_SIZE}`,
    );
  }
  const entries: string[] = [];
  for (let index = 0; index < count; index++) {
    const length = readQwpVarintNumber(
      reader,
      "symbol dictionary entry length",
    );
    entries.push(reader.readUtf8(length, "symbol dictionary entry"));
  }
  return { startId, entries };
}

/** Encodes a table-less committed dictionary catch-up frame. */
export function encodeQwpIngressSymbolDictionaryFrame(
  startId: number,
  entries: readonly string[],
): Uint8Array {
  if (!Number.isSafeInteger(startId) || startId < 0) {
    throw new RangeError("symbol dictionary start ID must be non-negative");
  }
  if (startId + entries.length > QWP_MAX_SYMBOL_DICTIONARY_SIZE) {
    throw new RangeError(
      `symbol dictionary exceeds maximum size ${QWP_MAX_SYMBOL_DICTIONARY_SIZE}`,
    );
  }
  let payloadLength = qwpVarintSize(startId) + qwpVarintSize(entries.length);
  for (const entry of entries) payloadLength += qwpStringSize(entry);
  const writer = new QwpByteWriter(QWP_HEADER_SIZE + payloadLength);
  writeQwpFrameHeader(writer, {
    flags: QWP_FLAG_DELTA_SYMBOL_DICTIONARY,
    tableCount: 0,
    payloadLength,
  });
  writeQwpVarint(writer, startId);
  writeQwpVarint(writer, entries.length);
  for (const entry of entries) writeQwpString(writer, entry);
  return writer.toUint8Array();
}

export function encodeQwpIngressCommitFrame(
  dictionary?: QwpSymbolDictionary,
  confirmedMaxSymbolId = -1,
): Uint8Array {
  return encodeQwpIngressFrame([], {
    gorilla: false,
    dictionary,
    confirmedMaxSymbolId,
  });
}

/** Encodes a negotiated, side-effect-free durable-ACK progress poll. */
export function encodeQwpDurableAckPollFrame(): Uint8Array {
  const writer = new QwpByteWriter(QWP_HEADER_SIZE);
  writeQwpFrameHeader(writer, {
    flags: QWP_FLAG_DURABLE_ACK_POLL,
    tableCount: 0,
    payloadLength: 0,
  });
  return writer.toUint8Array();
}

function readIngressTables(
  reader: QwpByteReader,
  count: number,
): QwpIngressTableResult[] {
  const tables: QwpIngressTableResult[] = [];
  for (let index = 0; index < count; index++) {
    const nameLength = reader.readUint16("ingress table name length");
    const name = reader.readUtf8(nameLength, "ingress table name");
    const sequenceTransaction = reader.readBigInt64(
      "ingress table sequence transaction",
    );
    tables.push({ name, sequenceTransaction });
  }
  return tables;
}

/** Decodes an ingress ACK, durable ACK, or NACK WebSocket payload. */
export function decodeQwpIngressResponse(
  payload: Uint8Array,
): QwpIngressResponse {
  const reader = new QwpByteReader(payload);
  const status = reader.readUint8("ingress response status");

  if (status === QWP_STATUS.DURABLE_ACK) {
    const count = reader.readUint16("durable ACK table count");
    const tables = readIngressTables(reader, count);
    reader.expectEnd("durable ACK");
    return { status, sequence: null, tables };
  }

  const sequence = reader.readBigUint64("ingress response sequence");
  if (status === QWP_STATUS.OK) {
    const count = reader.readUint16("ACK table count");
    const tables = readIngressTables(reader, count);
    reader.expectEnd("ingress ACK");
    return { status, sequence, tables };
  }

  const messageLength = reader.readUint16("NACK message length");
  if (messageLength > QWP_MAX_ERROR_MESSAGE_LENGTH) {
    throw new Error(
      `QWP error message exceeds ${QWP_MAX_ERROR_MESSAGE_LENGTH} bytes`,
    );
  }
  const errorMessage = reader.readUtf8(messageLength, "NACK message");
  reader.expectEnd("ingress NACK");
  return { status, sequence, tables: [], errorMessage };
}
