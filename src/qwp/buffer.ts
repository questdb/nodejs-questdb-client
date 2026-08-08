import { Buffer } from "node:buffer";
import { SenderBuffer } from "../buffer";
import { TimestampUnit } from "../utils";
import { QwpTableBuffer } from "./protocol/tableBuffer";
import { encodeFrame } from "./protocol/frameEncoder";
import { SymbolDict } from "./protocol/symbolDict";
import { flattenArray } from "./protocol/columnWriter";
import { TYPE_BOOLEAN, TYPE_DOUBLE, TYPE_DOUBLE_ARRAY, TYPE_LONG, TYPE_SYMBOL, TYPE_TIMESTAMP, TYPE_VARCHAR, MAX_ROWS_PER_TABLE } from "./protocol/constants";

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
   * Baseline to advance `confirmedMaxId` to once THIS sealed batch's frame(s)
   * have been queued onto the store-and-forward ring (spec 5.2). Populated by
   * {@link sealFrames} from the write-ahead persist; -1 when delta mode is not
   * active or the batch introduced no new symbols. See {@link confirmDeltaPublished}.
   */
  private deltaTarget = -1;

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

  /**
   * Report the delta baseline this sealed batch should advance to once its
   * frames are queued onto the ring, or -1 when nothing advances (spec 5.2).
   * Consumed by the transport's publish path.
   */
  get pendingDeltaTarget(): number {
    return this.deltaTarget;
  }

  /**
   * Advance the confirmed delta baseline because the sealed batch's frame(s)
   * were successfully queued onto the ring. Only ever forward; a batch that
   * introduced no new symbols leaves it untouched (spec 5.2).
   */
  confirmDeltaPublished(): void {
    if (this.deltaTarget >= 0) this.confirmedMaxId = this.deltaTarget;
  }

  reset(): SenderBuffer {
    // Clears the staging tables only. The confirmed delta baseline and the
    // write-ahead dictionary survive: they describe the connection-scoped
    // dictionary, which is independent of any one buffered batch (spec 5.2).
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
    // Spec 6.4: a single table is capped at DEFAULT_MAX_ROWS_PER_TABLE. The
    // server raises this default operationally, so a client-side refusal could
    // reject a frame a correctly-configured server accepts — but a frame that
    // crosses it is refused by every default server, and under store-and-forward
    // a refused frame is already durable and would replay forever. Fail the
    // batch here, before any byte is published, with a diagnostic that names the
    // table and the knob that raises it.
    for (const t of dirty) {
      if (t.rowCount > MAX_ROWS_PER_TABLE) {
        throw new Error(
          `table '${t.name}' carries ${t.rowCount} rows, exceeding the server ` +
            `DEFAULT_MAX_ROWS_PER_TABLE of ${MAX_ROWS_PER_TABLE} — flush more ` +
            `often (lower auto_flush_rows, or call flush()/sealFrames() sooner)` +
            ` so each batch stays under the limit`,
        );
      }
    }
    this.deltaTarget = -1;

    // Write-ahead persist this batch's new symbols before encoding any frame.
    // With the buffer already containing this batch's rows, a failure here
    // degrades to full-dict mode; the persisted symbols are not yet on any
    // wire, so nothing must be retained (spec 5.2, 8.1.6).
    //
    // Only the PERSIST cursor moves here; the delta baseline (confirmedMaxId)
    // is deliberately NOT advanced. Per spec 5.2 it may move only after a
    // frame carrying these symbols is queued onto the ring (a failed publish
    // would otherwise advance the baseline past ids the server never saw and
    // earn a DICTIONARY_GAP on the next frame). The transport calls
    // confirmDeltaPublished() on that ring-append success.
    const delta = this.dict !== undefined;
    if (delta) {
      const fresh = this.dict!.entriesFrom(this.confirmedMaxId + 1);
      if (fresh.length > 0) {
        try {
          this.persist?.(fresh);
          this.deltaTarget = this.dict!.size() - 1;
        } catch {
          this.disableDeltaDict();
        }
      } else {
        // The batch reuses only confirmed symbols; nothing to advance.
        this.deltaTarget = -1;
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
      // Delta-split: the FIRST part carries the whole batch's delta; later
      // parts reference only ids that first part registered, so their delta is
      // empty. Encoding them against the pre-advance baseline would re-ship
      // the same entries and re-register them positionally on the server,
      // silently renumbering later ids. Pin later parts to the post-batch
      // baseline (spec 5.2) — safe because they publish only after part 0.
      const partBaseline = delta && i > 0 ? this.dict!.size() - 1 : opts.confirmedMaxId;
      const f = encodeFrame([dirty[i]], {
        ...opts,
        confirmedMaxId: partBaseline,
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
