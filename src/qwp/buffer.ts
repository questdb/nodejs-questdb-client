import { Buffer } from "node:buffer";
import { SenderBuffer } from "../buffer";
import { TimestampUnit } from "../utils";
import { QwpTableBuffer } from "./protocol/tableBuffer";
import { encodeFrame } from "./protocol/frameEncoder";
import { SymbolDict } from "./protocol/symbolDict";
import { flattenArray } from "./protocol/columnWriter";
import { TYPE_BOOLEAN, TYPE_DOUBLE, TYPE_DOUBLE_ARRAY, TYPE_LONG, TYPE_SYMBOL, TYPE_TIMESTAMP, TYPE_VARCHAR } from "./protocol/constants";

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
  private dict?: SymbolDict;
  private confirmedMaxId = -1;
  private gorilla = true;
  private deferCommit = false;
  private persist?: (entries: string[]) => void;

  /**
   * Attach a connection-scoped symbol dictionary (delta mode) plus an optional
   * write-ahead persist callback, or undefined to stay in full-dict mode.
   * `persist` is invoked with every batch of newly introduced symbols before
   * the owning frame is published (spec 8.1.6); if it throws, the buffer
   * degrades permanently to full-dict mode (spec 5.2).
   */
  attachDict(d: SymbolDict | undefined, persist?: (entries: string[]) => void): void {
    this.dict = d;
    this.persist = persist;
  }

  /**
   * One-way, permanent degradation. The side file can start failing appends
   * while segments stay writable, because segments are pre-allocated and the
   * dictionary is the one thing still growing. A fixed mode would turn that
   * into total, permanent ingestion loss (spec 5.2).
   */
  private disableDeltaDict(): void {
    this.dict = undefined;
    this.persist = undefined;
    this.confirmedMaxId = -1;
  }

  setConfirmedMaxId(id: number): void {
    this.confirmedMaxId = id;
  }

  setDeferCommit(on: boolean): void {
    this.deferCommit = on;
  }

  reset(): SenderBuffer {
    this.tables = [];
    this.byName = new Map();
    this.current = undefined;
    this.rows = 0;
    this.confirmedMaxId = -1;
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

  /**
   * A setter that throws mid-row must roll every column back to the last row
   * boundary, or columns desynchronise and every later frame is malformed while
   * still looking structurally valid (spec 4.1.1).
   */
  private guard<R>(fn: () => R): R {
    try {
      return fn();
    } catch (e) {
      this.current?.rollbackRow();
      throw e;
    }
  }

  symbol(name: string, value: unknown): SenderBuffer {
    return this.guard(() => {
      const col = this.require().getOrCreateColumn(name, TYPE_SYMBOL);
      if (col) {
        const text = String(value);
        // Keep the id AND the text. Delta mode encodes the id; a runtime
        // fallback to full-dict mode needs the text back (spec 5.2).
        col.values.push(this.dict ? { id: this.dict.getOrAdd(text), text } : text);
      }
      return this;
    });
  }

  intColumn(name: string, value: number): SenderBuffer {
    return this.guard(() => {
      if (!Number.isInteger(value)) throw new Error(`value must be an integer, received ${value}`);
      const col = this.require().getOrCreateColumn(name, TYPE_LONG);
      if (col) col.values.push(BigInt(value));
      return this;
    });
  }

  floatColumn(name: string, value: number): SenderBuffer {
    return this.guard(() => {
      const col = this.require().getOrCreateColumn(name, TYPE_DOUBLE);
      if (col) col.values.push(value);
      return this;
    });
  }

  timestampColumn(name: string, value: number | bigint, unit: TimestampUnit = "us"): SenderBuffer {
    return this.guard(() => {
      const col = this.require().getOrCreateColumn(name, TYPE_TIMESTAMP);
      if (col) col.values.push(toMicros(value, unit));
      return this;
    });
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
    const dirty = this.tables.filter((t) => t.rowCount > 0);
    if (dirty.length === 0) return [];

    // Write-ahead persist this batch's new symbols before encoding any frame.
    // With the buffer already containing this batch's rows, a failure here
    // degrades to full-dict mode; the persisted symbols are not yet on any
    // wire, so nothing must be retained (spec 5.2, 8.1.6).
    if (this.dict && this.persist) {
      const fresh = this.dict.entriesFrom(this.confirmedMaxId + 1);
      if (fresh.length > 0) {
        try {
          this.persist(fresh);
          this.confirmedMaxId = this.dict.size() - 1;
        } catch {
          this.disableDeltaDict();
        }
      }
    }

    const opts = {
      gorilla: this.gorilla,
      dict: this.dict,
      confirmedMaxId: this.confirmedMaxId,
    };
    const combined = encodeFrame(dirty, {
      ...opts,
      deferCommit: this.deferCommit,
    });
    if (combined.length <= maxBatchSize) {
      this.reset();
      return [combined];
    }

    // Pre-flight EVERY split frame before publishing any: discovering an
    // oversized frame mid-publish strands the already-sent prefix and a later
    // commit delivers a partial batch (spec 5.1).
    const parts: Buffer[] = [];
    for (let i = 0; i < dirty.length; i++) {
      const isLast = i === dirty.length - 1;
      const f = encodeFrame([dirty[i]], {
        ...opts,
        deferCommit: this.deferCommit ? true : !isLast,
      });
      if (f.length > maxBatchSize) {
        throw new Error(
          `batch cannot fit the server cap however it is split ` +
            `[table=${dirty[i].name}, frameSize=${f.length}, cap=${maxBatchSize}]`,
        );
      }
      parts.push(f);
    }
    this.reset();
    return parts;
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
    return this.guard(() => {
      if (typeof value !== "string")
        throw new Error("stringColumn accepts only string values");
      const col = this.require().getOrCreateColumn(name, TYPE_VARCHAR);
      if (col) col.values.push(value);
      return this;
    });
  }
  booleanColumn(name: string, value: boolean): SenderBuffer {
    return this.guard(() => {
      const col = this.require().getOrCreateColumn(name, TYPE_BOOLEAN);
      if (col) col.values.push(value);
      return this;
    });
  }
  arrayColumn(name: string, value: unknown[]): SenderBuffer {
    return this.guard(() => {
      const col = this.require().getOrCreateColumn(name, TYPE_DOUBLE_ARRAY);
      if (col) col.values.push(flattenArray(value));
      return this;
    });
  }
  decimalColumnText(): SenderBuffer {
    return unsupported("decimalColumnText");
  }
  decimalColumn(): SenderBuffer {
    return unsupported("decimalColumn");
  }
}
