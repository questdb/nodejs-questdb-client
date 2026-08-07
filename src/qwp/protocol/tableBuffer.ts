import { Buffer } from "node:buffer";
import { MAX_COLUMNS_PER_TABLE, MAX_NAME_LENGTH, TYPE_TIMESTAMP } from "./constants";

export interface ColumnBuffer {
  name: string;
  type: number;
  /** Non-null values only — the wire is compacted (spec 6.2.1). */
  values: unknown[];
  /** One entry per row; true means NULL. */
  nulls: boolean[];
  /** Rows accounted for so far, including nulls. */
  size: number;
  geohashPrecision?: number;
  decimalScale?: number;
}

export class QwpTableBuffer {
  readonly name: string;
  private readonly cols: ColumnBuffer[] = [];
  private readonly byName = new Map<string, ColumnBuffer>();
  private rows = 0;

  constructor(name: string) {
    if (!name) throw new Error("table name cannot be empty");
    if (Buffer.byteLength(name, "utf8") > MAX_NAME_LENGTH) {
      throw new Error(`table name too long [maxLength=${MAX_NAME_LENGTH}]`);
    }
    this.name = name;
  }

  get rowCount(): number {
    return this.rows;
  }

  get columns(): ColumnBuffer[] {
    return this.cols;
  }

  /** Returns null when the column already holds a value for the in-progress row. */
  getOrCreateColumn(name: string, type: number): ColumnBuffer | null {
    // An empty name is reserved for the designated timestamp column (TYPE_TIMESTAMP):
    // QwpSchema allows nameLen=0 to signal the designated timestamp, and the server
    // names it "timestamp". A non-empty name of any other type must not be empty.
    if (!name && type !== TYPE_TIMESTAMP) {
      throw new Error("column name cannot be empty");
    }
    const existing = this.byName.get(name);
    if (existing) {
      if (existing.type !== type) {
        throw new Error(
          `Column type mismatch for column '${name}': columnType=${existing.type}, sentType=${type}`,
        );
      }
      // Already has a value for this row -> first value wins, silently.
      if (existing.size > this.rows) return null;
      existing.nulls.push(false);
      existing.size++;
      return existing;
    }
    if (Buffer.byteLength(name, "utf8") > MAX_NAME_LENGTH) {
      throw new Error(`column name too long [maxLength=${MAX_NAME_LENGTH}]`);
    }
    if (this.cols.length >= MAX_COLUMNS_PER_TABLE) {
      throw new Error(
        `column count exceeds maximum: ${this.cols.length + 1} (max ${MAX_COLUMNS_PER_TABLE})`,
      );
    }
    // Back-fill this column as null for every row already closed.
    const col: ColumnBuffer = {
      name,
      type,
      values: [],
      nulls: new Array(this.rows).fill(true),
      size: this.rows,
    };
    col.nulls.push(false);
    col.size++;
    this.cols.push(col);
    this.byName.set(name, col);
    return col;
  }

  /** Closes the row, back-filling a null into every column that was not set. */
  nextRow(): void {
    this.rows++;
    for (const c of this.cols) {
      while (c.size < this.rows) {
        c.nulls.push(true);
        c.size++;
      }
    }
  }

  /** Precision is 1-60 and locked on the column's first value (spec 6.5.3). */
  setGeoHashPrecision(col: ColumnBuffer, precision: number): void {
    if (precision < 1 || precision > 60) {
      throw new Error(`invalid GeoHash precision: ${precision} (must be 1-60)`);
    }
    if (col.geohashPrecision === undefined) {
      col.geohashPrecision = precision;
    } else if (col.geohashPrecision !== precision) {
      throw new Error(
        `GeoHash precision mismatch: column has ${col.geohashPrecision} bits, got ${precision}`,
      );
    }
  }

  /** Scale locks on the first value; later values rescale (spec 6.5.3). */
  setDecimalScale(col: ColumnBuffer, scale: number): number {
    if (col.decimalScale === undefined) col.decimalScale = scale;
    return col.decimalScale;
  }

  reset(): void {
    this.cols.length = 0;
    this.byName.clear();
    this.rows = 0;
  }
}
