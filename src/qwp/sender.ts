import {
  QWP_COLUMN_TYPE,
  QwpColumnType,
  QwpIngressEncodeOptions,
  QwpIngressResponse,
  QwpTableBuffer,
  flattenQwpArray,
  utf8Length,
  type QwpArrayValue,
} from "./core";
import {
  QwpIngressAckTimeoutError,
  type QwpIngressSendResult,
  type QwpIngressMetrics,
} from "./ingress-session";
import { qwpColumnNameKey, validateQwpColumnName } from "./core/identifiers";

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
  /**
   * Soft threshold for estimated buffered column bytes. Zero disables the byte
   * trigger. Defaults to zero and is clamped below a connected server's batch
   * cap; exact encoded frames remain subject to the protocol batch limit.
   */
  autoFlushBytes?: number;
  autoFlushIntervalMs?: number;
  /** Maximum UTF-16 length of table and column names. Defaults to 127. */
  maxNameLength?: number;
  /**
   * Keep auto-flushed rows in an open server-side transaction. An explicit
   * flush()/commit() closes the transaction. QWP transactions are atomic per
   * table, rather than across every table in a multi-table flush.
   */
  transactional?: boolean;
  /**
   * Wait for the server's protocol ACK before flush()/commit() resolves.
   * Defaults to false, matching the Java QWP sender's local-publication
   * boundary. Set this to true for an acknowledgement barrier, or use
   * flushAndGetSequence() followed by waitForAcknowledged().
   */
  awaitServerAck?: boolean;
  /**
   * Wait for durable upload after every successful ingress ACK. When true,
   * this implies awaitServerAck unless awaitServerAck is explicitly false.
   */
  awaitDurableAck?: boolean;
  durableAckTimeoutMs?: number;
  /**
   * Maximum time close() spends publishing queued rows and waiting for the
   * server ACK watermark. Zero skips the drain. Defaults to 60 seconds.
   */
  closeFlushTimeoutMs?: number;
  /** QWP frame encoding options supported by the high-level sender. */
  encode?: QwpSenderEncodeOptions;
  log?: QwpSenderLogger;
}

/** close() could not publish and acknowledge all committed ingress frames. */
export class QwpSenderCloseTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly targetSequence: bigint;
  readonly acknowledgedSequence: bigint;

  constructor(
    timeoutMs: number,
    targetSequence: bigint,
    acknowledgedSequence: bigint,
  ) {
    super(
      `QWP sender close timed out after ${timeoutMs}ms [targetSequence=${targetSequence}, acknowledgedSequence=${acknowledgedSequence}]; pending data may be lost`,
    );
    this.name = "QwpSenderCloseTimeoutError";
    this.timeoutMs = timeoutMs;
    this.targetSequence = targetSequence;
    this.acknowledgedSequence = acknowledgedSequence;
  }
}

/** The subset of QwpIngressSession used by QwpSender. */
export interface QwpSenderSession {
  readonly metrics?: QwpIngressMetrics;
  readonly maxBatchSizeBytes?: number;
  readonly publishedFrameSequence?: bigint;
  readonly acknowledgedFrameSequence?: bigint;
  sendTables(
    tables: readonly QwpTableBuffer[],
    options?: QwpIngressEncodeOptions,
  ): Promise<QwpIngressResponse>;
  sendTablesDelta?(
    tables: readonly QwpTableBuffer[],
    options?: Pick<QwpIngressEncodeOptions, "gorilla" | "deferCommit">,
  ): Promise<QwpIngressResponse>;
  sendTablesWithPublication?(
    tables: readonly QwpTableBuffer[],
    options?: QwpIngressEncodeOptions,
  ): QwpIngressSendResult;
  sendTablesDeltaWithPublication?(
    tables: readonly QwpTableBuffer[],
    options?: Pick<QwpIngressEncodeOptions, "gorilla" | "deferCommit">,
  ): QwpIngressSendResult;
  publishTables?(
    tables: readonly QwpTableBuffer[],
    options?: QwpIngressEncodeOptions,
  ): Promise<void>;
  publishTablesDelta?(
    tables: readonly QwpTableBuffer[],
    options?: Pick<QwpIngressEncodeOptions, "gorilla" | "deferCommit">,
  ): Promise<void>;
  waitForAcknowledged?(
    targetSequence: bigint,
    timeoutMs?: number,
  ): Promise<void>;
  waitForDurable(
    response: QwpIngressResponse,
    timeoutMs?: number,
  ): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}

export type QwpSenderSessionFactory = () => Promise<QwpSenderSession>;

/** Immutable high-level sender counters plus the active ingress snapshot. */
export interface QwpSenderMetrics {
  readonly totalRowsStaged: number;
  /** Rows whose encoded frames have entered the ingress session. */
  readonly totalRowsPublished: number;
  readonly totalFlushes: number;
  readonly totalFlushFailures: number;
  readonly totalTransactionsCommitted: number;
  readonly pendingRows: number;
  /** Estimated raw column-buffer bytes currently staged. */
  readonly pendingBytes: number;
  readonly autoFlushBytes: number;
  readonly effectiveAutoFlushBytes: number;
  readonly deferredRows: number;
  readonly connected: boolean;
  readonly closing: boolean;
  readonly closed: boolean;
  readonly ingress?: QwpIngressMetrics;
}

interface StagedColumn {
  name: string;
  type: QwpColumnType;
  value: unknown;
  geohashPrecision?: number;
  decimalScale?: number;
}

interface StagedTable {
  name: string;
  rows: StagedRow[];
  schema: Map<
    string,
    Pick<StagedColumn, "name" | "type" | "geohashPrecision" | "decimalScale">
  >;
}

interface StagedRow {
  readonly columns: Map<string, StagedColumn>;
  readonly estimatedBytes: number;
}

interface QwpSenderFlushResult {
  readonly flushed: boolean;
  readonly sequence: bigint;
}

const DEFAULT_AUTO_FLUSH_ROWS = 1_000;
const DEFAULT_AUTO_FLUSH_BYTES = 0;
const DEFAULT_AUTO_FLUSH_INTERVAL_MS = 100;
const DEFAULT_CLOSE_FLUSH_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_NAME_LENGTH = 127;

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

/** Mirrors the Java QWP sender's raw column-buffer byte accounting. */
function stagedColumnBytes(column: StagedColumn): number {
  switch (column.type) {
    case QWP_COLUMN_TYPE.BOOLEAN:
    case QWP_COLUMN_TYPE.BYTE:
      return 1;
    case QWP_COLUMN_TYPE.SHORT:
    case QWP_COLUMN_TYPE.CHAR:
      return 2;
    case QWP_COLUMN_TYPE.INT:
    case QWP_COLUMN_TYPE.FLOAT:
    case QWP_COLUMN_TYPE.IPV4:
    case QWP_COLUMN_TYPE.SYMBOL:
      return 4;
    case QWP_COLUMN_TYPE.LONG:
    case QWP_COLUMN_TYPE.DOUBLE:
    case QWP_COLUMN_TYPE.TIMESTAMP:
    case QWP_COLUMN_TYPE.TIMESTAMP_NANOS:
    case QWP_COLUMN_TYPE.DATE:
    case QWP_COLUMN_TYPE.DECIMAL64:
    case QWP_COLUMN_TYPE.GEOHASH:
      return 8;
    case QWP_COLUMN_TYPE.UUID:
    case QWP_COLUMN_TYPE.DECIMAL128:
      return 16;
    case QWP_COLUMN_TYPE.LONG256:
    case QWP_COLUMN_TYPE.DECIMAL256:
      return 32;
    case QWP_COLUMN_TYPE.VARCHAR:
      return 4 + utf8Length(column.value as string);
    case QWP_COLUMN_TYPE.BINARY:
      return 4 + (column.value as Uint8Array).byteLength;
    case QWP_COLUMN_TYPE.DOUBLE_ARRAY:
    case QWP_COLUMN_TYPE.LONG_ARRAY: {
      const array = column.value as QwpArrayValue;
      return array.values.length * 8;
    }
  }
}

function stagedRowBytes(columns: ReadonlyMap<string, StagedColumn>): number {
  let bytes = 0;
  for (const column of columns.values()) bytes += stagedColumnBytes(column);
  return bytes;
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
  private pendingByteCount = 0;
  private lastFlushTime = Date.now();
  private sessionPromise?: Promise<QwpSenderSession>;
  private activeSession?: QwpSenderSession;
  private flushTail: Promise<void> = Promise.resolve();
  private closePromise?: Promise<void>;
  private closing = false;
  private closed = false;
  private hasDeferredMessages = false;
  private deferredRowCount = 0;
  private readonly deferredAcks: Promise<QwpIngressResponse>[] = [];
  private totalRowsStaged = 0;
  private totalRowsPublished = 0;
  private totalFlushes = 0;
  private totalFlushFailures = 0;
  private totalTransactionsCommitted = 0;
  private lastCommitBoundarySequence = -1n;

  private readonly autoFlush: boolean;
  private readonly autoFlushRows: number;
  private readonly autoFlushBytes: number;
  private readonly autoFlushIntervalMs: number;
  private readonly transactional: boolean;
  private readonly awaitServerAck: boolean;
  private readonly closeFlushTimeoutMs: number;
  private readonly maxNameLength: number;
  private readonly log: QwpSenderLogger;

  constructor(
    private readonly sessionFactory: QwpSenderSessionFactory,
    private readonly options: QwpSenderOptions = {},
  ) {
    this.autoFlush = options.autoFlush ?? true;
    this.autoFlushRows = options.autoFlushRows ?? DEFAULT_AUTO_FLUSH_ROWS;
    this.autoFlushBytes = options.autoFlushBytes ?? DEFAULT_AUTO_FLUSH_BYTES;
    this.autoFlushIntervalMs =
      options.autoFlushIntervalMs ?? DEFAULT_AUTO_FLUSH_INTERVAL_MS;
    this.transactional = options.transactional ?? false;
    this.awaitServerAck =
      options.awaitServerAck ?? options.awaitDurableAck === true;
    this.closeFlushTimeoutMs =
      options.closeFlushTimeoutMs ?? DEFAULT_CLOSE_FLUSH_TIMEOUT_MS;
    this.maxNameLength = options.maxNameLength ?? DEFAULT_MAX_NAME_LENGTH;
    validateNonNegativeInteger(this.autoFlushRows, "autoFlushRows");
    validateNonNegativeInteger(this.autoFlushBytes, "autoFlushBytes");
    validateNonNegativeInteger(this.autoFlushIntervalMs, "autoFlushIntervalMs");
    validateNonNegativeInteger(this.closeFlushTimeoutMs, "closeFlushTimeoutMs");
    if (!Number.isSafeInteger(this.maxNameLength) || this.maxNameLength < 16) {
      throw new RangeError(
        "maxNameLength must be a safe integer of at least 16",
      );
    }
    if (
      options.durableAckTimeoutMs !== undefined &&
      (!Number.isFinite(options.durableAckTimeoutMs) ||
        options.durableAckTimeoutMs <= 0)
    ) {
      throw new RangeError("durableAckTimeoutMs must be a positive number");
    }
    if (!this.awaitServerAck && options.awaitDurableAck) {
      throw new RangeError(
        "awaitDurableAck requires awaitServerAck to be enabled",
      );
    }
    this.log = options.log ?? (() => undefined);
  }

  async connect(): Promise<boolean> {
    this.throwIfUnavailable();
    await this.getSession();
    return true;
  }

  get metrics(): QwpSenderMetrics {
    return Object.freeze({
      totalRowsStaged: this.totalRowsStaged,
      totalRowsPublished: this.totalRowsPublished,
      totalFlushes: this.totalFlushes,
      totalFlushFailures: this.totalFlushFailures,
      totalTransactionsCommitted: this.totalTransactionsCommitted,
      pendingRows: this.pendingRowCount,
      pendingBytes: this.pendingByteCount,
      autoFlushBytes: this.autoFlushBytes,
      effectiveAutoFlushBytes: this.effectiveAutoFlushByteThreshold(),
      deferredRows: this.deferredRowCount,
      connected:
        this.activeSession !== undefined && !this.closing && !this.closed,
      closing: this.closing,
      closed: this.closed,
      ingress: this.activeSession?.metrics,
    });
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
    new QwpTableBuffer(name, this.maxNameLength);
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
      this.addColumn("", timestamp.type, timestamp.value, {}, true);
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

  /**
   * Publishes completed rows to the local ingress/replay boundary. This does
   * not wait for a server ACK unless awaitServerAck or awaitDurableAck is set.
   */
  flush(): Promise<boolean> {
    return this.enqueueFlush(false);
  }

  /**
   * Publishes pending rows without waiting for their server ACK and returns
   * the highest frame sequence produced by this call, or -1n when empty.
   * Pass the result to waitForAcknowledged() when an explicit delivery
   * barrier is needed.
   */
  flushAndGetSequence(): Promise<bigint> {
    return this.enqueueSequenceFlush(false);
  }

  /** Highest cumulative ACK watermark, or -1n before acknowledgement. */
  get acknowledgedSequence(): bigint {
    return this.activeSession
      ? sessionAcknowledgedSequence(this.activeSession)
      : -1n;
  }

  /** Highest stable frame sequence published by this sender. */
  get publishedSequence(): bigint {
    return this.activeSession
      ? sessionPublishedSequence(this.activeSession)
      : -1n;
  }

  /** Independently waits until the cumulative ACK watermark covers a frame. */
  async waitForAcknowledged(
    targetSequence: bigint,
    timeoutMs?: number,
  ): Promise<void> {
    this.throwIfUnavailable();
    if (typeof targetSequence !== "bigint") {
      throw new TypeError("QWP ACK target sequence must be a bigint");
    }
    if (
      timeoutMs !== undefined &&
      (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    ) {
      throw new RangeError(
        "QWP ACK watermark timeout must be positive and finite",
      );
    }
    const session =
      targetSequence < 0n && !this.activeSession
        ? undefined
        : await this.getSession();
    if (!session) return;
    if (!session.waitForAcknowledged) {
      throw new Error(
        "this QWP ingress session does not expose an ACK watermark",
      );
    }
    await session.waitForAcknowledged(targetSequence, timeoutMs);
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
    return this.enqueueFlushResult(deferCommit, false).then(
      (result) => result.flushed,
    );
  }

  private enqueueSequenceFlush(deferCommit: boolean): Promise<bigint> {
    return this.enqueueFlushResult(deferCommit, true).then(
      (result) => result.sequence,
    );
  }

  private enqueueFlushResult(
    deferCommit: boolean,
    publicationOnly: boolean,
  ): Promise<QwpSenderFlushResult> {
    this.throwIfUnavailable();
    const flushing = this.flushTail.then(() =>
      this.flushNow(deferCommit, publicationOnly),
    );
    void flushing.catch(() => {
      this.totalFlushFailures++;
    });
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

  /**
   * Flushes completed rows and resets borrower-local staging without closing
   * the physical session. Used by the pooled QWP client when a lease returns.
   *
   * @internal
   */
  async prepareForPoolRelease(): Promise<void> {
    this.throwIfUnavailable();
    await this.flush();
    if (this.currentRow.size > 0) {
      this.log(
        "warn",
        `QWP pooled sender is releasing an unfinished row with ${this.currentRow.size} column(s); the row will be discarded`,
      );
    }
    this.reset();
  }

  private async closeNow(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    const deadline =
      this.closeFlushTimeoutMs > 0
        ? Date.now() + this.closeFlushTimeoutMs
        : undefined;
    let terminalError: unknown;

    try {
      // Serialize behind public flushes so symbol dictionaries, transaction
      // boundaries, and staging ownership cannot race. close() itself uses a
      // publication-only flush and applies one bounded ACK watermark wait.
      const closeFlush = this.flushTail.then(async () => {
        if (
          this.pendingRowCount === 0 &&
          (this.transactional || !this.hasDeferredMessages)
        ) {
          return;
        }
        try {
          await this.flushNow(this.transactional, true);
        } catch (error) {
          this.totalFlushFailures++;
          throw error;
        }
      });
      await this.withCloseDeadline(closeFlush, deadline);

      const session = this.activeSession;
      const target = this.lastCommitBoundarySequence;
      if (
        deadline !== undefined &&
        session &&
        target >= 0n &&
        sessionAcknowledgedSequence(session) < target
      ) {
        if (!session.waitForAcknowledged) {
          throw new Error(
            "this QWP ingress session does not expose an ACK watermark",
          );
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw this.closeTimeoutError();
        try {
          await this.withCloseDeadline(
            session.waitForAcknowledged(target, remaining),
            deadline,
          );
        } catch (error) {
          if (error instanceof QwpIngressAckTimeoutError) {
            throw this.closeTimeoutError();
          }
          throw error;
        }
      }
    } catch (error) {
      terminalError = error;
    }

    let closeError: unknown;
    const session = this.activeSession;
    if (session) {
      try {
        await session.close();
      } catch (error) {
        closeError = error;
      }
    } else if (this.sessionPromise) {
      // A close deadline can expire while the connection factory is still in
      // flight. Attach cleanup so a late connection cannot leak its socket.
      void this.sessionPromise
        .then((connected) => connected.close())
        .catch(() => undefined);
    }

    if (this.pendingRowCount > 0 || this.currentRow.size > 0) {
      this.log(
        "warn",
        `QWP sender contains ${this.pendingRowCount} completed row(s) and ${this.currentRow.size} unfinished column(s) which will be lost`,
      );
    }
    if (this.hasDeferredMessages) {
      this.log(
        "warn",
        `QWP sender is closing with ${this.deferredRowCount} deferred row(s) awaiting commit; QuestDB will roll the open transaction back`,
      );
    }
    this.closed = true;
    if (terminalError !== undefined) {
      if (closeError !== undefined) {
        this.log(
          "error",
          closeError instanceof Error ? closeError : String(closeError),
        );
      }
      throw terminalError;
    }
    if (closeError !== undefined) throw closeError;
  }

  private closeTimeoutError(): QwpSenderCloseTimeoutError {
    const session = this.activeSession;
    return new QwpSenderCloseTimeoutError(
      this.closeFlushTimeoutMs,
      this.lastCommitBoundarySequence,
      session ? sessionAcknowledgedSequence(session) : -1n,
    );
  }

  private async withCloseDeadline<T>(
    operation: Promise<T>,
    deadline: number | undefined,
  ): Promise<T> {
    if (deadline === undefined) return operation;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw this.closeTimeoutError();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(this.closeTimeoutError()), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
    designatedTimestamp = false,
  ): QwpSender {
    try {
      this.throwIfUnavailable();
      const table = this.requireTable();
      if (typeof name !== "string") {
        throw new TypeError("column name must be a string");
      }
      if (!designatedTimestamp) {
        validateQwpColumnName(name, this.maxNameLength);
      }
      const nameKey = qwpColumnNameKey(name);
      const existingSchema = table.schema.get(nameKey);
      if (
        existingSchema &&
        (existingSchema.type !== type ||
          existingSchema.geohashPrecision !== metadata.geohashPrecision ||
          existingSchema.decimalScale !== metadata.decimalScale)
      ) {
        throw new Error(`column type mismatch for '${name}'`);
      }
      if (this.currentRow.has(nameKey)) return this;
      const canonicalName = existingSchema?.name ?? name;
      table.schema.set(nameKey, { name: canonicalName, type, ...metadata });
      this.currentRow.set(nameKey, {
        name: canonicalName,
        type,
        value,
        ...metadata,
      });
      return this;
    } catch (error) {
      return this.failRow(error);
    }
  }

  private finishRow(): void {
    const table = this.requireTable();
    const estimatedBytes = stagedRowBytes(this.currentRow);
    table.rows.push({ columns: this.currentRow, estimatedBytes });
    this.currentRow = new Map();
    this.current = undefined;
    this.pendingRowCount++;
    this.pendingByteCount += estimatedBytes;
    this.totalRowsStaged++;
    this.log(
      "debug",
      `Pending QWP rows: ${this.pendingRowCount}, estimated bytes: ${this.pendingByteCount}`,
    );
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
    const byteThreshold = this.effectiveAutoFlushByteThreshold();
    if (
      this.autoFlush &&
      this.pendingRowCount > 0 &&
      ((this.autoFlushRows > 0 && this.pendingRowCount >= this.autoFlushRows) ||
        (byteThreshold > 0 && this.pendingByteCount >= byteThreshold) ||
        (this.autoFlushIntervalMs > 0 &&
          Date.now() - this.lastFlushTime >= this.autoFlushIntervalMs))
    ) {
      await this.enqueueFlush(this.transactional);
    }
  }

  private async flushNow(
    deferCommit: boolean,
    publicationOnly: boolean,
  ): Promise<QwpSenderFlushResult> {
    if (
      this.pendingRowCount === 0 &&
      (deferCommit || !this.hasDeferredMessages)
    ) {
      if (this.activeSession?.waitForAcknowledged) {
        await this.activeSession.waitForAcknowledged(-1n);
      }
      return { flushed: false, sequence: -1n };
    }
    const session = await this.getSession();
    const snapshots = this.tables
      .filter((table) => table.rows.length > 0)
      .map((table) => ({ table, rows: table.rows.slice() }));
    if (snapshots.length === 0 && !this.hasDeferredMessages) {
      return { flushed: false, sequence: -1n };
    }

    const wireTables = snapshots.map(({ table, rows }) =>
      this.buildTable(table.name, rows),
    );
    const closesDeferredTransaction = this.hasDeferredMessages;
    // sendTables encodes synchronously. Do not compact staging if encoding
    // throws, but transfer ownership once the frame has entered the session.
    const encode = this.options.encode;
    const useDelta =
      (encode?.symbolDictionary ?? "delta") === "delta" &&
      session.sendTablesDelta;
    const beforeSequence = sessionPublishedSequence(session);
    let response: Promise<QwpIngressResponse> | undefined;
    let publication: Promise<void> | undefined;
    let publishedSequence = -1n;
    const waitForServerAck = this.awaitServerAck && !publicationOnly;
    if (waitForServerAck) {
      const trackedSender = useDelta
        ? session.sendTablesDeltaWithPublication
        : session.sendTablesWithPublication;
      if (trackedSender) {
        const sending = trackedSender.call(session, wireTables, {
          gorilla: encode?.gorilla,
          deferCommit,
        });
        response = sending.acknowledgement;
        // Observe ACK rejection while the local-publication boundary is being
        // awaited; it is consumed normally below after ownership transfers.
        void response.catch(() => undefined);
        publication = sending.publication.then(() => {
          publishedSequence = sending.sequence;
        });
      } else {
        response = useDelta
          ? session.sendTablesDelta!(wireTables, {
              gorilla: encode?.gorilla,
              deferCommit,
            })
          : session.sendTables(wireTables, {
              gorilla: encode?.gorilla,
              deferCommit,
            });
      }
    } else {
      const publisher = useDelta
        ? session.publishTablesDelta
        : session.publishTables;
      if (!publisher) {
        throw new Error(
          "this QWP ingress session does not support publication-only flushes",
        );
      }
      publication = publisher
        .call(session, wireTables, {
          gorilla: encode?.gorilla,
          deferCommit,
        })
        .then(() => {
          publishedSequence = advancedSequence(
            beforeSequence,
            sessionPublishedSequence(session),
          );
        });
    }
    publishedSequence = advancedSequence(
      beforeSequence,
      sessionPublishedSequence(session),
    );
    this.totalFlushes++;
    // Transfer row ownership only after every logical frame is accepted by
    // the transport. For Node store-and-forward this is the durable journal
    // boundary, independently of whether this flush also waits for an ACK.
    if (publication) await publication;
    for (const { table, rows } of snapshots) table.rows.splice(0, rows.length);
    const sentRows = snapshots.reduce(
      (count, item) => count + item.rows.length,
      0,
    );
    const sentBytes = snapshots.reduce(
      (total, item) =>
        total +
        item.rows.reduce((tableTotal, row) => {
          return tableTotal + row.estimatedBytes;
        }, 0),
      0,
    );
    this.pendingRowCount -= sentRows;
    this.pendingByteCount -= sentBytes;
    this.totalRowsPublished += sentRows;
    this.lastFlushTime = Date.now();
    this.log(
      "debug",
      `${deferCommit ? "Auto-flushing" : "Flushing"} ${sentRows} QWP row(s)${deferCommit ? " with commit deferred" : ""}`,
    );
    if (!deferCommit && publishedSequence >= 0n) {
      this.lastCommitBoundarySequence = publishedSequence;
    }

    if (deferCommit) {
      this.hasDeferredMessages = true;
      this.deferredRowCount += sentRows;
      if (response) {
        this.deferredAcks.push(response);
        // The server intentionally withholds this ACK until a later commit.
        // Observe rejection now so abandoning an open transaction during close
        // never creates an unhandled rejection; an ACK-waiting flush/commit
        // still awaits it.
        void response.catch(() => undefined);
      }
      return { flushed: true, sequence: publishedSequence };
    }

    const deferredAcks = this.deferredAcks.splice(0);
    this.hasDeferredMessages = false;
    this.deferredRowCount = 0;
    const ack = response ? await response : undefined;
    if (response) {
      const observedSequence = advancedSequence(
        beforeSequence,
        sessionPublishedSequence(session),
      );
      publishedSequence =
        observedSequence >= 0n
          ? observedSequence
          : typeof ack?.sequence === "bigint"
            ? ack.sequence
            : -1n;
    }
    if (publishedSequence >= 0n) {
      this.lastCommitBoundarySequence = publishedSequence;
    }
    if (!publicationOnly && deferredAcks.length > 0) {
      await Promise.all(deferredAcks);
    }
    if (this.transactional && (closesDeferredTransaction || sentRows > 0)) {
      this.totalTransactionsCommitted++;
    }
    if (this.options.awaitDurableAck && ack) {
      await session.waitForDurable(ack, this.options.durableAckTimeoutMs);
    }
    return { flushed: true, sequence: publishedSequence };
  }

  private buildTable(name: string, rows: readonly StagedRow[]): QwpTableBuffer {
    const result = new QwpTableBuffer(name, this.maxNameLength);
    for (const row of rows) {
      for (const column of row.columns.values()) {
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
      const connecting = this.sessionFactory();
      const tracked = connecting
        .then((session) => {
          this.activeSession = session;
          return session;
        })
        .catch((error: unknown) => {
          if (this.sessionPromise === tracked) this.sessionPromise = undefined;
          throw error;
        });
      this.sessionPromise = tracked;
    }
    return this.sessionPromise;
  }

  private resetAutoFlush(): void {
    this.pendingRowCount = 0;
    this.pendingByteCount = 0;
    this.lastFlushTime = Date.now();
  }

  private effectiveAutoFlushByteThreshold(): number {
    if (this.autoFlushBytes === 0) return 0;
    const cap = this.activeSession?.maxBatchSizeBytes;
    if (cap === undefined || !Number.isSafeInteger(cap) || cap <= 0) {
      return this.autoFlushBytes;
    }
    const safeServerBudget = Math.max(1, Math.floor((cap * 9) / 10));
    return Math.min(this.autoFlushBytes, safeServerBudget);
  }

  private throwIfClosed(): void {
    if (this.closed) throw new Error("QWP sender is closed");
  }

  private throwIfUnavailable(): void {
    this.throwIfClosed();
    if (this.closing) throw new Error("QWP sender is closing");
  }
}

function sessionPublishedSequence(session: QwpSenderSession): bigint {
  return (
    session.publishedFrameSequence ??
    session.metrics?.replayPublishedFrameSequence ??
    session.metrics?.publishedSequence ??
    -1n
  );
}

function sessionAcknowledgedSequence(session: QwpSenderSession): bigint {
  return (
    session.acknowledgedFrameSequence ??
    session.metrics?.replayAcknowledgedFrameSequence ??
    session.metrics?.acknowledgedSequence ??
    -1n
  );
}

function advancedSequence(before: bigint, after: bigint): bigint {
  return after > before ? after : -1n;
}
