import { Buffer } from "node:buffer";
import { SenderBuffer } from "../buffer";
import { TimestampUnit } from "../utils";
import { QwpTableBuffer } from "./protocol/tableBuffer";
import { encodeFrame } from "./protocol/frameEncoder";
import { flattenArray } from "./protocol/columnWriter";
import { TYPE_DOUBLE, TYPE_DOUBLE_ARRAY, TYPE_LONG, TYPE_SYMBOL, TYPE_TIMESTAMP, TYPE_VARCHAR } from "./protocol/constants";

function toMicros(value: number | bigint, unit: TimestampUnit): bigint {
  const v = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  switch (unit) {
    case "ns":
      return v / 1000n;
    case "ms":
      return v * 1000n;
    default:
      return v;
  }
}

function unsupported(what: string): never {
  throw new Error(`${what} is not supported by the QWP buffer yet`);
}

export class QwpBuffer implements SenderBuffer {
  private tables: QwpTableBuffer[] = [];
  private byName = new Map<string, QwpTableBuffer>();
  private current?: QwpTableBuffer;
  private rows = 0;

  reset(): SenderBuffer {
    this.tables = [];
    this.byName = new Map();
    this.current = undefined;
    this.rows = 0;
    return this;
  }

  table(table: string): SenderBuffer {
    let t = this.byName.get(table);
    if (!t) {
      t = new QwpTableBuffer(table);
      this.byName.set(table, t);
      this.tables.push(t);
    }
    this.current = t;
    return this;
  }

  private require(): QwpTableBuffer {
    if (!this.current) throw new Error("table name must be set before adding columns");
    return this.current;
  }

  symbol(name: string, value: unknown): SenderBuffer {
    const col = this.require().getOrCreateColumn(name, TYPE_SYMBOL);
    if (col) col.values.push(String(value));
    return this;
  }

  intColumn(name: string, value: number): SenderBuffer {
    if (!Number.isInteger(value)) throw new Error(`value must be an integer, received ${value}`);
    const col = this.require().getOrCreateColumn(name, TYPE_LONG);
    if (col) col.values.push(BigInt(value));
    return this;
  }

  floatColumn(name: string, value: number): SenderBuffer {
    const col = this.require().getOrCreateColumn(name, TYPE_DOUBLE);
    if (col) col.values.push(value);
    return this;
  }

  timestampColumn(name: string, value: number | bigint, unit: TimestampUnit = "us"): SenderBuffer {
    const col = this.require().getOrCreateColumn(name, TYPE_TIMESTAMP);
    if (col) col.values.push(toMicros(value, unit));
    return this;
  }

  at(timestamp: number | bigint, unit: TimestampUnit = "us"): void {
    const t = this.require();
    // Designated timestamp column: an empty schema name signals the designated
    // timestamp (QwpSchema nameLen=0); the server names it "timestamp".
    const col = t.getOrCreateColumn("", TYPE_TIMESTAMP);
    if (col) col.values.push(toMicros(timestamp, unit));
    t.nextRow();
    this.rows++;
    this.current = undefined;
  }

  atNow(): void {
    const t = this.require();
    t.nextRow();
    this.rows++;
    this.current = undefined;
  }

  /**
   * Seals the buffered rows into one or more frames. A flush produces more
   * than one frame only when the encoded batch exceeds maxBatchSize (spec 5.1);
   * splitting itself lands in Task 9.
   */
  sealFrames(maxBatchSize: number): Buffer[] {
    // Splitting against maxBatchSize lands in Task 9.
    void maxBatchSize;
    const dirty = this.tables.filter((t) => t.rowCount > 0);
    if (dirty.length === 0) return [];
    const frame = encodeFrame(dirty);
    this.reset();
    return [frame];
  }

  toBufferNew(): Buffer | null {
    const frames = this.sealFrames(Number.MAX_SAFE_INTEGER);
    if (frames.length === 0) return null;
    if (frames.length > 1) {
      throw new Error("QWP produced multiple frames; use sealFrames()");
    }
    return frames[0];
  }

  toBufferView(): Buffer {
    throw new Error("toBufferView is not supported by the QWP buffer");
  }

  currentPosition(): number {
    return this.rows;
  }

  // Column types arriving in a later plan — fail loudly rather than emit wrong bytes.
  stringColumn(name: string, value: string): SenderBuffer {
    if (typeof value !== "string")
      throw new Error("stringColumn accepts only string values");
    const col = this.require().getOrCreateColumn(name, TYPE_VARCHAR);
    if (col) col.values.push(value);
    return this;
  }
  booleanColumn(): SenderBuffer {
    return unsupported("booleanColumn");
  }
  arrayColumn(name: string, value: unknown[]): SenderBuffer {
    const col = this.require().getOrCreateColumn(name, TYPE_DOUBLE_ARRAY);
    if (col) col.values.push(flattenArray(value));
    return this;
  }
  decimalColumnText(): SenderBuffer {
    return unsupported("decimalColumnText");
  }
  decimalColumn(): SenderBuffer {
    return unsupported("decimalColumn");
  }
}
