import { decodeUtf8, QwpByteReader } from "./bytes";
import {
  QWP_COLUMN_TYPE,
  QWP_FLAG_DELTA_SYMBOL_DICTIONARY,
  QWP_FLAG_GORILLA,
  QWP_FLAG_ZSTD,
  QWP_MAX_CELLS_PER_BATCH,
  QWP_MAX_COLUMNS_PER_TABLE,
  QWP_MAX_IDENTIFIER_BYTES,
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

class QwpResultColumnViewLayout {
  schema!: QwpResultColumnSchema;
  rowCount = 0;
  nonNullCount = 0;
  nullBitmap?: Uint8Array;
  nonNullIndexes?: Int32Array;
  values?: Uint8Array;
  valuesView?: DataView;
  stringBytes?: Uint8Array;
  symbolDictionary?: readonly string[];
  symbolRowIds?: Int32Array;
  arrayOffsets?: Int32Array;
  arrayLengths?: Int32Array;
  scale?: number;
  precisionBits?: number;
  private timestampStorage?: Uint8Array;
  readonly localSymbols: string[] = [];

  reset(schema: QwpResultColumnSchema, rowCount: number): void {
    this.schema = schema;
    this.rowCount = rowCount;
    this.nonNullCount = 0;
    this.nullBitmap = undefined;
    this.values = undefined;
    this.valuesView = undefined;
    this.stringBytes = undefined;
    this.symbolDictionary = undefined;
    this.scale = undefined;
    this.precisionBits = undefined;
    this.localSymbols.length = 0;
  }

  release(): void {
    // Drop frame-backed references immediately. Capacity-bearing scratch
    // arrays remain attached to the layout for the next batch.
    this.nullBitmap = undefined;
    this.values = undefined;
    this.valuesView = undefined;
    this.stringBytes = undefined;
    this.symbolDictionary = undefined;
    this.localSymbols.length = 0;
  }

  setValues(bytes: Uint8Array): void {
    this.values = bytes;
    this.valuesView = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
  }

  ensureNonNullIndexes(size: number): Int32Array {
    this.nonNullIndexes = ensureInt32Capacity(this.nonNullIndexes, size);
    return this.nonNullIndexes;
  }

  ensureSymbolRowIds(size: number): Int32Array {
    this.symbolRowIds = ensureInt32Capacity(this.symbolRowIds, size);
    return this.symbolRowIds;
  }

  ensureArrayOffsets(size: number): Int32Array {
    this.arrayOffsets = ensureInt32Capacity(this.arrayOffsets, size);
    return this.arrayOffsets;
  }

  ensureArrayLengths(size: number): Int32Array {
    this.arrayLengths = ensureInt32Capacity(this.arrayLengths, size);
    return this.arrayLengths;
  }

  timestampBytes(size: number): Uint8Array {
    if (!this.timestampStorage || this.timestampStorage.byteLength < size) {
      let capacity = Math.max(64, this.timestampStorage?.byteLength ?? 0);
      while (capacity < size) capacity *= 2;
      this.timestampStorage = new Uint8Array(capacity);
    }
    return this.timestampStorage.subarray(0, size);
  }

  isNull(row: number): boolean {
    const bitmap = this.nullBitmap;
    return bitmap !== undefined && (bitmap[row >>> 3] & (1 << (row & 7))) !== 0;
  }

  denseIndex(row: number): number {
    return this.nullBitmap ? this.nonNullIndexes![row] : row;
  }
}

function ensureInt32Capacity(
  current: Int32Array | undefined,
  size: number,
): Int32Array {
  if (current && current.length >= size) return current;
  let capacity = Math.max(16, current?.length ?? 0);
  while (capacity < size) capacity *= 2;
  return new Int32Array(capacity);
}

/**
 * Reusable, zero-copy view over one QWP result column.
 *
 * The view and every byte slice returned from it are valid only while the
 * surrounding queryViews() callback is running. Copy data that must outlive
 * the callback.
 */
export class QwpResultColumnView {
  /** @internal */
  constructor(
    private readonly batch: QwpResultBatchView,
    readonly columnIndex: number,
  ) {}

  get name(): string {
    return this.layout().schema.name;
  }

  get type(): QwpColumnType {
    return this.layout().schema.type;
  }

  get rowCount(): number {
    return this.layout().rowCount;
  }

  get nonNullCount(): number {
    return this.layout().nonNullCount;
  }

  get scale(): number | undefined {
    return this.layout().scale;
  }

  get precisionBits(): number | undefined {
    return this.layout().precisionBits;
  }

  /** Fixed-width stride, zero for bit-packed BOOLEAN, or -1 when variable. */
  get bytesPerValue(): number {
    const layout = this.layout();
    switch (layout.schema.type) {
      case QWP_COLUMN_TYPE.BOOLEAN:
        return 0;
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
      case QWP_COLUMN_TYPE.TIMESTAMP:
      case QWP_COLUMN_TYPE.TIMESTAMP_NANOS:
      case QWP_COLUMN_TYPE.DECIMAL64:
        return 8;
      case QWP_COLUMN_TYPE.UUID:
      case QWP_COLUMN_TYPE.DECIMAL128:
        return 16;
      case QWP_COLUMN_TYPE.LONG256:
      case QWP_COLUMN_TYPE.DECIMAL256:
        return 32;
      case QWP_COLUMN_TYPE.GEOHASH:
        return Math.ceil(layout.precisionBits! / 8);
      default:
        return -1;
    }
  }

  isNull(rowIndex: number): boolean {
    const layout = this.checkedLayout(rowIndex);
    return layout.isNull(rowIndex);
  }

  nonNullIndex(rowIndex: number): number {
    const layout = this.checkedLayout(rowIndex);
    return layout.isNull(rowIndex) ? -1 : layout.denseIndex(rowIndex);
  }

  /** Raw per-row NULL bitmap, without copying. Undefined means no NULLs. */
  nullBitmapBytes(): Uint8Array | undefined {
    return this.layout().nullBitmap;
  }

  /**
   * Raw packed non-null values. Fixed-width values use QWP little-endian
   * layout; booleans are bit-packed and variable-width columns contain their
   * uint32 offset table. SYMBOL returns undefined because IDs are varints.
   */
  valuesBytes(): Uint8Array | undefined {
    return this.layout().values;
  }

  /** Concatenated VARCHAR/BINARY payload bytes, without copying. */
  stringBytes(): Uint8Array | undefined {
    return this.layout().stringBytes;
  }

  /** Reusable dense-index table; only the first rowCount entries are valid. */
  nonNullIndexView(): Int32Array | undefined {
    const layout = this.layout();
    return layout.nullBitmap
      ? layout.nonNullIndexes!.subarray(0, layout.rowCount)
      : undefined;
  }

  /** Reusable per-row SYMBOL IDs; NULL-row entries are unspecified. */
  symbolIdView(): Int32Array | undefined {
    const layout = this.layout();
    this.requireType(layout, QWP_COLUMN_TYPE.SYMBOL);
    return layout.symbolRowIds?.subarray(0, layout.rowCount);
  }

  getBoolean(rowIndex: number): boolean {
    const { layout, dense } = this.valuePosition(
      rowIndex,
      QWP_COLUMN_TYPE.BOOLEAN,
    );
    if (dense < 0) return false;
    return (layout.values![dense >>> 3] & (1 << (dense & 7))) !== 0;
  }

  getByte(rowIndex: number): number {
    const { layout, dense } = this.valuePosition(
      rowIndex,
      QWP_COLUMN_TYPE.BYTE,
    );
    return dense < 0 ? 0 : layout.valuesView!.getInt8(dense);
  }

  getShort(rowIndex: number): number {
    const { layout, dense } = this.valuePosition(
      rowIndex,
      QWP_COLUMN_TYPE.SHORT,
    );
    return dense < 0 ? 0 : layout.valuesView!.getInt16(dense * 2, true);
  }

  getChar(rowIndex: number): string {
    const { layout, dense } = this.valuePosition(
      rowIndex,
      QWP_COLUMN_TYPE.CHAR,
    );
    return dense < 0
      ? "\0"
      : String.fromCharCode(layout.valuesView!.getUint16(dense * 2, true));
  }

  getInt(rowIndex: number): number {
    const { layout, dense } = this.valuePosition(
      rowIndex,
      QWP_COLUMN_TYPE.INT,
      QWP_COLUMN_TYPE.IPV4,
    );
    return dense < 0 ? 0 : layout.valuesView!.getInt32(dense * 4, true);
  }

  getFloat(rowIndex: number): number {
    const { layout, dense } = this.valuePosition(
      rowIndex,
      QWP_COLUMN_TYPE.FLOAT,
    );
    return dense < 0
      ? Number.NaN
      : layout.valuesView!.getFloat32(dense * 4, true);
  }

  getDouble(rowIndex: number): number {
    const { layout, dense } = this.valuePosition(
      rowIndex,
      QWP_COLUMN_TYPE.DOUBLE,
    );
    return dense < 0
      ? Number.NaN
      : layout.valuesView!.getFloat64(dense * 8, true);
  }

  getLong(rowIndex: number): bigint {
    const { layout, dense } = this.valuePosition(
      rowIndex,
      QWP_COLUMN_TYPE.LONG,
      QWP_COLUMN_TYPE.DATE,
      QWP_COLUMN_TYPE.TIMESTAMP,
      QWP_COLUMN_TYPE.TIMESTAMP_NANOS,
    );
    return dense < 0 ? 0n : layout.valuesView!.getBigInt64(dense * 8, true);
  }

  /** Zero-copy UTF-8 bytes for a VARCHAR value. */
  getUtf8View(rowIndex: number): Uint8Array | null {
    const { layout, dense } = this.valuePosition(
      rowIndex,
      QWP_COLUMN_TYPE.VARCHAR,
    );
    return dense < 0 ? null : variableWidthValue(layout, dense);
  }

  getString(rowIndex: number): string | null {
    const layout = this.checkedLayout(rowIndex);
    if (layout.schema.type === QWP_COLUMN_TYPE.SYMBOL) {
      return this.getSymbol(rowIndex);
    }
    this.requireType(layout, QWP_COLUMN_TYPE.VARCHAR);
    if (layout.isNull(rowIndex)) return null;
    return decodeUtf8(variableWidthValue(layout, layout.denseIndex(rowIndex)));
  }

  /** Zero-copy BINARY bytes. */
  getBinaryView(rowIndex: number): Uint8Array | null {
    const { layout, dense } = this.valuePosition(
      rowIndex,
      QWP_COLUMN_TYPE.BINARY,
    );
    return dense < 0 ? null : variableWidthValue(layout, dense);
  }

  getSymbolId(rowIndex: number): number {
    const layout = this.checkedLayout(rowIndex);
    this.requireType(layout, QWP_COLUMN_TYPE.SYMBOL);
    return layout.isNull(rowIndex) ? -1 : layout.symbolRowIds![rowIndex];
  }

  getSymbol(rowIndex: number): string | null {
    const layout = this.checkedLayout(rowIndex);
    this.requireType(layout, QWP_COLUMN_TYPE.SYMBOL);
    return layout.isNull(rowIndex)
      ? null
      : layout.symbolDictionary![layout.symbolRowIds![rowIndex]];
  }

  getSymbolForId(symbolId: number): string {
    const layout = this.layout();
    this.requireType(layout, QWP_COLUMN_TYPE.SYMBOL);
    const dictionary = layout.symbolDictionary!;
    if (
      !Number.isInteger(symbolId) ||
      symbolId < 0 ||
      symbolId >= dictionary.length
    ) {
      throw new RangeError(`symbol ID out of range: ${symbolId}`);
    }
    return dictionary[symbolId];
  }

  get symbolDictionarySize(): number {
    const layout = this.layout();
    this.requireType(layout, QWP_COLUMN_TYPE.SYMBOL);
    return layout.symbolDictionary!.length;
  }

  getUuidLow(rowIndex: number): bigint {
    const { layout, dense } = this.valuePosition(
      rowIndex,
      QWP_COLUMN_TYPE.UUID,
    );
    return dense < 0 ? 0n : layout.valuesView!.getBigUint64(dense * 16, true);
  }

  getUuidHigh(rowIndex: number): bigint {
    const { layout, dense } = this.valuePosition(
      rowIndex,
      QWP_COLUMN_TYPE.UUID,
    );
    return dense < 0
      ? 0n
      : layout.valuesView!.getBigUint64(dense * 16 + 8, true);
  }

  getLong256Word(rowIndex: number, wordIndex: number): bigint {
    if (!Number.isInteger(wordIndex) || wordIndex < 0 || wordIndex > 3) {
      throw new RangeError(`LONG256 word index out of range: ${wordIndex}`);
    }
    const { layout, dense } = this.valuePosition(
      rowIndex,
      QWP_COLUMN_TYPE.LONG256,
    );
    return dense < 0
      ? 0n
      : layout.valuesView!.getBigInt64(dense * 32 + wordIndex * 8, true);
  }

  getDecimalUnscaled(rowIndex: number): bigint {
    const { layout, dense } = this.valuePosition(
      rowIndex,
      QWP_COLUMN_TYPE.DECIMAL64,
      QWP_COLUMN_TYPE.DECIMAL128,
      QWP_COLUMN_TYPE.DECIMAL256,
    );
    if (dense < 0) return 0n;
    const width = fixedTypeWidth(layout.schema.type);
    return signedLittleEndianValue(layout.values!, dense * width, width);
  }

  getGeohashBits(rowIndex: number): bigint {
    const { layout, dense } = this.valuePosition(
      rowIndex,
      QWP_COLUMN_TYPE.GEOHASH,
    );
    if (dense < 0) return 0n;
    const width = Math.ceil(layout.precisionBits! / 8);
    return unsignedLittleEndianValue(layout.values!, dense * width, width);
  }

  /** Zero-copy encoded ARRAY row, including dimension header. */
  getArrayView(rowIndex: number): Uint8Array | null {
    const layout = this.checkedLayout(rowIndex);
    this.requireType(
      layout,
      QWP_COLUMN_TYPE.DOUBLE_ARRAY,
      QWP_COLUMN_TYPE.LONG_ARRAY,
    );
    if (layout.isNull(rowIndex)) return null;
    const offset = layout.arrayOffsets![rowIndex];
    return layout.values!.subarray(
      offset,
      offset + layout.arrayLengths![rowIndex],
    );
  }

  getArrayDimensionCount(rowIndex: number): number {
    const layout = this.checkedLayout(rowIndex);
    this.requireType(
      layout,
      QWP_COLUMN_TYPE.DOUBLE_ARRAY,
      QWP_COLUMN_TYPE.LONG_ARRAY,
    );
    return layout.isNull(rowIndex)
      ? 0
      : layout.values![layout.arrayOffsets![rowIndex]];
  }

  /** Lazily materializes one cell; prefer typed/raw accessors on hot paths. */
  get(rowIndex: number): QwpResultValue {
    const layout = this.checkedLayout(rowIndex);
    if (layout.isNull(rowIndex)) return null;
    const dense = layout.denseIndex(rowIndex);
    const view = layout.valuesView;
    switch (layout.schema.type) {
      case QWP_COLUMN_TYPE.BOOLEAN:
        return (layout.values![dense >>> 3] & (1 << (dense & 7))) !== 0;
      case QWP_COLUMN_TYPE.BYTE:
        return view!.getInt8(dense);
      case QWP_COLUMN_TYPE.SHORT:
        return view!.getInt16(dense * 2, true);
      case QWP_COLUMN_TYPE.CHAR:
        return String.fromCharCode(view!.getUint16(dense * 2, true));
      case QWP_COLUMN_TYPE.INT:
      case QWP_COLUMN_TYPE.IPV4:
        return view!.getInt32(dense * 4, true);
      case QWP_COLUMN_TYPE.FLOAT:
        return view!.getFloat32(dense * 4, true);
      case QWP_COLUMN_TYPE.DOUBLE:
        return view!.getFloat64(dense * 8, true);
      case QWP_COLUMN_TYPE.LONG:
      case QWP_COLUMN_TYPE.DATE:
      case QWP_COLUMN_TYPE.TIMESTAMP:
      case QWP_COLUMN_TYPE.TIMESTAMP_NANOS:
        return view!.getBigInt64(dense * 8, true);
      case QWP_COLUMN_TYPE.VARCHAR:
        return decodeUtf8(variableWidthValue(layout, dense));
      case QWP_COLUMN_TYPE.BINARY:
        return variableWidthValue(layout, dense);
      case QWP_COLUMN_TYPE.SYMBOL:
        return layout.symbolDictionary![layout.symbolRowIds![rowIndex]];
      case QWP_COLUMN_TYPE.UUID:
        return {
          low: view!.getBigUint64(dense * 16, true),
          high: view!.getBigUint64(dense * 16 + 8, true),
        };
      case QWP_COLUMN_TYPE.LONG256:
        return {
          words: [
            view!.getBigInt64(dense * 32, true),
            view!.getBigInt64(dense * 32 + 8, true),
            view!.getBigInt64(dense * 32 + 16, true),
            view!.getBigInt64(dense * 32 + 24, true),
          ],
        };
      case QWP_COLUMN_TYPE.DECIMAL64:
      case QWP_COLUMN_TYPE.DECIMAL128:
      case QWP_COLUMN_TYPE.DECIMAL256: {
        const width = fixedTypeWidth(layout.schema.type);
        return {
          unscaled: signedLittleEndianValue(
            layout.values!,
            dense * width,
            width,
          ),
          scale: layout.scale!,
        };
      }
      case QWP_COLUMN_TYPE.GEOHASH: {
        const width = Math.ceil(layout.precisionBits! / 8);
        return {
          bits: unsignedLittleEndianValue(layout.values!, dense * width, width),
          precisionBits: layout.precisionBits!,
        };
      }
      case QWP_COLUMN_TYPE.DOUBLE_ARRAY:
      case QWP_COLUMN_TYPE.LONG_ARRAY:
        return readArrayValue(
          new QwpByteReader(this.getArrayView(rowIndex)!),
          layout.schema.type,
        );
      default:
        throw new QwpProtocolError(
          `unsupported QWP result column type: ${String(layout.schema.type)}`,
        );
    }
  }

  private layout(): QwpResultColumnViewLayout {
    return this.batch.layout(this.columnIndex);
  }

  private checkedLayout(rowIndex: number): QwpResultColumnViewLayout {
    const layout = this.layout();
    if (
      !Number.isInteger(rowIndex) ||
      rowIndex < 0 ||
      rowIndex >= layout.rowCount
    ) {
      throw new RangeError(`row index out of range: ${rowIndex}`);
    }
    return layout;
  }

  private requireType(
    layout: QwpResultColumnViewLayout,
    type1: QwpColumnType,
    type2?: QwpColumnType,
    type3?: QwpColumnType,
    type4?: QwpColumnType,
  ): void {
    const actual = layout.schema.type;
    if (
      actual !== type1 &&
      actual !== type2 &&
      actual !== type3 &&
      actual !== type4
    ) {
      throw new TypeError(
        `column '${layout.schema.name}' has QWP type 0x${actual.toString(16)}`,
      );
    }
  }

  private valuePosition(
    rowIndex: number,
    type1: QwpColumnType,
    type2?: QwpColumnType,
    type3?: QwpColumnType,
    type4?: QwpColumnType,
  ): { layout: QwpResultColumnViewLayout; dense: number } {
    const layout = this.checkedLayout(rowIndex);
    this.requireType(layout, type1, type2, type3, type4);
    return {
      layout,
      dense: layout.isNull(rowIndex) ? -1 : layout.denseIndex(rowIndex),
    };
  }
}

/** Callback invoked by QwpResultBatchView.forEachRow(). */
export type QwpResultRowViewCallback = (row: QwpResultRowView) => void;

/**
 * Reusable row-pinned facade over a QwpResultBatchView.
 *
 * The batch owns one instance and re-points it in place. It is valid only
 * while the surrounding queryViews() callback is running, and must not be
 * retained across forEachRow() iterations. Byte and array views returned by
 * its accessors remain zero-copy and have the same lifetime.
 */
export class QwpResultRowView {
  private _rowIndex = -1;

  /** @internal */
  constructor(private readonly parent: QwpResultBatchView) {}

  /** Parent batch, primarily for column metadata. */
  get batch(): QwpResultBatchView {
    // Validate the shared batch before exposing it through a retained row.
    void this.parent.rowCount;
    return this.parent;
  }

  /** Zero-based row currently pinned by this reusable view. */
  get rowIndex(): number {
    void this.parent.rowCount;
    return this._rowIndex;
  }

  /** Re-points this flyweight at a row and returns the same instance. */
  of(rowIndex: number): this {
    const rowCount = this.parent.rowCount;
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= rowCount) {
      throw new RangeError(`row index out of range: ${rowIndex}`);
    }
    this._rowIndex = rowIndex;
    return this;
  }

  isNull(columnIndex: number): boolean {
    return this.column(columnIndex).isNull(this._rowIndex);
  }

  get(columnIndex: number): QwpResultValue {
    return this.column(columnIndex).get(this._rowIndex);
  }

  getBoolean(columnIndex: number): boolean {
    return this.column(columnIndex).getBoolean(this._rowIndex);
  }

  getByte(columnIndex: number): number {
    return this.column(columnIndex).getByte(this._rowIndex);
  }

  getShort(columnIndex: number): number {
    return this.column(columnIndex).getShort(this._rowIndex);
  }

  getChar(columnIndex: number): string {
    return this.column(columnIndex).getChar(this._rowIndex);
  }

  getInt(columnIndex: number): number {
    return this.column(columnIndex).getInt(this._rowIndex);
  }

  getFloat(columnIndex: number): number {
    return this.column(columnIndex).getFloat(this._rowIndex);
  }

  getDouble(columnIndex: number): number {
    return this.column(columnIndex).getDouble(this._rowIndex);
  }

  getLong(columnIndex: number): bigint {
    return this.column(columnIndex).getLong(this._rowIndex);
  }

  /** Zero-copy UTF-8 bytes for a VARCHAR value. */
  getUtf8View(columnIndex: number): Uint8Array | null {
    return this.column(columnIndex).getUtf8View(this._rowIndex);
  }

  getString(columnIndex: number): string | null {
    return this.column(columnIndex).getString(this._rowIndex);
  }

  /** Zero-copy BINARY bytes. */
  getBinaryView(columnIndex: number): Uint8Array | null {
    return this.column(columnIndex).getBinaryView(this._rowIndex);
  }

  getSymbolId(columnIndex: number): number {
    return this.column(columnIndex).getSymbolId(this._rowIndex);
  }

  getSymbol(columnIndex: number): string | null {
    return this.column(columnIndex).getSymbol(this._rowIndex);
  }

  getUuidLow(columnIndex: number): bigint {
    return this.column(columnIndex).getUuidLow(this._rowIndex);
  }

  getUuidHigh(columnIndex: number): bigint {
    return this.column(columnIndex).getUuidHigh(this._rowIndex);
  }

  getLong256Word(columnIndex: number, wordIndex: number): bigint {
    return this.column(columnIndex).getLong256Word(this._rowIndex, wordIndex);
  }

  getDecimalUnscaled(columnIndex: number): bigint {
    return this.column(columnIndex).getDecimalUnscaled(this._rowIndex);
  }

  getGeohashBits(columnIndex: number): bigint {
    return this.column(columnIndex).getGeohashBits(this._rowIndex);
  }

  /** Zero-copy encoded ARRAY row, including its dimension header. */
  getArrayView(columnIndex: number): Uint8Array | null {
    return this.column(columnIndex).getArrayView(this._rowIndex);
  }

  getArrayDimensionCount(columnIndex: number): number {
    return this.column(columnIndex).getArrayDimensionCount(this._rowIndex);
  }

  private column(columnIndex: number): QwpResultColumnView {
    return this.parent.column(columnIndex);
  }
}

/**
 * Batch-owned reusable view delivered by QwpEgressSession.queryViews().
 * Access is invalid after the callback returns. materialize() creates an
 * independently owned QwpResultBatch when retention is required.
 */
export class QwpResultBatchView {
  private active = false;
  private _requestId = -1n;
  private _batchSequence = -1n;
  private _tableName = "";
  private _rowCount = 0;
  private layouts: QwpResultColumnViewLayout[] = [];
  private readonly columnViews: QwpResultColumnView[] = [];
  private readonly columnViewPool: QwpResultColumnView[] = [];
  private rowView?: QwpResultRowView;

  get valid(): boolean {
    return this.active;
  }

  get requestId(): bigint {
    this.assertValid();
    return this._requestId;
  }

  get batchSequence(): bigint {
    this.assertValid();
    return this._batchSequence;
  }

  get tableName(): string {
    this.assertValid();
    return this._tableName;
  }

  get rowCount(): number {
    this.assertValid();
    return this._rowCount;
  }

  get columnCount(): number {
    this.assertValid();
    return this.layouts.length;
  }

  get columns(): readonly QwpResultColumnView[] {
    this.assertValid();
    return this.columnViews;
  }

  column(columnIndex: number): QwpResultColumnView {
    this.assertValid();
    const column = this.columnViews[columnIndex];
    if (!column) {
      throw new RangeError(`column index out of range: ${columnIndex}`);
    }
    return column;
  }

  get(rowIndex: number, columnIndex: number): QwpResultValue {
    return this.column(columnIndex).get(rowIndex);
  }

  /**
   * Returns the batch-owned reusable row view pinned to rowIndex. Every call
   * returns the same object re-pointed at the requested row.
   */
  row(rowIndex: number): QwpResultRowView {
    this.assertValid();
    return this.reusableRowView().of(rowIndex);
  }

  /**
   * Visits rows in index order with one re-pointed row view. The callback is
   * synchronous; copy values that must survive the current invocation.
   */
  forEachRow(callback: QwpResultRowViewCallback): void {
    this.assertValid();
    if (this._rowCount === 0) return;
    const rowView = this.reusableRowView();
    for (let rowIndex = 0; rowIndex < this._rowCount; rowIndex++) {
      callback(rowView.of(rowIndex));
    }
  }

  materialize(): QwpResultBatch {
    this.assertValid();
    return new QwpResultBatch(
      this._requestId,
      this._batchSequence,
      this._tableName,
      this._rowCount,
      this.columnViews.map((column) => ({
        name: column.name,
        type: column.type,
        values: Array.from({ length: this._rowCount }, (_, row) => {
          const value = column.get(row);
          // Binary values are zero-copy slices in the view API. materialize()
          // promises independently owned data, so detach those slices here.
          return value instanceof Uint8Array ? value.slice() : value;
        }),
        ...(column.scale === undefined ? {} : { scale: column.scale }),
        ...(column.precisionBits === undefined
          ? {}
          : { precisionBits: column.precisionBits }),
      })),
    );
  }

  /** Invalidates the view. Normally called automatically after queryViews(). */
  release(): void {
    if (!this.active) return;
    this.active = false;
    for (const layout of this.layouts) layout.release();
  }

  /** @internal */
  reset(
    requestId: bigint,
    batchSequence: bigint,
    tableName: string,
    rowCount: number,
    layouts: QwpResultColumnViewLayout[],
  ): this {
    this._requestId = requestId;
    this._batchSequence = batchSequence;
    this._tableName = tableName;
    this._rowCount = rowCount;
    this.layouts = layouts;
    while (this.columnViewPool.length < layouts.length) {
      this.columnViewPool.push(
        new QwpResultColumnView(this, this.columnViewPool.length),
      );
    }
    this.columnViews.length = layouts.length;
    for (let index = 0; index < layouts.length; index++) {
      this.columnViews[index] = this.columnViewPool[index];
    }
    this.active = true;
    return this;
  }

  /** @internal */
  layout(columnIndex: number): QwpResultColumnViewLayout {
    this.assertValid();
    const layout = this.layouts[columnIndex];
    if (!layout) {
      throw new RangeError(`column index out of range: ${columnIndex}`);
    }
    return layout;
  }

  private assertValid(): void {
    if (!this.active) {
      throw new Error(
        "QWP result batch view is no longer valid; copy or materialize values inside the queryViews callback",
      );
    }
  }

  private reusableRowView(): QwpResultRowView {
    return (this.rowView ??= new QwpResultRowView(this));
  }
}

function variableWidthValue(
  layout: QwpResultColumnViewLayout,
  denseIndex: number,
): Uint8Array {
  const offsets = layout.valuesView!;
  const start = offsets.getUint32(denseIndex * 4, true);
  const end = offsets.getUint32((denseIndex + 1) * 4, true);
  return layout.stringBytes!.subarray(start, end);
}

function fixedTypeWidth(type: QwpColumnType): number {
  switch (type) {
    case QWP_COLUMN_TYPE.DECIMAL64:
      return 8;
    case QWP_COLUMN_TYPE.DECIMAL128:
      return 16;
    case QWP_COLUMN_TYPE.DECIMAL256:
      return 32;
    default:
      throw new TypeError(`QWP type 0x${type.toString(16)} is not decimal`);
  }
}

function unsignedLittleEndianValue(
  bytes: Uint8Array,
  offset = 0,
  length = bytes.length - offset,
): bigint {
  let value = 0n;
  for (let index = 0; index < length; index++) {
    value |= BigInt(bytes[offset + index]) << BigInt(index * 8);
  }
  return value;
}

function signedLittleEndianValue(
  bytes: Uint8Array,
  offset = 0,
  length = bytes.length - offset,
): bigint {
  const value = unsignedLittleEndianValue(bytes, offset, length);
  const bits = BigInt(length * 8);
  const sign = 1n << (bits - 1n);
  return (value & sign) === 0n ? value : value - (1n << bits);
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

interface PreparedResultBatch {
  readonly reader: QwpByteReader;
  readonly tableName: string;
  readonly rowCount: number;
  readonly deltaMode: boolean;
}

/** Stateful decoder for connection-scoped QWP result batches. */
export class QwpResultBatchDecoder {
  private readonly symbolDictionary: string[] = [];
  private readonly viewBatches: QwpResultBatchView[] = [];
  private readonly viewLayouts: QwpResultColumnViewLayout[][] = [];
  private readonly viewLayoutPools: QwpResultColumnViewLayout[][] = [];
  private schema?: QwpResultColumnSchema[];
  private expectedBatchSequence = 0n;

  resetQuerySchema(): void {
    for (const batch of this.viewBatches) batch.release();
    this.schema = undefined;
    this.expectedBatchSequence = 0n;
  }

  applyCacheReset(resetMask: number): void {
    if ((resetMask & QWP_RESET_MASK_DICTIONARY) !== 0) {
      this.symbolDictionary.length = 0;
    }
  }

  /** @internal Drops frame-backed references after a failed slot decode. */
  releaseView(slot: number): void {
    this.viewBatches[slot]?.release();
    for (const layout of this.viewLayoutPools[slot] ?? []) layout.release();
  }

  decode(message: QwpResultBatchMessage): QwpResultBatch {
    const { reader, tableName, rowCount, deltaMode } = this.prepare(message);

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

  /**
   * Decodes into one slot from a reusable batch/column-view pool without
   * materializing a JavaScript value array. Reusing the same slot invalidates
   * its prior view; callers must not reuse a slot until its consumer releases
   * the preceding batch.
   */
  decodeView(message: QwpResultBatchMessage, slot = 0): QwpResultBatchView {
    if (!Number.isSafeInteger(slot) || slot < 0) {
      throw new RangeError(
        "QWP result view slot must be a non-negative integer",
      );
    }
    const viewBatch = (this.viewBatches[slot] ??= new QwpResultBatchView());
    const viewLayouts = (this.viewLayouts[slot] ??= []);
    const viewLayoutPool = (this.viewLayoutPools[slot] ??= []);
    viewBatch.release();
    const { reader, tableName, rowCount, deltaMode } = this.prepare(message);
    const schema = this.schema!;
    while (viewLayoutPool.length < schema.length) {
      viewLayoutPool.push(new QwpResultColumnViewLayout());
    }
    viewLayouts.length = schema.length;
    for (let index = 0; index < schema.length; index++) {
      const layout = viewLayoutPool[index];
      viewLayouts[index] = layout;
      layout.reset(schema[index], rowCount);
      this.readColumnView(reader, layout, deltaMode, message.flags);
    }
    reader.expectEnd("RESULT_BATCH");
    this.expectedBatchSequence++;
    return viewBatch.reset(
      message.requestId,
      message.batchSequence,
      tableName,
      rowCount,
      viewLayouts,
    );
  }

  private prepare(message: QwpResultBatchMessage): PreparedResultBatch {
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
      QWP_MAX_IDENTIFIER_BYTES,
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
          QWP_MAX_IDENTIFIER_BYTES,
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
    // Each dimension passed its own cap; the grid they describe still has to
    // be one this client will allocate. Checked before any column is read,
    // because reading one is what allocates.
    const cells = rowCount * this.schema.length;
    if (cells > QWP_MAX_CELLS_PER_BATCH) {
      throw new QwpProtocolError(
        `RESULT_BATCH declares ${cells} cells, above the client cap ${QWP_MAX_CELLS_PER_BATCH} [rows=${rowCount}, columns=${this.schema.length}]`,
      );
    }
    return { reader, tableName, rowCount, deltaMode };
  }

  private readColumnView(
    reader: QwpByteReader,
    layout: QwpResultColumnViewLayout,
    deltaMode: boolean,
    flags: number,
  ): void {
    this.readNullView(reader, layout);
    const count = layout.nonNullCount;
    const type = layout.schema.type;
    switch (type) {
      case QWP_COLUMN_TYPE.BOOLEAN:
        layout.setValues(
          reader.readBytes(Math.ceil(count / 8), "boolean values"),
        );
        return;
      case QWP_COLUMN_TYPE.BYTE:
        this.readFixedView(reader, layout, count, 1, "byte values");
        return;
      case QWP_COLUMN_TYPE.SHORT:
      case QWP_COLUMN_TYPE.CHAR:
        this.readFixedView(reader, layout, count, 2, "short values");
        return;
      case QWP_COLUMN_TYPE.INT:
      case QWP_COLUMN_TYPE.FLOAT:
      case QWP_COLUMN_TYPE.IPV4:
        this.readFixedView(reader, layout, count, 4, "int values");
        return;
      case QWP_COLUMN_TYPE.LONG:
      case QWP_COLUMN_TYPE.DOUBLE:
        this.readFixedView(reader, layout, count, 8, "long values");
        return;
      case QWP_COLUMN_TYPE.DATE:
      case QWP_COLUMN_TYPE.TIMESTAMP:
      case QWP_COLUMN_TYPE.TIMESTAMP_NANOS:
        this.readTimestampView(reader, layout, flags);
        return;
      case QWP_COLUMN_TYPE.VARCHAR:
      case QWP_COLUMN_TYPE.BINARY:
        this.readVariableWidthView(reader, layout);
        return;
      case QWP_COLUMN_TYPE.SYMBOL:
        this.readSymbolView(reader, layout, deltaMode);
        return;
      case QWP_COLUMN_TYPE.UUID:
        this.readFixedView(reader, layout, count, 16, "UUID values");
        return;
      case QWP_COLUMN_TYPE.LONG256:
        this.readFixedView(reader, layout, count, 32, "LONG256 values");
        return;
      case QWP_COLUMN_TYPE.DECIMAL64:
      case QWP_COLUMN_TYPE.DECIMAL128:
      case QWP_COLUMN_TYPE.DECIMAL256: {
        layout.scale = reader.readUint8("decimal scale");
        this.readFixedView(
          reader,
          layout,
          count,
          fixedTypeWidth(type),
          "decimal values",
        );
        return;
      }
      case QWP_COLUMN_TYPE.GEOHASH: {
        layout.precisionBits = readCount(reader, 60, "geohash precision");
        if (layout.precisionBits < 1) {
          throw new QwpProtocolError(
            `geohash precision out of range: ${layout.precisionBits}`,
          );
        }
        this.readFixedView(
          reader,
          layout,
          count,
          Math.ceil(layout.precisionBits / 8),
          "geohash values",
        );
        return;
      }
      case QWP_COLUMN_TYPE.DOUBLE_ARRAY:
      case QWP_COLUMN_TYPE.LONG_ARRAY:
        this.readArrayView(reader, layout);
        return;
      default:
        throw new QwpProtocolError(
          `unsupported QWP result column type: ${String(type)}`,
        );
    }
  }

  private readNullView(
    reader: QwpByteReader,
    layout: QwpResultColumnViewLayout,
  ): void {
    const flag = reader.readUint8("column null flag");
    if (flag !== 0 && flag !== 1) {
      throw new QwpProtocolError(`invalid column null flag: ${flag}`);
    }
    if (flag === 0) {
      layout.nonNullCount = layout.rowCount;
      return;
    }
    const bitmap = reader.readBytes(
      Math.ceil(layout.rowCount / 8),
      "column null bitmap",
    );
    layout.nullBitmap = bitmap;
    const indexes = layout.ensureNonNullIndexes(layout.rowCount);
    let dense = 0;
    for (let row = 0; row < layout.rowCount; row++) {
      if ((bitmap[row >>> 3] & (1 << (row & 7))) !== 0) {
        indexes[row] = -1;
      } else {
        indexes[row] = dense++;
      }
    }
    layout.nonNullCount = dense;
  }

  private readFixedView(
    reader: QwpByteReader,
    layout: QwpResultColumnViewLayout,
    count: number,
    width: number,
    label: string,
  ): void {
    layout.setValues(reader.readBytes(count * width, label));
  }

  private readVariableWidthView(
    reader: QwpByteReader,
    layout: QwpResultColumnViewLayout,
  ): void {
    const count = layout.nonNullCount;
    const offsets = reader.readBytes(
      (count + 1) * 4,
      "variable-width column offsets",
    );
    const view = new DataView(
      offsets.buffer,
      offsets.byteOffset,
      offsets.byteLength,
    );
    if (view.getUint32(0, true) !== 0) {
      throw new QwpProtocolError(
        "variable-width column must start at offset zero",
      );
    }
    let previous = 0;
    for (let index = 1; index <= count; index++) {
      const offset = view.getUint32(index * 4, true);
      if (offset < previous) {
        throw new QwpProtocolError(
          `variable-width column offsets are not monotonic at index ${index}`,
        );
      }
      previous = offset;
    }
    layout.setValues(offsets);
    layout.stringBytes = reader.readBytes(
      previous,
      "variable-width column data",
    );
  }

  private readSymbolView(
    reader: QwpByteReader,
    layout: QwpResultColumnViewLayout,
    deltaMode: boolean,
  ): void {
    let dictionary: readonly string[];
    if (deltaMode) {
      dictionary = this.symbolDictionary;
    } else {
      const size = readCount(reader, layout.rowCount, "symbol dictionary size");
      const local = layout.localSymbols;
      for (let index = 0; index < size; index++) {
        const length = readCount(reader, reader.remaining, "symbol length");
        local.push(reader.readUtf8(length, "symbol"));
      }
      dictionary = local;
    }
    layout.symbolDictionary = dictionary;
    const ids = layout.ensureSymbolRowIds(layout.rowCount);
    for (let row = 0; row < layout.rowCount; row++) {
      if (layout.isNull(row)) continue;
      const id = readCount(reader, dictionary.length, "symbol ID");
      if (id >= dictionary.length) {
        throw new QwpProtocolError(`symbol ID out of range: ${id}`);
      }
      ids[row] = id;
    }
  }

  private readArrayView(
    reader: QwpByteReader,
    layout: QwpResultColumnViewLayout,
  ): void {
    const start = reader.position;
    const offsets = layout.ensureArrayOffsets(layout.rowCount);
    const lengths = layout.ensureArrayLengths(layout.rowCount);
    for (let row = 0; row < layout.rowCount; row++) {
      if (layout.isNull(row)) {
        offsets[row] = 0;
        lengths[row] = 0;
        continue;
      }
      const rowStart = reader.position;
      const dimensions = reader.readUint8("array dimension count");
      if (dimensions < 1 || dimensions > 32) {
        throw new QwpProtocolError(
          `array dimension count out of range: ${dimensions}`,
        );
      }
      let elementCount = 1;
      for (let index = 0; index < dimensions; index++) {
        const length = reader.readInt32("array dimension length");
        if (length < 0 || length > MAX_ARRAY_DIMENSION_LENGTH) {
          throw new QwpProtocolError(
            `array dimension length out of range: ${length}`,
          );
        }
        elementCount *= length;
        if (elementCount > MAX_ARRAY_ELEMENTS) {
          throw new QwpProtocolError(
            `array element count exceeds ${MAX_ARRAY_ELEMENTS}`,
          );
        }
      }
      reader.readBytes(elementCount * 8, "array payload");
      offsets[row] = rowStart - start;
      lengths[row] = reader.position - rowStart;
    }
    layout.setValues(reader.bytes.subarray(start, reader.position));
  }

  private readTimestampView(
    reader: QwpByteReader,
    layout: QwpResultColumnViewLayout,
    flags: number,
  ): void {
    const count = layout.nonNullCount;
    if ((flags & QWP_FLAG_GORILLA) === 0) {
      this.readFixedView(reader, layout, count, 8, "timestamp values");
      return;
    }
    const encoding = reader.readUint8("timestamp encoding");
    if (encoding === 0) {
      this.readFixedView(reader, layout, count, 8, "timestamp values");
      return;
    }
    if (encoding !== 1) {
      throw new QwpProtocolError(`unknown timestamp encoding: ${encoding}`);
    }
    if (count < 3) {
      throw new QwpProtocolError(
        `Gorilla-encoded column has fewer than three values: ${count}`,
      );
    }
    const bytes = layout.timestampBytes(count * 8);
    const decoded = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    const first = reader.readBigInt64("first Gorilla timestamp");
    const second = reader.readBigInt64("second Gorilla timestamp");
    decoded.setBigInt64(0, first, true);
    decoded.setBigInt64(8, second, true);
    const bits = new QwpBitReader(
      reader.bytes.subarray(
        reader.position,
        reader.position + reader.remaining,
      ),
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
      decoded.setBigInt64(index * 8, timestamp, true);
      previousDelta = delta;
      previousTimestamp = timestamp;
    }
    reader.readBytes(bits.bytesConsumed, "Gorilla bitstream");
    layout.setValues(bytes);
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
