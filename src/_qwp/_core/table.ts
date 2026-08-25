import {
  QWP_COLUMN_TYPE,
  QWP_MAX_COLUMNS_PER_TABLE,
  QWP_MAX_TABLE_NAME_LENGTH,
  QwpColumnType,
} from "./constants";
import {
  qwpColumnNameKey,
  validateQwpColumnName,
  validateQwpTableName,
} from "./identifiers";

export interface QwpSymbolValue {
  id: number;
  text: string;
}

export interface QwpArrayValue {
  dimensions: number[];
  values: (number | bigint)[];
}

export interface QwpColumnBuffer {
  name: string;
  type: QwpColumnType;
  /** Non-null values only; QWP compacts values around the null bitmap. */
  values: unknown[];
  /** One entry per row; true means NULL. */
  nulls: boolean[];
  /** Rows accounted for so far, including nulls. */
  size: number;
  geohashPrecision?: number;
  decimalScale?: number;
}

/** Mutable columnar staging area for one QWP ingress table. */
export class QwpTableBuffer {
  readonly name: string;
  private readonly maxNameLength: number;
  private readonly columnList: QwpColumnBuffer[] = [];
  private readonly columnsByName = new Map<string, QwpColumnBuffer>();
  private rows = 0;

  constructor(name: string, maxNameLength = QWP_MAX_TABLE_NAME_LENGTH) {
    if (!Number.isSafeInteger(maxNameLength) || maxNameLength < 1) {
      throw new RangeError("maxNameLength must be a positive safe integer");
    }
    validateQwpTableName(name, maxNameLength);
    this.name = name;
    this.maxNameLength = maxNameLength;
  }

  get rowCount(): number {
    return this.rows;
  }

  get columns(): readonly QwpColumnBuffer[] {
    return this.columnList;
  }

  /**
   * Returns null when the current row already contains this column. The first
   * value wins, matching the existing Sender API.
   */
  getOrCreateColumn(
    name: string,
    type: QwpColumnType,
    // The caller may pass the key it already holds -- the flush path iterates a
    // Map already keyed by it -- to skip a per-cell rebuild. It must equal
    // qwpColumnNameKey(name); it defaults to it when omitted.
    nameKey: string = qwpColumnNameKey(name),
  ): QwpColumnBuffer | null {
    const designatedTimestamp =
      name.length === 0 &&
      (type === QWP_COLUMN_TYPE.TIMESTAMP ||
        type === QWP_COLUMN_TYPE.TIMESTAMP_NANOS);
    if (!name && !designatedTimestamp) {
      throw new Error("column name cannot be empty");
    }

    const existing = this.columnsByName.get(nameKey);
    if (existing) {
      if (existing.type !== type) {
        throw new Error(
          `column type mismatch for '${name}' [existing=${existing.type}, received=${type}]`,
        );
      }
      if (existing.size > this.rows) return null;
      existing.nulls.push(false);
      existing.size++;
      return existing;
    }

    if (!designatedTimestamp) validateQwpColumnName(name, this.maxNameLength);
    if (this.columnList.length >= QWP_MAX_COLUMNS_PER_TABLE) {
      throw new Error(
        `column count exceeds maximum ${QWP_MAX_COLUMNS_PER_TABLE}`,
      );
    }

    const column: QwpColumnBuffer = {
      name,
      type,
      values: [],
      nulls: new Array(this.rows).fill(true),
      size: this.rows,
    };
    column.nulls.push(false);
    column.size++;
    this.columnList.push(column);
    this.columnsByName.set(nameKey, column);
    return column;
  }

  /** Closes the current row and back-fills missing columns with nulls. */
  nextRow(): void {
    this.rows++;
    for (const column of this.columnList) {
      while (column.size < this.rows) {
        column.nulls.push(true);
        column.size++;
      }
    }
  }

  setGeohashPrecision(column: QwpColumnBuffer, precision: number): void {
    if (column.type !== QWP_COLUMN_TYPE.GEOHASH) {
      throw new Error("geohash precision can only be set on a GEOHASH column");
    }
    if (!Number.isInteger(precision) || precision < 1 || precision > 60) {
      throw new Error(
        `invalid geohash precision ${precision}; expected 1 through 60`,
      );
    }
    if (column.geohashPrecision === undefined) {
      column.geohashPrecision = precision;
    } else if (column.geohashPrecision !== precision) {
      throw new Error(
        `geohash precision mismatch [existing=${column.geohashPrecision}, received=${precision}]`,
      );
    }
  }

  setDecimalScale(column: QwpColumnBuffer, scale: number): number {
    const maximum =
      column.type === QWP_COLUMN_TYPE.DECIMAL64
        ? 18
        : column.type === QWP_COLUMN_TYPE.DECIMAL128
          ? 38
          : column.type === QWP_COLUMN_TYPE.DECIMAL256
            ? 76
            : undefined;
    if (maximum === undefined) {
      throw new Error("decimal scale can only be set on a DECIMAL column");
    }
    if (!Number.isInteger(scale) || scale < 0 || scale > maximum) {
      throw new Error(
        `invalid decimal scale ${scale}; expected 0 through ${maximum}`,
      );
    }
    if (column.decimalScale === undefined) column.decimalScale = scale;
    return column.decimalScale;
  }

  /** Truncates every column back to the last completed row. */
  rollbackRow(): void {
    for (const column of this.columnList) {
      while (column.size > this.rows) {
        const wasNull = column.nulls.pop();
        column.size--;
        if (wasNull === false) column.values.pop();
      }
    }
    for (let index = this.columnList.length - 1; index >= 0; index--) {
      const column = this.columnList[index];
      if (this.rows === 0 && column.size === 0) {
        this.columnsByName.delete(qwpColumnNameKey(column.name));
        this.columnList.splice(index, 1);
      }
    }
  }

  /**
   * Copies a completed half-open row range into an independent table buffer.
   * Compact column values and their null bitmaps are sliced together, so the
   * result can be encoded without materialising rows first.
   */
  sliceRows(start: number, end: number): QwpTableBuffer {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > this.rows
    ) {
      throw new RangeError(
        `invalid QWP table row range [start=${start}, end=${end}, rows=${this.rows}]`,
      );
    }

    const result = new QwpTableBuffer(this.name, this.maxNameLength);
    result.rows = end - start;
    for (const column of this.columnList) {
      // `values` holds non-null entries only, so a row index becomes a value
      // index by skipping the nulls before it. A column with no nulls at all
      // needs no scan, and that is the common case -- without this shortcut
      // every slice costs O(start) per column, which makes a caller that walks
      // a table in ascending slices quadratic in its row count all over again.
      let valueStart: number;
      let valueEnd: number;
      if (column.values.length === column.size) {
        valueStart = start;
        valueEnd = end;
      } else {
        valueStart = 0;
        for (let row = 0; row < start; row++) {
          if (!column.nulls[row]) valueStart++;
        }
        valueEnd = valueStart;
        for (let row = start; row < end; row++) {
          if (!column.nulls[row]) valueEnd++;
        }
      }
      const sliced: QwpColumnBuffer = {
        name: column.name,
        type: column.type,
        values: column.values.slice(valueStart, valueEnd),
        nulls: column.nulls.slice(start, end),
        size: end - start,
        geohashPrecision: column.geohashPrecision,
        decimalScale: column.decimalScale,
      };
      result.columnList.push(sliced);
      result.columnsByName.set(qwpColumnNameKey(sliced.name), sliced);
    }
    return result;
  }

  reset(): void {
    this.columnList.length = 0;
    this.columnsByName.clear();
    this.rows = 0;
  }
}

export function flattenQwpArray(value: unknown[]): QwpArrayValue {
  const dimensions: number[] = [];
  let level: unknown = value;
  while (Array.isArray(level)) {
    dimensions.push(level.length);
    level = level[0];
  }
  if (dimensions.length === 0 || dimensions.length > 255) {
    throw new Error("QWP array must have between 1 and 255 dimensions");
  }

  const values: (number | bigint)[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth === dimensions.length) {
      if (typeof node !== "number" && typeof node !== "bigint") {
        throw new Error("QWP array elements must be numbers or bigints");
      }
      values.push(node);
      return;
    }
    if (!Array.isArray(node) || node.length !== dimensions[depth]) {
      throw new Error("irregular QWP array shape");
    }
    for (const child of node) walk(child, depth + 1);
  };
  walk(value, 0);
  return { dimensions, values };
}
