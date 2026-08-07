import { Buffer } from "node:buffer";
import { SenderBuffer } from "../buffer";
import { TimestampUnit } from "../utils";
import { QwpTableBuffer } from "./protocol/tableBuffer";
import { encodeFrame } from "./protocol/frameEncoder";
import { TYPE_DOUBLE, TYPE_LONG, TYPE_SYMBOL, TYPE_TIMESTAMP } from "./protocol/constants";

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
    const col = t.getOrCreateColumn("timestamp", TYPE_TIMESTAMP);
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

  toBufferNew(): Buffer | null {
    const dirty = this.tables.filter((t) => t.rowCount > 0);
    if (dirty.length === 0) return null;
    const frame = encodeFrame(dirty);
    this.reset();
    return frame;
  }

  toBufferView(): Buffer {
    throw new Error("toBufferView is not supported by the QWP buffer");
  }

  currentPosition(): number {
    return this.rows;
  }

  // Column types arriving in a later plan — fail loudly rather than emit wrong bytes.
  stringColumn(): SenderBuffer {
    return unsupported("stringColumn");
  }
  booleanColumn(): SenderBuffer {
    return unsupported("booleanColumn");
  }
  arrayColumn(): SenderBuffer {
    return unsupported("arrayColumn");
  }
  decimalColumnText(): SenderBuffer {
    return unsupported("decimalColumnText");
  }
  decimalColumn(): SenderBuffer {
    return unsupported("decimalColumn");
  }
}
