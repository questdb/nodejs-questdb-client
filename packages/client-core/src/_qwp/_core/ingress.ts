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
  QWP_MAX_ARRAY_DIMENSION_LENGTH,
  QWP_MAX_ARRAY_DIMENSIONS,
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

/**
 * Per-column work that both encoder passes need, computed once.
 *
 * Sizing a column and writing it derive the same three things, and deriving
 * them twice is not free: the Gorilla path rebuilt the bigint array and ran
 * the bit-packing size computation in each pass, then encodeQwpGorilla() ran
 * it a third time before encoding. Measured on the repository's own 10k-row
 * benchmark workloads that cost 1.8x (trades) to 2.3x (sparse) of total frame
 * encode time, for byte-identical output.
 */
interface ColumnPlan {
  nullCount: number;
  /** Gorilla bytes, or null when the column is written as raw int64s. */
  gorilla?: Uint8Array | null;
  /** Inline dictionary, built only when delta symbols are off. */
  inline?: InlineSymbolDictionary;
}

interface ColumnEncodeOptions {
  gorilla: boolean;
  deltaSymbols: boolean;
  dictionary?: QwpSymbolDictionary;
  /**
   * Scoped to a single encodeQwpIngressFrame() call, so a column mutated
   * between calls can never be sized from a stale plan.
   */
  plans: Map<QwpColumnBuffer, ColumnPlan>;
}

function columnPlan(
  column: QwpColumnBuffer,
  options: ColumnEncodeOptions,
): ColumnPlan {
  let plan = options.plans.get(column);
  if (!plan) {
    plan = { nullCount: nullCount(column) };
    options.plans.set(column, plan);
  }
  return plan;
}

function timestampLabel(column: QwpColumnBuffer): string {
  return column.type === QWP_COLUMN_TYPE.TIMESTAMP
    ? "TIMESTAMP"
    : "TIMESTAMP_NANOS";
}

/** Gorilla bytes for a timestamp column, or null when it stays uncompressed. */
function plannedGorilla(
  column: QwpColumnBuffer,
  options: ColumnEncodeOptions,
): Uint8Array | null {
  const plan = columnPlan(column, options);
  if (plan.gorilla === undefined) {
    const label = timestampLabel(column);
    // Range-checked inside the conversion this branch already runs, rather
    // than in a pass of its own: a separate check loop would re-derive every
    // bigint the map here has just derived, which is the duplicate work the
    // ColumnPlan doc above exists to remove. Checking before qwpGorillaSize()
    // also keeps an out-of-int64 value out of the packed stream entirely,
    // instead of rejecting the frame after a wrong delta has been computed
    // from it.
    const timestamps = column.values.map((value) =>
      checkedCellSigned(BigInt(value as bigint), 64, label, column.name),
    );
    plan.gorilla =
      timestamps.length > 2 && qwpGorillaSize(timestamps) > 0
        ? encodeQwpGorilla(timestamps)
        : null;
  }
  return plan.gorilla;
}

function plannedInlineSymbols(
  column: QwpColumnBuffer,
  options: ColumnEncodeOptions,
): InlineSymbolDictionary {
  const plan = columnPlan(column, options);
  plan.inline ??= inlineSymbolDictionary(column.values);
  return plan.inline;
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

/** Decodes the browser-requested ingress SERVER_INFO payload when present. */
export function decodeQwpIngressServerInfo(
  payload: Uint8Array,
): number | undefined {
  if (payload[0] !== QWP_STATUS.SERVER_INFO) return undefined;
  if (payload.byteLength !== 5) {
    throw new QwpProtocolError("invalid QWP ingress SERVER_INFO length");
  }
  const maxBatchSizeBytes = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  ).getUint32(1, true);
  if (maxBatchSizeBytes === 0) {
    throw new QwpProtocolError("invalid QWP ingress SERVER_INFO batch cap");
  }
  return maxBatchSizeBytes;
}

function symbolText(value: unknown): string {
  if (typeof value === "string") return value;
  // A bare dictionary ID carries no text, and this encoder builds its inline
  // dictionary out of the texts, so there is nothing to resolve it against.
  // Reading `.text` off a number yields undefined, which TextEncoder happily
  // encodes as zero bytes -- every symbol in the frame would collapse into one
  // empty-string entry and be acknowledged as if it were correct. Say so
  // instead. symbolId() accepts the numeric form because the delta encoder is
  // given the dictionary that gives it meaning.
  if (typeof value === "number") {
    throw new Error(
      `QWP symbol ID ${value} needs a symbol dictionary; pass one to encode a delta frame, or supply the symbol as a string or {id, text}`,
    );
  }
  const text = (value as QwpSymbolValue)?.text;
  if (typeof text !== "string") {
    throw new Error(
      "QWP symbol value must be a string or a {id, text} pair, received " +
        (value === null ? "null" : typeof value),
    );
  }
  return text;
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

interface InlineSymbolDictionary {
  /** Distinct symbol texts in first-seen order, matching Set iteration. */
  readonly entries: readonly string[];
  /** The dictionary index of each row's value, in row order. */
  readonly rowIds: readonly number[];
}

// A non-delta ("full") symbol column carries its own inline dictionary.
// Resolving each row against it with Array.prototype.indexOf is O(rows x
// distinct) -- measured quadratic, 67x slower than delta mode at 32k rows. A
// Map keyed by text makes each lookup O(1), the same fix
// QwpSymbolDictionary.getOrAdd already applies in delta mode. symbolText() runs
// once per value here, so measureColumn and writeColumn no longer resolve each
// value twice.
function inlineSymbolDictionary(
  values: readonly unknown[],
): InlineSymbolDictionary {
  const entries: string[] = [];
  const indexByText = new Map<string, number>();
  const rowIds = new Array<number>(values.length);
  for (let row = 0; row < values.length; row++) {
    const text = symbolText(values[row]);
    let id = indexByText.get(text);
    if (id === undefined) {
      id = entries.length;
      indexByText.set(text, id);
      entries.push(text);
    }
    rowIds[row] = id;
  }
  return { entries, rowIds };
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
  if (columnPlan(column, options).nullCount > 0) {
    size += Math.ceil(rowCount / 8);
  }
  const valueCount = column.values.length;

  if (column.type === QWP_COLUMN_TYPE.BOOLEAN) {
    return size + Math.ceil(valueCount / 8);
  }

  // DATE is deliberately absent here. The protocol is asymmetric for it: on
  // ingress the server parses DATE as a plain fixed-width int64
  // (QwpTableBlockCursor dispatches TYPE_DATE to QwpFixedWidthColumnCursor,
  // alongside LONG and UUID), while on egress it emits DATE through
  // emitTimestampSlice with a per-column encoding byte. The result decoder in
  // this package matches the egress side, so the two directions genuinely
  // differ. Adding DATE to this branch makes every ingress frame carrying a
  // DATE column misparse server-side.
  if (
    column.type === QWP_COLUMN_TYPE.TIMESTAMP ||
    column.type === QWP_COLUMN_TYPE.TIMESTAMP_NANOS
  ) {
    if (!options.gorilla) return size + valueCount * 8;
    const gorilla = plannedGorilla(column, options);
    return size + 1 + (gorilla ? gorilla.byteLength : valueCount * 8);
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
    const { entries, rowIds } = plannedInlineSymbols(column, options);
    size += qwpVarintSize(entries.length);
    for (const entry of entries) size += qwpStringSize(entry);
    for (const id of rowIds) size += qwpVarintSize(id);
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
      if (
        array.dimensions.length === 0 ||
        array.dimensions.length > QWP_MAX_ARRAY_DIMENSIONS
      ) {
        throw new RangeError(
          `QWP array must have between 1 and ${QWP_MAX_ARRAY_DIMENSIONS} dimensions`,
        );
      }
      let expected = 1;
      for (const [index, dimension] of array.dimensions.entries()) {
        if (
          !Number.isSafeInteger(dimension) ||
          dimension < 0 ||
          dimension > QWP_MAX_ARRAY_DIMENSION_LENGTH
        ) {
          throw new RangeError(
            `array dimension ${index} must be between 0 and ${QWP_MAX_ARRAY_DIMENSION_LENGTH}`,
          );
        }
        expected *= dimension;
      }
      // The cell is sized and written from values.length while the peer reads
      // the product of the dimension header, so a mismatch encodes a frame
      // whose payload length is self-consistent and whose array column still
      // runs the reader off the end of the cell. The compiled writers and
      // flattenQwpArray() already guarantee the pair agrees; a QwpArrayValue
      // pushed straight onto a column buffer -- the documented low-level path
      // -- is the one that does not, so the invariant is checked next to the
      // rank and axis-length checks that share this loop.
      if (expected !== array.values.length) {
        throw new RangeError(
          `array shape ${array.dimensions.join("x")} needs ${expected} value(s), received ${array.values.length}`,
        );
      }
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
  options: ColumnEncodeOptions,
): void {
  if (columnPlan(column, options).nullCount === 0) {
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

/**
 * Rejects a fixed-width cell that its column cannot represent.
 *
 * Every primitive this file writes through wraps silently -- the DataView
 * setters truncate and BigInt.asIntN folds -- so without these guards an
 * out-of-range value reaches QuestDB as a different, valid-looking number
 * inside a frame whose payload length is perfectly self-consistent, and
 * neither side reports anything. BYTE 300 arrived as 44, DECIMAL64 2^63 as
 * its own negation.
 *
 * Every high-level entry point already rejects the same input --
 * checkedRange, checkedInt64, fitsSigned, parseIpv4 -- so this closes the gap
 * for a value pushed straight onto a column buffer, the documented low-level
 * path, exactly as the array-shape check in columnPayloadSize() does for the
 * shape invariant.
 */
function checkedCellRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
  name: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `QWP ${label} column '${name}' value ${value} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

/** Rejects coercible values that the typed floating-point APIs do not accept. */
function checkedCellNumber(
  value: unknown,
  label: string,
  name: string,
): number {
  if (typeof value !== "number") {
    throw new TypeError(`QWP ${label} column '${name}' accepts only numbers`);
  }
  return value;
}

/** The bigint counterpart of {@link checkedCellRange}. */
function checkedCellSigned(
  value: bigint,
  bits: number,
  label: string,
  name: string,
): bigint {
  if (BigInt.asIntN(bits, value) !== value) {
    throw new RangeError(
      `QWP ${label} column '${name}' value ${value} does not fit a signed ${bits}-bit integer`,
    );
  }
  return value;
}

function writeSignedLittleEndian(
  writer: QwpByteWriter,
  value: bigint,
  width: number,
  name: string,
): void {
  // asIntN was already being computed here, so the comparison that turns the
  // silent fold into a rejection is free.
  let remaining = BigInt.asIntN(width * 8, value);
  if (remaining !== value) {
    throw new RangeError(
      `QWP DECIMAL column '${name}' unscaled value ${value} does not fit a signed ${width * 8}-bit integer`,
    );
  }
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
  writeNullHeader(writer, column, rowCount, options);

  switch (column.type) {
    case QWP_COLUMN_TYPE.BOOLEAN: {
      const bitmap = new Uint8Array(Math.ceil(column.values.length / 8));
      column.values.forEach((value, index) => {
        if (typeof value !== "boolean") {
          throw new TypeError(
            `QWP BOOLEAN column '${column.name}' accepts only booleans`,
          );
        }
        if (value) bitmap[index >>> 3] |= 1 << (index & 7);
      });
      writer.writeBytes(bitmap);
      return;
    }
    case QWP_COLUMN_TYPE.BYTE:
      for (const value of column.values)
        writer.writeInt8(
          checkedCellRange(Number(value), -128, 127, "BYTE", column.name),
        );
      return;
    case QWP_COLUMN_TYPE.SHORT:
      for (const value of column.values)
        writer.writeInt16(
          checkedCellRange(Number(value), -32768, 32767, "SHORT", column.name),
        );
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
      for (const value of column.values)
        writer.writeInt32(
          checkedCellRange(
            Number(value),
            -0x80000000,
            0x7fffffff,
            "INT",
            column.name,
          ),
        );
      return;
    case QWP_COLUMN_TYPE.IPV4:
      // Signed int32 and unsigned uint32 both carry the same packed bits, the
      // pair parseIpv4() accepts, so the range spans both.
      for (const value of column.values)
        writer.writeUint32(
          checkedCellRange(
            Number(value),
            -0x80000000,
            0xffffffff,
            "IPV4",
            column.name,
          ) >>> 0,
        );
      return;
    case QWP_COLUMN_TYPE.FLOAT:
      for (const value of column.values) {
        writer.writeFloat32(checkedCellNumber(value, "FLOAT", column.name));
      }
      return;
    // DATE joins LONG here: raw int64s, no per-column encoding byte.
    // See columnPayloadSize() for why it is not a timestamp on ingress.
    case QWP_COLUMN_TYPE.LONG:
    case QWP_COLUMN_TYPE.DATE: {
      const label = column.type === QWP_COLUMN_TYPE.DATE ? "DATE" : "LONG";
      for (const value of column.values) {
        writer.writeBigInt64(
          checkedCellSigned(
            BigInt(value as number | bigint),
            64,
            label,
            column.name,
          ),
        );
      }
      return;
    }
    case QWP_COLUMN_TYPE.TIMESTAMP:
    case QWP_COLUMN_TYPE.TIMESTAMP_NANOS: {
      if (!options.gorilla) {
        // The only arm plannedGorilla() does not cover, so it carries the
        // check itself -- inline, like LONG above, rather than as a second
        // traversal of values this loop is already converting.
        const label = timestampLabel(column);
        for (const value of column.values) {
          writer.writeBigInt64(
            checkedCellSigned(BigInt(value as bigint), 64, label, column.name),
          );
        }
        return;
      }
      // Both remaining arms are covered by plannedGorilla(), which range-checks
      // every value as it converts it -- in the sizing pass, so the frame is
      // rejected before a byte of it is written.
      const gorilla = plannedGorilla(column, options);
      if (gorilla) {
        writer.writeUint8(QWP_ENCODING_GORILLA);
        writer.writeBytes(gorilla);
      } else {
        writer.writeUint8(QWP_ENCODING_UNCOMPRESSED);
        for (const value of column.values) {
          writer.writeBigInt64(BigInt(value as bigint));
        }
      }
      return;
    }
    case QWP_COLUMN_TYPE.DOUBLE:
      for (const value of column.values) {
        writer.writeFloat64(checkedCellNumber(value, "DOUBLE", column.name));
      }
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
      const { entries, rowIds } = plannedInlineSymbols(column, options);
      writeQwpVarint(writer, entries.length);
      for (const entry of entries) writeQwpString(writer, entry);
      for (const id of rowIds) writeQwpVarint(writer, id);
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
      // One bigint per column, not per cell. geohashColumn() and the compiled
      // writers already enforce this range; unchecked here, a negative value
      // sign-extended into the stray high bits of the last byte and an
      // over-precision one overflowed into them, so the same input encoded
      // differently than the bind encoder, which masks it.
      const limit = 1n << BigInt(precision);
      for (const value of column.values) {
        let remaining = BigInt(value as bigint);
        if (remaining < 0n || remaining >= limit) {
          throw new RangeError(
            `QWP GEOHASH column '${column.name}' value ${remaining} must be between 0 and ${limit - 1n} for ${precision} bits`,
          );
        }
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
        writeSignedLittleEndian(
          writer,
          BigInt(value as bigint),
          width,
          column.name,
        );
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
  const columnOptions: ColumnEncodeOptions = {
    gorilla,
    deltaSymbols,
    dictionary: options.dictionary,
    // Shared by the sizing pass below and the write pass further down, so
    // each column derives its null count, Gorilla bytes and inline symbol
    // dictionary exactly once per frame.
    plans: new Map(),
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
  // Bounded by the frame, not by a policy cap. The declared u16 length is
  // checked against the remaining payload inside readUtf8() -> readBytes() ->
  // ensureAvailable(), which is what stops a peer declaring 0xFFFF over a tiny
  // payload. A separate 1024-byte ceiling used to sit here, and it rejected
  // frames the server is allowed to send: QwpIngressProcessorState truncates
  // ingress error text at (http.send.buffer.size - 100) / 1.5 characters --
  // about 1.4M at the 2 MB default -- so anything up to the u16 maximum is
  // legal on the wire. Worse, the rejection became a QwpProtocolError, which
  // the reconnecting transport rethrows as terminal, so a verbose explanation
  // attached to an otherwise retriable WRITE_ERROR killed a running producer.
  // The Java client bound-checks against the frame and nothing else.
  const errorMessage = reader.readUtf8(messageLength, "NACK message");
  reader.expectEnd("ingress NACK");
  return { status, sequence, tables: [], errorMessage };
}
