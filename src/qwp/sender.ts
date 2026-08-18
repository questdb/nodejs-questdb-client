import {
  QWP_COLUMN_TYPE,
  QwpColumnType,
  QwpIngressEncodeOptions,
  QwpIngressResponse,
  QwpTableBuffer,
  flattenQwpArray,
} from "./core";

export type QwpTimestampUnit = "ns" | "us" | "ms";

export type QwpSenderLogger = (
  level: "error" | "warn" | "info" | "debug",
  message: string | Error,
) => void;

export interface QwpSenderEncodeOptions
  extends Pick<QwpIngressEncodeOptions, "gorilla"> {
  /** Connection-scoped deltas are the default; use `full` to opt out. */
  symbolDictionary?: "delta" | "full";
}

/** Options for the browser-safe, fluent QWP sender. */
export interface QwpSenderOptions {
  autoFlush?: boolean;
  autoFlushRows?: number;
  autoFlushIntervalMs?: number;
  /**
   * Keep auto-flushed rows in an open server-side transaction. An explicit
   * flush()/commit() closes the transaction. QWP transactions are atomic per
   * table, rather than across every table in a multi-table flush.
   */
  transactional?: boolean;
  /** Wait for durable upload after every successful ingress ACK. */
  awaitDurableAck?: boolean;
  durableAckTimeoutMs?: number;
  /** QWP frame encoding options supported by the high-level sender. */
  encode?: QwpSenderEncodeOptions;
  log?: QwpSenderLogger;
}

/** The subset of QwpIngressSession used by QwpSender. */
export interface QwpSenderSession {
  sendTables(
    tables: readonly QwpTableBuffer[],
    options?: QwpIngressEncodeOptions,
  ): Promise<QwpIngressResponse>;
  sendTablesDelta?(
    tables: readonly QwpTableBuffer[],
    options?: Pick<QwpIngressEncodeOptions, "gorilla" | "deferCommit">,
  ): Promise<QwpIngressResponse>;
  waitForDurable(
    response: QwpIngressResponse,
    timeoutMs?: number,
  ): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}

export type QwpSenderSessionFactory = () => Promise<QwpSenderSession>;

interface StagedColumn {
  name: string;
  type: QwpColumnType;
  value: unknown;
  geohashPrecision?: number;
  decimalScale?: number;
}

interface StagedTable {
  name: string;
  rows: Map<string, StagedColumn>[];
  schema: Map<
    string,
    Pick<StagedColumn, "type" | "geohashPrecision" | "decimalScale">
  >;
}

const DEFAULT_AUTO_FLUSH_ROWS = 1_000;
const DEFAULT_AUTO_FLUSH_INTERVAL_MS = 100;

function validateNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function checkedInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer`);
  }
  return value;
}

function checkedRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const integer = checkedInteger(value, name);
  if (integer < minimum || integer > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return integer;
}

function checkedBigInt(
  value: number | bigint,
  name: string,
  requireBigInt = false,
): bigint {
  if (requireBigInt && typeof value !== "bigint") {
    throw new TypeError(`${name} must be a bigint`);
  }
  return typeof value === "bigint"
    ? value
    : BigInt(checkedInteger(value, name));
}

function checkedInt64(
  value: number | bigint,
  name: string,
  requireBigInt = false,
): bigint {
  const result = checkedBigInt(value, name, requireBigInt);
  if (!fitsSigned(result, 64))
    throw new RangeError(`${name} exceeds signed int64`);
  return result;
}

function timestampValue(
  value: number | bigint,
  unit: QwpTimestampUnit,
): { type: QwpColumnType; value: bigint } {
  switch (unit) {
    case "ns":
      return {
        type: QWP_COLUMN_TYPE.TIMESTAMP_NANOS,
        value: checkedInt64(value, "nanosecond timestamp", true),
      };
    case "us":
      return {
        type: QWP_COLUMN_TYPE.TIMESTAMP,
        value: checkedInt64(value, "microsecond timestamp"),
      };
    case "ms": {
      const micros = checkedBigInt(value, "millisecond timestamp") * 1_000n;
      if (!fitsSigned(micros, 64)) {
        throw new RangeError(
          "millisecond timestamp exceeds signed int64 micros",
        );
      }
      return {
        type: QWP_COLUMN_TYPE.TIMESTAMP,
        value: micros,
      };
    }
    default:
      throw new TypeError(`unsupported timestamp unit '${String(unit)}'`);
  }
}

function signedBigEndianToBigInt(bytes: Int8Array): bigint {
  if (bytes.length === 0) return 0n;
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte & 0xff);
  if ((bytes[0] & 0x80) !== 0) result -= 1n << BigInt(bytes.length * 8);
  return result;
}

function fitsSigned(value: bigint, bits: number): boolean {
  return BigInt.asIntN(bits, value) === value;
}

function decimalType(value: bigint, scale: number): QwpColumnType {
  if (scale <= 18 && fitsSigned(value, 64)) return QWP_COLUMN_TYPE.DECIMAL64;
  if (scale <= 38 && fitsSigned(value, 128)) return QWP_COLUMN_TYPE.DECIMAL128;
  if (scale <= 76 && fitsSigned(value, 256)) return QWP_COLUMN_TYPE.DECIMAL256;
  throw new RangeError("decimal value or scale exceeds DECIMAL256 capacity");
}

function parseDecimal(value: string | number): {
  unscaled: bigint;
  scale: number;
} {
  const text = String(value);
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new TypeError(`invalid decimal value '${text}'`);
  const fraction = match[3] ?? "";
  const magnitude = BigInt(`${match[2]}${fraction}`);
  return {
    unscaled: match[1] === "-" ? -magnitude : magnitude,
    scale: fraction.length,
  };
}

function littleEndianWords(words: readonly bigint[]): Uint8Array {
  const bytes = new Uint8Array(words.length * 8);
  const view = new DataView(bytes.buffer);
  words.forEach((word, index) => view.setBigInt64(index * 8, word, true));
  return bytes;
}

function uuidBytes(value: string | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length !== 16) {
      throw new RangeError("UUID byte value must contain exactly 16 bytes");
    }
    return new Uint8Array(value);
  }
  const match =
    /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(
      value,
    );
  if (!match) throw new TypeError("UUID value must use canonical UUID syntax");
  const hex = match.slice(1).join("");
  const high = BigInt(`0x${hex.slice(0, 16)}`);
  const low = BigInt(`0x${hex.slice(16)}`);
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, low, true);
  view.setBigUint64(8, high, true);
  return bytes;
}

function parseIpv4(value: string | number): number {
  if (typeof value === "number") {
    return checkedRange(value, 1, 0xffffffff, "IPv4 value");
  }
  const parts = value.split(".");
  if (parts.length !== 4)
    throw new TypeError(`invalid IPv4 address '${value}'`);
  let packed = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      throw new TypeError(`invalid IPv4 address '${value}'`);
    }
    const octet = Number(part);
    if (octet > 255) throw new TypeError(`invalid IPv4 address '${value}'`);
    packed = packed * 256 + octet;
  }
  if (packed === 0) {
    throw new RangeError("0.0.0.0 is QuestDB's IPv4 NULL sentinel");
  }
  return packed;
}

/**
 * Browser-safe high-level QWP ingress API.
 *
 * Applications normally obtain this class through create/connectQwpNodeSender
 * or create/connectQwpBrowserSender, rather than constructing sessions and
 * QwpTableBuffer instances themselves.
 */
export class QwpSender {
  private readonly tables: StagedTable[] = [];
  private readonly tablesByName = new Map<string, StagedTable>();
  private current?: StagedTable;
  private currentRow = new Map<string, StagedColumn>();
  private pendingRowCount = 0;
  private lastFlushTime = Date.now();
  private sessionPromise?: Promise<QwpSenderSession>;
  private flushTail: Promise<void> = Promise.resolve();
  private closePromise?: Promise<void>;
  private closing = false;
  private closed = false;
  private hasDeferredMessages = false;
  private deferredRowCount = 0;
  private readonly deferredAcks: Promise<QwpIngressResponse>[] = [];

  private readonly autoFlush: boolean;
  private readonly autoFlushRows: number;
  private readonly autoFlushIntervalMs: number;
  private readonly transactional: boolean;
  private readonly log: QwpSenderLogger;

  constructor(
    private readonly sessionFactory: QwpSenderSessionFactory,
    private readonly options: QwpSenderOptions = {},
  ) {
    this.autoFlush = options.autoFlush ?? true;
    this.autoFlushRows = options.autoFlushRows ?? DEFAULT_AUTO_FLUSH_ROWS;
    this.autoFlushIntervalMs =
      options.autoFlushIntervalMs ?? DEFAULT_AUTO_FLUSH_INTERVAL_MS;
    this.transactional = options.transactional ?? false;
    validateNonNegativeInteger(this.autoFlushRows, "autoFlushRows");
    validateNonNegativeInteger(this.autoFlushIntervalMs, "autoFlushIntervalMs");
    if (
      options.durableAckTimeoutMs !== undefined &&
      (!Number.isFinite(options.durableAckTimeoutMs) ||
        options.durableAckTimeoutMs <= 0)
    ) {
      throw new RangeError("durableAckTimeoutMs must be a positive number");
    }
    this.log = options.log ?? (() => undefined);
  }

  async connect(): Promise<boolean> {
    this.throwIfUnavailable();
    await this.getSession();
    return true;
  }

  reset(): QwpSender {
    this.throwIfUnavailable();
    this.tables.length = 0;
    this.tablesByName.clear();
    this.current = undefined;
    this.currentRow.clear();
    this.resetAutoFlush();
    return this;
  }

  table(name: string): QwpSender {
    this.throwIfUnavailable();
    if (this.current) throw new Error("Table name has already been set");
    // Validate eagerly rather than waiting for flush.
    new QwpTableBuffer(name);
    let table = this.tablesByName.get(name);
    if (!table) {
      table = { name, rows: [], schema: new Map() };
      this.tablesByName.set(name, table);
      this.tables.push(table);
    }
    this.current = table;
    return this;
  }

  symbol(name: string, value: unknown): QwpSender {
    if (value === null || value === undefined) return this;
    return this.addColumn(name, QWP_COLUMN_TYPE.SYMBOL, String(value));
  }

  stringColumn(name: string, value: string | null | undefined): QwpSender {
    if (value === null || value === undefined) return this;
    if (typeof value !== "string") {
      return this.failRow(new TypeError("stringColumn accepts only strings"));
    }
    return this.addColumn(name, QWP_COLUMN_TYPE.VARCHAR, value);
  }

  booleanColumn(name: string, value: boolean | null | undefined): QwpSender {
    if (value === null || value === undefined) return this;
    if (typeof value !== "boolean") {
      return this.failRow(new TypeError("booleanColumn accepts only booleans"));
    }
    return this.addColumn(name, QWP_COLUMN_TYPE.BOOLEAN, value);
  }

  floatColumn(name: string, value: number | null | undefined): QwpSender {
    if (value === null || value === undefined) return this;
    if (typeof value !== "number") {
      return this.failRow(new TypeError("floatColumn accepts only numbers"));
    }
    return this.addColumn(name, QWP_COLUMN_TYPE.DOUBLE, value);
  }

  doubleColumn(name: string, value: number | null | undefined): QwpSender {
    return this.floatColumn(name, value);
  }

  float32Column(name: string, value: number | null | undefined): QwpSender {
    if (value === null || value === undefined) return this;
    if (typeof value !== "number") {
      return this.failRow(new TypeError("float32Column accepts only numbers"));
    }
    return this.addColumn(name, QWP_COLUMN_TYPE.FLOAT, value);
  }

  byteColumn(name: string, value: number | null | undefined): QwpSender {
    if (value === null || value === undefined) return this;
    try {
      return this.addColumn(
        name,
        QWP_COLUMN_TYPE.BYTE,
        checkedRange(value, -128, 127, "byteColumn value"),
      );
    } catch (error) {
      return this.failRow(error);
    }
  }

  shortColumn(name: string, value: number | null | undefined): QwpSender {
    if (value === null || value === undefined) return this;
    try {
      return this.addColumn(
        name,
        QWP_COLUMN_TYPE.SHORT,
        checkedRange(value, -32_768, 32_767, "shortColumn value"),
      );
    } catch (error) {
      return this.failRow(error);
    }
  }

  int32Column(name: string, value: number | null | undefined): QwpSender {
    if (value === null || value === undefined) return this;
    try {
      return this.addColumn(
        name,
        QWP_COLUMN_TYPE.INT,
        checkedRange(value, -2_147_483_648, 2_147_483_647, "int32Column value"),
      );
    } catch (error) {
      return this.failRow(error);
    }
  }

  intColumn(name: string, value: number | null | undefined): QwpSender {
    if (value === null || value === undefined) return this;
    try {
      return this.addColumn(
        name,
        QWP_COLUMN_TYPE.LONG,
        BigInt(checkedInteger(value, "intColumn value")),
      );
    } catch (error) {
      return this.failRow(error);
    }
  }

  longColumn(
    name: string,
    value: number | bigint | null | undefined,
  ): QwpSender {
    if (value === null || value === undefined) return this;
    try {
      return this.addColumn(
        name,
        QWP_COLUMN_TYPE.LONG,
        checkedInt64(value, "longColumn value"),
      );
    } catch (error) {
      return this.failRow(error);
    }
  }

  arrayColumn(name: string, value: unknown[] | null | undefined): QwpSender {
    if (value === null || value === undefined) return this;
    try {
      const array = flattenQwpArray(value);
      if (array.values.some((item) => typeof item !== "number")) {
        throw new TypeError("arrayColumn accepts only number arrays");
      }
      return this.addColumn(name, QWP_COLUMN_TYPE.DOUBLE_ARRAY, array);
    } catch (error) {
      return this.failRow(error);
    }
  }

  longArrayColumn(
    name: string,
    value: unknown[] | null | undefined,
  ): QwpSender {
    if (value === null || value === undefined) return this;
    try {
      const array = flattenQwpArray(value);
      array.values = array.values.map((item) =>
        checkedInt64(item, "long array value"),
      );
      return this.addColumn(name, QWP_COLUMN_TYPE.LONG_ARRAY, array);
    } catch (error) {
      return this.failRow(error);
    }
  }

  timestampColumn(
    name: string,
    value: number | bigint | null | undefined,
    unit: QwpTimestampUnit = "us",
  ): QwpSender {
    if (value === null || value === undefined) return this;
    try {
      const timestamp = timestampValue(value, unit);
      return this.addColumn(name, timestamp.type, timestamp.value);
    } catch (error) {
      return this.failRow(error);
    }
  }

  dateColumn(
    name: string,
    millisecondsSinceEpoch: number | bigint | null | undefined,
  ): QwpSender {
    if (
      millisecondsSinceEpoch === null ||
      millisecondsSinceEpoch === undefined
    ) {
      return this;
    }
    try {
      return this.addColumn(
        name,
        QWP_COLUMN_TYPE.DATE,
        checkedInt64(millisecondsSinceEpoch, "dateColumn value"),
      );
    } catch (error) {
      return this.failRow(error);
    }
  }

  binaryColumn(name: string, value: Uint8Array | null | undefined): QwpSender {
    if (value === null || value === undefined) return this;
    if (!(value instanceof Uint8Array)) {
      return this.failRow(
        new TypeError("binaryColumn accepts only Uint8Array values"),
      );
    }
    return this.addColumn(name, QWP_COLUMN_TYPE.BINARY, new Uint8Array(value));
  }

  charColumn(name: string, value: string | null | undefined): QwpSender {
    if (value === null || value === undefined) return this;
    if (typeof value !== "string" || value.length !== 1) {
      return this.failRow(
        new TypeError("charColumn accepts one UTF-16 code unit"),
      );
    }
    return this.addColumn(name, QWP_COLUMN_TYPE.CHAR, value);
  }

  uuidColumn(
    name: string,
    value: string | Uint8Array | null | undefined,
  ): QwpSender {
    if (value === null || value === undefined) return this;
    try {
      return this.addColumn(name, QWP_COLUMN_TYPE.UUID, uuidBytes(value));
    } catch (error) {
      return this.failRow(error);
    }
  }

  long256Column(
    name: string,
    word0: bigint,
    word1: bigint,
    word2: bigint,
    word3: bigint,
  ): QwpSender {
    try {
      const words = [word0, word1, word2, word3];
      for (const [index, word] of words.entries()) {
        if (BigInt.asIntN(64, word) !== word) {
          throw new RangeError(`LONG256 word ${index} exceeds signed int64`);
        }
      }
      return this.addColumn(
        name,
        QWP_COLUMN_TYPE.LONG256,
        littleEndianWords(words),
      );
    } catch (error) {
      return this.failRow(error);
    }
  }

  ipv4Column(
    name: string,
    value: string | number | null | undefined,
  ): QwpSender {
    if (value === null || value === undefined) return this;
    try {
      return this.addColumn(name, QWP_COLUMN_TYPE.IPV4, parseIpv4(value));
    } catch (error) {
      return this.failRow(error);
    }
  }

  decimalColumnText(
    name: string,
    value: string | number | null | undefined,
  ): QwpSender {
    if (value === null || value === undefined) return this;
    try {
      const decimal = parseDecimal(value);
      if (decimal.scale > 76 || !fitsSigned(decimal.unscaled, 256)) {
        throw new RangeError(
          "decimal value or scale exceeds DECIMAL256 capacity",
        );
      }
      return this.addColumn(
        name,
        QWP_COLUMN_TYPE.DECIMAL256,
        decimal.unscaled,
        { decimalScale: decimal.scale },
      );
    } catch (error) {
      return this.failRow(error);
    }
  }

  decimalColumn(
    name: string,
    unscaled: Int8Array | bigint | null | undefined,
    scale: number,
  ): QwpSender {
    if (unscaled === null || unscaled === undefined) return this;
    try {
      if (!Number.isSafeInteger(scale) || scale < 0 || scale > 76) {
        throw new RangeError("decimal scale must be between 0 and 76");
      }
      if (unscaled instanceof Int8Array && unscaled.length === 0) return this;
      if (unscaled instanceof Int8Array && unscaled.length > 32) {
        throw new RangeError("decimal unscaled value cannot exceed 32 bytes");
      }
      const value =
        typeof unscaled === "bigint"
          ? unscaled
          : signedBigEndianToBigInt(unscaled);
      return this.addColumn(name, decimalType(value, scale), value, {
        decimalScale: scale,
      });
    } catch (error) {
      return this.failRow(error);
    }
  }

  decimal64Column(
    name: string,
    unscaled: bigint | null | undefined,
    scale: number,
  ): QwpSender {
    return this.fixedDecimalColumn(
      name,
      unscaled,
      scale,
      QWP_COLUMN_TYPE.DECIMAL64,
      64,
      18,
    );
  }

  decimal128Column(
    name: string,
    unscaled: bigint | null | undefined,
    scale: number,
  ): QwpSender {
    return this.fixedDecimalColumn(
      name,
      unscaled,
      scale,
      QWP_COLUMN_TYPE.DECIMAL128,
      128,
      38,
    );
  }

  decimal256Column(
    name: string,
    unscaled: bigint | null | undefined,
    scale: number,
  ): QwpSender {
    return this.fixedDecimalColumn(
      name,
      unscaled,
      scale,
      QWP_COLUMN_TYPE.DECIMAL256,
      256,
      76,
    );
  }

  geohashColumn(
    name: string,
    value: bigint | null | undefined,
    precision: number,
  ): QwpSender {
    if (value === null || value === undefined) return this;
    if (!Number.isSafeInteger(precision) || precision < 1 || precision > 60) {
      return this.failRow(
        new RangeError("geohash precision must be between 1 and 60"),
      );
    }
    if (value < 0n || value >= 1n << BigInt(precision)) {
      return this.failRow(
        new RangeError("geohash value does not fit the requested precision"),
      );
    }
    return this.addColumn(name, QWP_COLUMN_TYPE.GEOHASH, value, {
      geohashPrecision: precision,
    });
  }

  cancelRow(): QwpSender {
    this.throwIfUnavailable();
    this.currentRow.clear();
    return this;
  }

  async at(
    value: number | bigint,
    unit: QwpTimestampUnit = "us",
  ): Promise<void> {
    try {
      const timestamp = timestampValue(value, unit);
      this.addColumn("", timestamp.type, timestamp.value);
      this.finishRow();
    } catch (error) {
      this.failRow(error);
    }
    await this.tryFlush();
  }

  async atNow(): Promise<void> {
    this.throwIfUnavailable();
    this.requireTable();
    this.finishRow();
    await this.tryFlush();
  }

  flush(): Promise<boolean> {
    return this.enqueueFlush(false);
  }

  /**
   * Commits rows previously sent by transactional auto-flush. This is an
   * ergonomic alias for flush(); pending local rows are included in the same
   * group-closing frame.
   */
  commit(): Promise<boolean> {
    return this.flush();
  }

  private enqueueFlush(deferCommit: boolean): Promise<boolean> {
    this.throwIfUnavailable();
    const flushing = this.flushTail.then(() => this.flushNow(deferCommit));
    this.flushTail = flushing.then(
      () => undefined,
      () => undefined,
    );
    return flushing;
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeNow();
    return this.closePromise;
  }

  private async closeNow(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    // Let a flush already queued in this turn enter getSession() so it can be
    // cancelled through the session instead of making close wait for its ACK.
    await Promise.resolve();
    let sessionClose: Promise<void> | undefined;
    let sessionFailure: { reason: unknown } | undefined;
    if (this.sessionPromise) {
      try {
        const session = await this.sessionPromise;
        try {
          sessionClose = session.close();
        } catch (error) {
          sessionClose = Promise.reject(error);
        }
      } catch (error) {
        sessionFailure = { reason: error };
      }
    }
    const [, closeResult] = await Promise.allSettled([
      this.flushTail,
      sessionClose ?? Promise.resolve(),
    ]);
    if (this.pendingRowCount > 0 || this.currentRow.size > 0) {
      this.log(
        "warn",
        `QWP sender contains ${this.pendingRowCount} completed row(s) and ${this.currentRow.size} unfinished column(s) which will be lost`,
      );
    }
    if (this.hasDeferredMessages) {
      this.log(
        "warn",
        `QWP sender is closing with ${this.deferredRowCount} auto-flushed row(s) awaiting commit; QuestDB will roll the open transaction back`,
      );
    }
    this.closed = true;
    if (sessionFailure) throw sessionFailure.reason;
    if (closeResult.status === "rejected") throw closeResult.reason;
  }

  private fixedDecimalColumn(
    name: string,
    unscaled: bigint | null | undefined,
    scale: number,
    type: QwpColumnType,
    bits: number,
    maximumScale: number,
  ): QwpSender {
    if (unscaled === null || unscaled === undefined) return this;
    try {
      if (!Number.isSafeInteger(scale) || scale < 0 || scale > maximumScale) {
        throw new RangeError(
          `decimal scale must be between 0 and ${maximumScale}`,
        );
      }
      if (!fitsSigned(unscaled, bits)) {
        throw new RangeError(`decimal value exceeds signed int${bits}`);
      }
      return this.addColumn(name, type, unscaled, { decimalScale: scale });
    } catch (error) {
      return this.failRow(error);
    }
  }

  private addColumn(
    name: string,
    type: QwpColumnType,
    value: unknown,
    metadata: Pick<StagedColumn, "geohashPrecision" | "decimalScale"> = {},
  ): QwpSender {
    try {
      this.throwIfUnavailable();
      const table = this.requireTable();
      if (typeof name !== "string") {
        throw new TypeError("column name must be a string");
      }
      const existingSchema = table.schema.get(name);
      if (
        existingSchema &&
        (existingSchema.type !== type ||
          existingSchema.geohashPrecision !== metadata.geohashPrecision ||
          existingSchema.decimalScale !== metadata.decimalScale)
      ) {
        throw new Error(`column type mismatch for '${name}'`);
      }
      if (this.currentRow.has(name)) return this;
      table.schema.set(name, { type, ...metadata });
      this.currentRow.set(name, { name, type, value, ...metadata });
      return this;
    } catch (error) {
      return this.failRow(error);
    }
  }

  private finishRow(): void {
    const table = this.requireTable();
    table.rows.push(this.currentRow);
    this.currentRow = new Map();
    this.current = undefined;
    this.pendingRowCount++;
    this.log("debug", `Pending QWP row count: ${this.pendingRowCount}`);
  }

  private requireTable(): StagedTable {
    if (!this.current) {
      throw new Error("table name must be set before adding columns");
    }
    return this.current;
  }

  private failRow(error: unknown): never {
    this.currentRow.clear();
    throw error;
  }

  private async tryFlush(): Promise<void> {
    if (
      this.autoFlush &&
      this.pendingRowCount > 0 &&
      ((this.autoFlushRows > 0 && this.pendingRowCount >= this.autoFlushRows) ||
        (this.autoFlushIntervalMs > 0 &&
          Date.now() - this.lastFlushTime >= this.autoFlushIntervalMs))
    ) {
      await this.enqueueFlush(this.transactional);
    }
  }

  private async flushNow(deferCommit: boolean): Promise<boolean> {
    if (
      this.pendingRowCount === 0 &&
      (deferCommit || !this.hasDeferredMessages)
    ) {
      return false;
    }
    const session = await this.getSession();
    const snapshots = this.tables
      .filter((table) => table.rows.length > 0)
      .map((table) => ({ table, rows: table.rows.slice() }));
    if (snapshots.length === 0 && !this.hasDeferredMessages) return false;

    const wireTables = snapshots.map(({ table, rows }) =>
      this.buildTable(table.name, rows),
    );
    // sendTables encodes synchronously. Do not compact staging if encoding
    // throws, but transfer ownership once the frame has entered the session.
    const encode = this.options.encode;
    const response =
      (encode?.symbolDictionary ?? "delta") === "delta" &&
      session.sendTablesDelta
        ? session.sendTablesDelta(wireTables, {
            gorilla: encode?.gorilla,
            deferCommit,
          })
        : session.sendTables(wireTables, {
            gorilla: encode?.gorilla,
            deferCommit,
          });
    for (const { table, rows } of snapshots) table.rows.splice(0, rows.length);
    const sentRows = snapshots.reduce(
      (count, item) => count + item.rows.length,
      0,
    );
    this.pendingRowCount -= sentRows;
    this.lastFlushTime = Date.now();
    this.log(
      "debug",
      `${deferCommit ? "Auto-flushing" : "Flushing"} ${sentRows} QWP row(s)${deferCommit ? " with commit deferred" : ""}`,
    );

    if (deferCommit) {
      this.hasDeferredMessages = true;
      this.deferredRowCount += sentRows;
      this.deferredAcks.push(response);
      // The server intentionally withholds this ACK until a later commit.
      // Observe rejection now so abandoning an open transaction during close
      // never creates an unhandled rejection; flush()/commit() still awaits it.
      void response.catch(() => undefined);
      return true;
    }

    const ack = await response;
    const deferredAcks = this.deferredAcks.splice(0);
    this.hasDeferredMessages = false;
    this.deferredRowCount = 0;
    await Promise.all(deferredAcks);
    if (this.options.awaitDurableAck) {
      await session.waitForDurable(ack, this.options.durableAckTimeoutMs);
    }
    return true;
  }

  private buildTable(
    name: string,
    rows: readonly Map<string, StagedColumn>[],
  ): QwpTableBuffer {
    const result = new QwpTableBuffer(name);
    for (const row of rows) {
      for (const column of row.values()) {
        const target = result.getOrCreateColumn(column.name, column.type);
        if (!target) continue;
        if (column.geohashPrecision !== undefined) {
          result.setGeohashPrecision(target, column.geohashPrecision);
        }
        if (column.decimalScale !== undefined) {
          result.setDecimalScale(target, column.decimalScale);
        }
        target.values.push(column.value);
      }
      result.nextRow();
    }
    return result;
  }

  private getSession(): Promise<QwpSenderSession> {
    if (!this.sessionPromise) {
      const connecting = this.sessionFactory().catch((error: unknown) => {
        if (this.sessionPromise === connecting) this.sessionPromise = undefined;
        throw error;
      });
      this.sessionPromise = connecting;
    }
    return this.sessionPromise;
  }

  private resetAutoFlush(): void {
    this.pendingRowCount = 0;
    this.lastFlushTime = Date.now();
  }

  private throwIfClosed(): void {
    if (this.closed) throw new Error("QWP sender is closed");
  }

  private throwIfUnavailable(): void {
    this.throwIfClosed();
    if (this.closing) throw new Error("QWP sender is closing");
  }
}
