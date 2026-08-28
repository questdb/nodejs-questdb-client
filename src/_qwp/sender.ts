import {
  QWP_COLUMN_TYPE,
  QWP_MAX_ARRAY_DIMENSION_LENGTH,
  QWP_MAX_ARRAY_DIMENSIONS,
  QwpColumnType,
  QwpIngressEncodeOptions,
  QwpIngressResponse,
  QwpTableBuffer,
  flattenQwpArray,
  utf8Length,
  type QwpArrayValue,
} from "./_core";
import {
  QwpBatchTooLargeError,
  QwpIngressAckTimeoutError,
  type QwpIngressSendResult,
  type QwpIngressMetrics,
} from "./ingress-session";
import { qwpColumnNameKey, validateQwpColumnName } from "./_core/identifiers";
import {
  isQwpWriterColumn,
  QwpWriterRowError,
  validateDecimalScale,
  validateGeohashPrecision,
  type QwpTimestampUnit,
  type QwpWriterColumn,
  type QwpWriterRow,
  type QwpWriterSchema,
} from "./writer";

export type { QwpTimestampUnit } from "./writer";

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
  /** Maximum UTF-8 byte length of table and column names. Defaults to 127. */
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
   * server ACK watermark. Zero or a negative value skips the drain. Defaults
   * to 5 seconds.
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

/**
 * Opens the sender's session. The signal is aborted by close(), so a connect
 * still negotiating can be torn down instead of outliving the sender by up to
 * its connect/auth deadline. Factories that ignore the parameter remain
 * assignable, matching QwpConnectionFactory.
 */
export type QwpSenderSessionFactory = (
  signal?: AbortSignal,
) => Promise<QwpSenderSession>;

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

interface CompiledQwpWriterColumn {
  readonly inputName: string;
  readonly wireName: string;
  readonly nameKey: string;
  readonly type: QwpColumnType;
  readonly descriptor: QwpWriterColumn<unknown, boolean>;
  /** Fixed GEOHASH precision, mirrored onto every staged column. */
  readonly geohashPrecision?: number;
  /** Fixed DECIMAL scale, mirrored onto every staged column. */
  readonly decimalScale?: number;
}

interface CompiledQwpWriterSchema {
  readonly tableName: string;
  readonly columns: readonly CompiledQwpWriterColumn[];
  readonly inputNames: ReadonlySet<string>;
}

interface QwpSenderFlushResult {
  readonly flushed: boolean;
  readonly sequence: bigint;
}

const DEFAULT_AUTO_FLUSH_ROWS = 1_000;
const DEFAULT_AUTO_FLUSH_BYTES = 0;
const DEFAULT_AUTO_FLUSH_INTERVAL_MS = 100;
// Matches the Java client's close_flush_timeout default so close() costs the
// same everywhere.
const DEFAULT_CLOSE_FLUSH_TIMEOUT_MS = 5_000;
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

function validateTimestampUnit(unit: QwpTimestampUnit): void {
  if (unit !== "ns" && unit !== "us" && unit !== "ms") {
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

const DECIMAL_WIDTH = new Map<QwpColumnType, number>([
  [QWP_COLUMN_TYPE.DECIMAL64, 64],
  [QWP_COLUMN_TYPE.DECIMAL128, 128],
  [QWP_COLUMN_TYPE.DECIMAL256, 256],
]);

function isDecimalType(type: QwpColumnType): boolean {
  return DECIMAL_WIDTH.has(type);
}

/**
 * Rescales a decimal onto the scale its column locked on its first value,
 * matching the Java client's QwpTableBuffer.ColumnBuffer.addDecimal* path. A
 * QWP column carries one scale for the whole frame, so the alternative to
 * rescaling is rejecting the row; both clients rescale where it is exact and
 * report the two cases where it is not.
 */
function rescaleToColumnScale(
  name: string,
  value: bigint,
  fromScale: number,
  toScale: number,
  type: QwpColumnType,
): bigint {
  let rescaled: bigint;
  try {
    rescaled = rescaleDecimal(value, fromScale, toScale);
  } catch {
    throw new RangeError(
      `column '${name}' cannot rescale decimal from scale ${fromScale} to ${toScale} without precision loss`,
    );
  }
  const bits = DECIMAL_WIDTH.get(type);
  if (bits !== undefined && !fitsSigned(rescaled, bits)) {
    throw new RangeError(
      `Decimal${bits} overflow: rescaling from scale ${fromScale} to ${toScale} exceeds ${bits}-bit capacity`,
    );
  }
  return rescaled;
}

function parseDecimal(value: string | number): {
  unscaled: bigint;
  scale: number;
} {
  const text = String(value);
  const match =
    typeof value === "number"
      ? /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text)
      : /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new TypeError(`invalid decimal value '${text}'`);
  const fraction = match[3] ?? "";
  const exponent = match[4] === undefined ? 0 : Number(match[4]);
  let digits = `${match[2]}${fraction}`;
  let scale = fraction.length - exponent;
  if (scale < 0) {
    digits += "0".repeat(-scale);
    scale = 0;
  }
  const magnitude = BigInt(digits);
  return {
    unscaled: match[1] === "-" ? -magnitude : magnitude,
    scale,
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
    // The 16 bytes are canonical (RFC 4122) big-endian order, the form
    // uuid.parse() and java.util.UUID produce: bytes 0-7 are the high limb,
    // bytes 8-15 the low limb. QWP carries the two limbs little-endian, low
    // first, so read each limb big-endian and re-emit it through the same
    // path the text and {low, high} forms use.
    const source = new DataView(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    );
    return uuidLimbBytes(
      source.getBigUint64(8, false),
      source.getBigUint64(0, false),
    );
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
    if (!Number.isInteger(value) || value < -0x80000000 || value > 0xffffffff) {
      throw new RangeError(
        "IPv4 value must be a signed int32 or unsigned uint32",
      );
    }
    if (value === 0) {
      throw new RangeError("0.0.0.0 is QuestDB's IPv4 NULL sentinel");
    }
    // Java and QuestDB expose packed IPv4 values as signed int32s, while
    // JavaScript callers often use uint32s. Both forms carry the same bits.
    return value >>> 0;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fitsUnsigned(value: bigint, bits: number): boolean {
  return BigInt.asUintN(bits, value) === value;
}

/** Accepts either signed or unsigned 64-bit limbs, as the egress views emit. */
function checkedLimb64(value: unknown, name: string): bigint {
  if (typeof value !== "bigint")
    throw new TypeError(`${name} must be a bigint`);
  if (!fitsSigned(value, 64) && !fitsUnsigned(value, 64)) {
    throw new RangeError(`${name} does not fit in 64 bits`);
  }
  return BigInt.asUintN(64, value);
}

function uuidLimbBytes(low: bigint, high: bigint): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, low, true);
  view.setBigUint64(8, high, true);
  return bytes;
}

function writerUuidBytes(value: unknown): Uint8Array {
  if (typeof value === "string" || value instanceof Uint8Array) {
    return uuidBytes(value);
  }
  if (isRecord(value) && "low" in value && "high" in value) {
    return uuidLimbBytes(
      checkedLimb64(value.low, "UUID low limb"),
      checkedLimb64(value.high, "UUID high limb"),
    );
  }
  throw new TypeError(
    "uuid accepts canonical UUID text, 16 bytes, or {low, high} limbs",
  );
}

function long256WordBytes(words: readonly unknown[]): Uint8Array {
  if (words.length !== 4) {
    throw new TypeError("long256 accepts exactly four 64-bit words");
  }
  return littleEndianWords(
    words.map((word, index) =>
      BigInt.asIntN(64, checkedLimb64(word, `LONG256 word ${index}`)),
    ),
  );
}

function long256MagnitudeBytes(value: bigint): Uint8Array {
  if (!fitsUnsigned(value, 256)) {
    throw new RangeError("long256 value must be an unsigned 256-bit integer");
  }
  const words: bigint[] = [];
  for (let index = 0; index < 4; index++) {
    words.push(
      BigInt.asIntN(64, (value >> BigInt(index * 64)) & 0xffffffffffffffffn),
    );
  }
  return littleEndianWords(words);
}

function writerLong256Bytes(value: unknown): Uint8Array {
  if (typeof value === "bigint") return long256MagnitudeBytes(value);
  if (typeof value === "string") {
    if (!/^0x[0-9a-f]{1,64}$/i.test(value)) {
      throw new TypeError(
        "long256 text must be a 0x-prefixed hex value of up to 64 digits",
      );
    }
    return long256MagnitudeBytes(BigInt(value));
  }
  if (Array.isArray(value)) return long256WordBytes(value);
  if (isRecord(value) && Array.isArray(value.words)) {
    return long256WordBytes(value.words);
  }
  throw new TypeError(
    "long256 accepts a bigint, 0x hex text, four words, or {words}",
  );
}

/** QuestDB's base-32 geohash alphabet; five bits per character. */
const GEOHASH_ALPHABET = "0123456789bcdefghjkmnpqrstuvwxyz";

function geohashTextBits(text: string, precisionBits: number): bigint {
  if (text.length * 5 !== precisionBits) {
    throw new RangeError(
      `geohash text of ${text.length} character(s) carries ${text.length * 5} bits, but the column is ${precisionBits} bits`,
    );
  }
  let bits = 0n;
  for (const character of text.toLowerCase()) {
    const index = GEOHASH_ALPHABET.indexOf(character);
    if (index < 0) {
      throw new TypeError(`invalid geohash character '${character}'`);
    }
    bits = (bits << 5n) | BigInt(index);
  }
  return bits;
}

function writerGeohashBits(value: unknown, precisionBits: number): bigint {
  let bits: bigint;
  if (typeof value === "string") {
    bits = geohashTextBits(value, precisionBits);
  } else if (typeof value === "bigint" || typeof value === "number") {
    bits = checkedBigInt(value, "geohash value");
  } else if (isRecord(value) && "bits" in value) {
    if (
      value.precisionBits !== undefined &&
      value.precisionBits !== precisionBits
    ) {
      throw new RangeError(
        `geohash precision mismatch [column=${precisionBits}, received=${String(value.precisionBits)}]`,
      );
    }
    bits = checkedBigInt(value.bits as number | bigint, "geohash value");
  } else {
    throw new TypeError(
      "geohash accepts raw bits, base-32 text, or {bits, precisionBits}",
    );
  }
  if (bits < 0n || bits >= 1n << BigInt(precisionBits)) {
    throw new RangeError("geohash value does not fit the column precision");
  }
  return bits;
}

function rescaleDecimal(
  unscaled: bigint,
  fromScale: number,
  toScale: number,
): bigint {
  if (fromScale === toScale) return unscaled;
  if (fromScale < toScale) {
    return unscaled * 10n ** BigInt(toScale - fromScale);
  }
  const divisor = 10n ** BigInt(fromScale - toScale);
  if (unscaled % divisor !== 0n) {
    throw new RangeError(
      `decimal value is not exactly representable at scale ${toScale}`,
    );
  }
  return unscaled / divisor;
}

function writerDecimalUnscaled(
  value: unknown,
  scale: number,
  bits: number,
): bigint {
  let unscaled: bigint;
  if (typeof value === "bigint") {
    unscaled = value;
  } else if (typeof value === "string" || typeof value === "number") {
    const parsed = parseDecimal(value);
    unscaled = rescaleDecimal(parsed.unscaled, parsed.scale, scale);
  } else if (isRecord(value) && "unscaled" in value) {
    if (typeof value.unscaled !== "bigint") {
      throw new TypeError("decimal unscaled value must be a bigint");
    }
    if (!Number.isSafeInteger(value.scale) || (value.scale as number) < 0) {
      throw new TypeError("decimal scale must be a non-negative safe integer");
    }
    unscaled = rescaleDecimal(value.unscaled, value.scale as number, scale);
  } else {
    throw new TypeError(
      "decimal accepts a bigint, decimal text, a number, or {unscaled, scale}",
    );
  }
  if (!fitsSigned(unscaled, bits)) {
    throw new RangeError(`decimal value exceeds signed int${bits}`);
  }
  return unscaled;
}

function writerArrayValue(value: unknown, elements: "double" | "long") {
  let array: QwpArrayValue;
  if (Array.isArray(value)) {
    array = flattenQwpArray(value);
  } else if (
    isRecord(value) &&
    Array.isArray(value.dimensions) &&
    Array.isArray(value.values)
  ) {
    const dimensions = value.dimensions.map((dimension, index) =>
      checkedRange(
        dimension as number,
        0,
        QWP_MAX_ARRAY_DIMENSION_LENGTH,
        `array dimension ${index}`,
      ),
    );
    if (
      dimensions.length === 0 ||
      dimensions.length > QWP_MAX_ARRAY_DIMENSIONS
    ) {
      throw new RangeError(
        `QWP array must have between 1 and ${QWP_MAX_ARRAY_DIMENSIONS} dimensions`,
      );
    }
    const expected = dimensions.reduce(
      (total, dimension) => total * dimension,
      1,
    );
    if (expected !== value.values.length) {
      throw new RangeError(
        `array shape ${dimensions.join("x")} needs ${expected} value(s), received ${value.values.length}`,
      );
    }
    array = { dimensions, values: [...value.values] as (number | bigint)[] };
  } else {
    throw new TypeError(
      `${elements}Array accepts nested arrays or {dimensions, values}`,
    );
  }
  if (elements === "long") {
    array.values = array.values.map((item) =>
      checkedInt64(item, "long array value"),
    );
  } else if (array.values.some((item) => typeof item !== "number")) {
    throw new TypeError("doubleArray accepts only number values");
  }
  return array;
}

function qwpWriterColumnType(
  descriptor: QwpWriterColumn<unknown, boolean>,
): QwpColumnType {
  switch (descriptor.kind) {
    case "symbol":
      return QWP_COLUMN_TYPE.SYMBOL;
    case "varchar":
      return QWP_COLUMN_TYPE.VARCHAR;
    case "bool":
      return QWP_COLUMN_TYPE.BOOLEAN;
    case "byte":
      return QWP_COLUMN_TYPE.BYTE;
    case "short":
      return QWP_COLUMN_TYPE.SHORT;
    case "int32":
      return QWP_COLUMN_TYPE.INT;
    case "int64":
      return QWP_COLUMN_TYPE.LONG;
    case "float32":
      return QWP_COLUMN_TYPE.FLOAT;
    case "float64":
      return QWP_COLUMN_TYPE.DOUBLE;
    case "timestamp":
      return descriptor.unit === "ns"
        ? QWP_COLUMN_TYPE.TIMESTAMP_NANOS
        : QWP_COLUMN_TYPE.TIMESTAMP;
    case "date":
      return QWP_COLUMN_TYPE.DATE;
    case "char":
      return QWP_COLUMN_TYPE.CHAR;
    case "binary":
      return QWP_COLUMN_TYPE.BINARY;
    case "uuid":
      return QWP_COLUMN_TYPE.UUID;
    case "long256":
      return QWP_COLUMN_TYPE.LONG256;
    case "ipv4":
      return QWP_COLUMN_TYPE.IPV4;
    case "geohash":
      return QWP_COLUMN_TYPE.GEOHASH;
    case "decimal64":
      return QWP_COLUMN_TYPE.DECIMAL64;
    case "decimal128":
      return QWP_COLUMN_TYPE.DECIMAL128;
    case "decimal256":
      return QWP_COLUMN_TYPE.DECIMAL256;
    case "doubleArray":
      return QWP_COLUMN_TYPE.DOUBLE_ARRAY;
    case "longArray":
      return QWP_COLUMN_TYPE.LONG_ARRAY;
  }
}

/** Lifts the descriptor's fixed geohash precision or decimal scale, if any. */
function qwpWriterColumnMetadata(
  descriptor: QwpWriterColumn<unknown, boolean>,
): Pick<StagedColumn, "geohashPrecision" | "decimalScale"> {
  switch (descriptor.kind) {
    case "geohash":
      return {
        geohashPrecision: validateGeohashPrecision(
          descriptor.precisionBits as number,
        ),
      };
    case "decimal64":
    case "decimal128":
    case "decimal256":
      return {
        decimalScale: validateDecimalScale(
          descriptor.scale as number,
          descriptor.kind,
        ),
      };
    default:
      return {};
  }
}

function encodeQwpWriterValue(
  column: CompiledQwpWriterColumn,
  value: unknown,
): unknown {
  switch (column.descriptor.kind) {
    case "symbol":
    case "varchar":
      if (typeof value !== "string") {
        throw new TypeError(`${column.descriptor.kind} accepts only strings`);
      }
      return value;
    case "bool":
      if (typeof value !== "boolean") {
        throw new TypeError("bool accepts only booleans");
      }
      return value;
    case "byte":
      if (typeof value !== "number") {
        throw new TypeError("byte accepts only numbers");
      }
      return checkedRange(value, -128, 127, "byte value");
    case "short":
      if (typeof value !== "number") {
        throw new TypeError("short accepts only numbers");
      }
      return checkedRange(value, -32_768, 32_767, "short value");
    case "int32":
      if (typeof value !== "number") {
        throw new TypeError("int32 accepts only numbers");
      }
      return checkedRange(value, -2_147_483_648, 2_147_483_647, "int32 value");
    case "int64":
      if (typeof value !== "bigint") {
        throw new TypeError("int64 accepts only bigint values");
      }
      return checkedInt64(value, "int64 value", true);
    case "float32":
    case "float64":
      if (typeof value !== "number") {
        throw new TypeError(`${column.descriptor.kind} accepts only numbers`);
      }
      return value;
    case "timestamp": {
      if (typeof value !== "number" && typeof value !== "bigint") {
        throw new TypeError("timestamp accepts only number or bigint values");
      }
      return timestampValue(value, column.descriptor.unit ?? "us").value;
    }
    case "date":
      if (typeof value !== "number" && typeof value !== "bigint") {
        throw new TypeError("date accepts only number or bigint values");
      }
      return checkedInt64(value, "date value");
    case "char":
      if (typeof value !== "string" || value.length !== 1) {
        throw new TypeError("char accepts one UTF-16 code unit");
      }
      return value;
    case "binary":
      if (!(value instanceof Uint8Array)) {
        throw new TypeError("binary accepts only Uint8Array values");
      }
      return new Uint8Array(value);
    case "uuid":
      return writerUuidBytes(value);
    case "long256":
      return writerLong256Bytes(value);
    case "ipv4":
      if (typeof value !== "string" && typeof value !== "number") {
        throw new TypeError("ipv4 accepts dotted-quad text or a packed number");
      }
      return parseIpv4(value);
    case "geohash":
      return writerGeohashBits(value, column.geohashPrecision as number);
    case "decimal64":
      return writerDecimalUnscaled(value, column.decimalScale as number, 64);
    case "decimal128":
      return writerDecimalUnscaled(value, column.decimalScale as number, 128);
    case "decimal256":
      return writerDecimalUnscaled(value, column.decimalScale as number, 256);
    case "doubleArray":
      return writerArrayValue(value, "double");
    case "longArray":
      return writerArrayValue(value, "long");
  }
}

const QWP_TABLE_WRITER_CONSTRUCTOR = Symbol("QWP table writer constructor");

/** A reusable table-bound writer compiled from a QWP schema. */
export class QwpTableWriter<Schema extends QwpWriterSchema> {
  /** @internal Construct table writers with QwpSender.writer(). */
  constructor(
    token: typeof QWP_TABLE_WRITER_CONSTRUCTOR,
    readonly tableName: string,
    private readonly appendRow: (
      row: unknown,
      rowIndex?: number,
    ) => Promise<void>,
  ) {
    if (token !== QWP_TABLE_WRITER_CONSTRUCTOR) {
      throw new TypeError("QWP table writers must be created by QwpSender");
    }
  }

  /** Validates and atomically appends one complete object row. */
  row(row: QwpWriterRow<Schema>): Promise<void> {
    return this.appendRow(row);
  }

  /** Appends a synchronous or asynchronous stream of complete object rows. */
  async rows(
    rows: Iterable<QwpWriterRow<Schema>> | AsyncIterable<QwpWriterRow<Schema>>,
  ): Promise<void> {
    const source = rows as
      | Partial<
          Iterable<QwpWriterRow<Schema>> & AsyncIterable<QwpWriterRow<Schema>>
        >
      | null
      | undefined;
    if (
      source === null ||
      source === undefined ||
      (typeof source[Symbol.iterator] !== "function" &&
        typeof source[Symbol.asyncIterator] !== "function")
    ) {
      throw new TypeError("QWP table writer rows must be iterable");
    }

    let rowIndex = 0;
    for await (const row of rows) {
      await this.appendRow(row, rowIndex++);
    }
  }
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
  // Schema keys the row in progress introduced. A row that is discarded must
  // not leave its column types behind: nothing was published, so nothing was
  // learned about the table.
  private currentRowSchemaKeys: string[] = [];
  private pendingRowCount = 0;
  private pendingByteCount = 0;
  /**
   * Bumped by reset(), so a flush that snapshotted the previous staging can
   * tell its rows are already gone rather than retiring them a second time.
   */
  private stagingGeneration = 0;
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

  private readonly connectAbort = new AbortController();

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
    if (!Number.isSafeInteger(this.closeFlushTimeoutMs)) {
      throw new RangeError("closeFlushTimeoutMs must be a safe integer");
    }
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
    this.currentRowSchemaKeys.length = 0;
    this.currentRow.clear();
    // A flush already in flight holds snapshots of the tables just dropped.
    // Retiring them against the counters this call zeroes would subtract the
    // same rows twice, so mark the staging they belong to as gone.
    this.stagingGeneration++;
    this.resetAutoFlush();
    return this;
  }

  /**
   * Compiles an immutable table schema into an atomic object-row writer.
   * The returned writer remains usable after this sender is reset.
   */
  writer<const Schema extends QwpWriterSchema>(
    tableName: string,
    schema: Schema,
  ): QwpTableWriter<Schema> {
    this.throwIfUnavailable();
    const compiled = this.compileWriterSchema(tableName, schema);
    return new QwpTableWriter(
      QWP_TABLE_WRITER_CONSTRUCTOR,
      tableName,
      (row, rowIndex) => this.appendCompiledWriterRow(compiled, row, rowIndex),
    );
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

  /**
   * Whether a nullish value omits this column -- and, when it does, that the
   * call was still a valid one.
   *
   * Omitting a column must not take the rest of the call's validation with it.
   * The sender's availability, the row state and the column name describe the
   * call site, not this row's value, so a call site that is wrong is wrong on
   * every row. Returning early on nullish meant a misspelled or over-long name
   * raised only on the rows that happened to carry a value, and stayed silent
   * on the rest -- which is how a typo reaches production. The ILP senders had
   * the same bug and fix it in validateColumnCall(); README.md documents the
   * nullish rule as shared by both, so these must agree.
   */
  private omitsNullish(
    name: string,
    value: unknown,
  ): value is null | undefined {
    if (value !== null && value !== undefined) return false;
    try {
      this.throwIfUnavailable();
      this.requireTable();
      if (typeof name !== "string") {
        throw new TypeError("column name must be a string");
      }
      validateQwpColumnName(name, this.maxNameLength);
    } catch (error) {
      this.failRow(error);
    }
    return true;
  }

  symbol(name: string, value: unknown): QwpSender {
    if (this.omitsNullish(name, value)) return this;
    // String() runs inside the guard, not in addColumn's argument list: the
    // value is `unknown`, so its conversion can throw (a null-prototype
    // object, a throwing or non-callable toString, a throwing Proxy trap).
    // Outside the guard that throw escapes before failRow() can discard the
    // row, leaving the sender inside a half-built row that the next
    // at()/atNow() would publish.
    try {
      return this.addColumn(name, QWP_COLUMN_TYPE.SYMBOL, String(value));
    } catch (error) {
      return this.failRow(error);
    }
  }

  stringColumn(name: string, value: string | null | undefined): QwpSender {
    if (this.omitsNullish(name, value)) return this;
    if (typeof value !== "string") {
      return this.failRow(new TypeError("stringColumn accepts only strings"));
    }
    return this.addColumn(name, QWP_COLUMN_TYPE.VARCHAR, value);
  }

  booleanColumn(name: string, value: boolean | null | undefined): QwpSender {
    if (this.omitsNullish(name, value)) return this;
    if (typeof value !== "boolean") {
      return this.failRow(new TypeError("booleanColumn accepts only booleans"));
    }
    return this.addColumn(name, QWP_COLUMN_TYPE.BOOLEAN, value);
  }

  floatColumn(name: string, value: number | null | undefined): QwpSender {
    if (this.omitsNullish(name, value)) return this;
    if (typeof value !== "number") {
      return this.failRow(new TypeError("floatColumn accepts only numbers"));
    }
    return this.addColumn(name, QWP_COLUMN_TYPE.DOUBLE, value);
  }

  doubleColumn(name: string, value: number | null | undefined): QwpSender {
    return this.floatColumn(name, value);
  }

  float32Column(name: string, value: number | null | undefined): QwpSender {
    if (this.omitsNullish(name, value)) return this;
    if (typeof value !== "number") {
      return this.failRow(new TypeError("float32Column accepts only numbers"));
    }
    return this.addColumn(name, QWP_COLUMN_TYPE.FLOAT, value);
  }

  byteColumn(name: string, value: number | null | undefined): QwpSender {
    if (this.omitsNullish(name, value)) return this;
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
    if (this.omitsNullish(name, value)) return this;
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

  /**
   * Adds a QuestDB INT column value. `-2_147_483_648` is QuestDB's INT NULL
   * sentinel: it is stored as NULL and cannot be stored as an ordinary value.
   */
  int32Column(name: string, value: number | null | undefined): QwpSender {
    if (this.omitsNullish(name, value)) return this;
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
    if (this.omitsNullish(name, value)) return this;
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

  /**
   * Adds a QuestDB LONG column value. `-9_223_372_036_854_775_808n` is
   * QuestDB's LONG NULL sentinel: it is stored as NULL and cannot be stored as
   * an ordinary value.
   */
  longColumn(
    name: string,
    value: number | bigint | null | undefined,
  ): QwpSender {
    if (this.omitsNullish(name, value)) return this;
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

  /** Adds a QuestDB DOUBLE[] value with between 1 and 32 dimensions. */
  arrayColumn(name: string, value: unknown[] | null | undefined): QwpSender {
    if (this.omitsNullish(name, value)) return this;
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

  /**
   * Adds a protocol LONG[] column value with between 1 and 32 dimensions.
   *
   * Current QuestDB servers reject LONG-array ingestion with `long arrays are
   * not supported, only double arrays`. This method remains available for
   * Java-client and protocol parity.
   */
  longArrayColumn(
    name: string,
    value: unknown[] | null | undefined,
  ): QwpSender {
    if (this.omitsNullish(name, value)) return this;
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
    const omitted = this.omitsNullish(name, value);
    try {
      validateTimestampUnit(unit);
      if (omitted) return this;
      const timestamp = timestampValue(value, unit);
      return this.addColumn(name, timestamp.type, timestamp.value);
    } catch (error) {
      return this.failRow(error);
    }
  }

  /**
   * Adds a QuestDB DATE column value in milliseconds since the epoch.
   * `-9_223_372_036_854_775_808n` is QuestDB's DATE NULL sentinel: it is
   * stored as NULL and cannot be stored as an ordinary value.
   */
  dateColumn(
    name: string,
    millisecondsSinceEpoch: number | bigint | null | undefined,
  ): QwpSender {
    if (this.omitsNullish(name, millisecondsSinceEpoch)) return this;
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
    if (this.omitsNullish(name, value)) return this;
    if (!(value instanceof Uint8Array)) {
      return this.failRow(
        new TypeError("binaryColumn accepts only Uint8Array values"),
      );
    }
    return this.addColumn(name, QWP_COLUMN_TYPE.BINARY, new Uint8Array(value));
  }

  charColumn(name: string, value: string | null | undefined): QwpSender {
    if (this.omitsNullish(name, value)) return this;
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
    if (this.omitsNullish(name, value)) return this;
    try {
      return this.addColumn(name, QWP_COLUMN_TYPE.UUID, uuidBytes(value));
    } catch (error) {
      return this.failRow(error);
    }
  }

  long256Column(
    name: string,
    word0: bigint | null | undefined,
    word1: bigint | null | undefined,
    word2: bigint | null | undefined,
    word3: bigint | null | undefined,
  ): QwpSender {
    const given = [word0, word1, word2, word3];
    const absent = given.filter(
      (word) => word === null || word === undefined,
    ).length;
    // A LONG256 is one value spread over four words, so "no value" means all
    // four are absent -- that omits the column, like every other setter. A
    // partial set is a caller mistake rather than a NULL, and saying so beats
    // letting BigInt.asIntN() raise "Cannot convert null to a BigInt".
    if (absent === given.length) {
      // Still a column call, so it is still checked like one.
      this.omitsNullish(name, null);
      return this;
    }
    if (absent > 0) {
      return this.failRow(
        new TypeError(
          "long256Column needs all four words, or none of them for a NULL value",
        ),
      );
    }
    try {
      const words: bigint[] = [];
      for (const [index, word] of given.entries()) {
        if (typeof word !== "bigint") {
          throw new TypeError(`LONG256 word ${index} must be a bigint`);
        }
        if (BigInt.asIntN(64, word) !== word) {
          throw new RangeError(`LONG256 word ${index} exceeds signed int64`);
        }
        words.push(word);
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
    if (this.omitsNullish(name, value)) return this;
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
    if (this.omitsNullish(name, value)) return this;
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
    // The scale describes the column, not this row's value, so a bad constant
    // is reported whether or not this row happens to carry a decimal.
    if (!Number.isSafeInteger(scale) || scale < 0 || scale > 76) {
      return this.failRow(
        new RangeError("decimal scale must be between 0 and 76"),
      );
    }
    if (this.omitsNullish(name, unscaled)) return this;
    try {
      if (typeof unscaled !== "bigint" && !(unscaled instanceof Int8Array)) {
        // signedBigEndianToBigInt() iterates its argument, and a string is
        // iterable: "12345" would coerce character by character into
        // 0x0102030405 and store silently, while "x" would store 0. Every
        // other setter rejects a wrong-typed value at the call site.
        throw new TypeError(
          "decimalColumn accepts only bigint or Int8Array values",
        );
      }
      if (unscaled instanceof Int8Array && unscaled.length === 0) return this;
      if (unscaled instanceof Int8Array && unscaled.length > 32) {
        throw new RangeError("decimal unscaled value cannot exceed 32 bytes");
      }
      const value =
        typeof unscaled === "bigint"
          ? unscaled
          : signedBigEndianToBigInt(unscaled);
      if (!fitsSigned(value, 256)) {
        throw new RangeError("decimal value exceeds DECIMAL256 capacity");
      }
      // Widest type, not one derived from this value's magnitude: the column
      // carries one type per frame, so deriving it per value would reject the
      // next row whose magnitude needs a different width. The Java client takes
      // the width from the overload for the same reason; decimal64Column,
      // decimal128Column and decimal256Column are the narrower equivalents.
      return this.addColumn(name, QWP_COLUMN_TYPE.DECIMAL256, value, {
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
    // The precision describes the column, not this row's value, so a bad
    // constant is reported whether or not this row happens to carry a geohash.
    if (!Number.isSafeInteger(precision) || precision < 1 || precision > 60) {
      return this.failRow(
        new RangeError("geohash precision must be between 1 and 60"),
      );
    }
    if (this.omitsNullish(name, value)) return this;
    if (typeof value !== "bigint") {
      // The range check below compares against BigInts, and neither branch of
      // it rejects a wrong-typed value: a non-numeric string makes both
      // comparisons undefined, while a numeric string, a boolean or an array
      // makes them numeric. Such a value would reach BigInt() in the frame
      // encoder instead, where it either stores a different number than the
      // compiled writer stores for the same input or throws long after the
      // row was staged.
      return this.failRow(
        new TypeError(
          "geohashColumn accepts only bigint raw bits; base-32 text is accepted by a compiled writer's geohash() column",
        ),
      );
    }
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

  /**
   * Discards the row in progress, including its table selection, so the next
   * row starts from table() again. Rows already completed stay staged.
   */
  cancelRow(): QwpSender {
    this.throwIfUnavailable();
    this.discardRow();
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
  // `async` so a closed or closing sender rejects rather than throwing out of
  // a method the signature says returns a Promise: a caller written as
  // `sender.flush().catch(...)` would not catch a synchronous throw, and from a
  // timer or event handler it becomes an uncaught exception. The enqueue itself
  // still runs synchronously, so flush ordering is unchanged.
  async flush(): Promise<boolean> {
    return this.enqueueFlush(false);
  }

  /**
   * Publishes pending rows without waiting for their server ACK and returns
   * the highest frame sequence produced by this call, or -1n when empty.
   * Pass the result to waitForAcknowledged() when an explicit delivery
   * barrier is needed.
   */
  async flushAndGetSequence(): Promise<bigint> {
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
  async commit(): Promise<boolean> {
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
    // The timeout bounds the ACK drain, and <= 0 opts out of it entirely
    // ("fast close"), matching the Java client. Publication still has to be
    // bounded: unlike Java's local hand-off into the send ring, a publication
    // here can be a socket write that never settles, and leaving it unbounded
    // made 0 -- the value chosen to make close() cheapest -- the only value
    // that could hang forever.
    const drainDeadline =
      this.closeFlushTimeoutMs > 0
        ? Date.now() + this.closeFlushTimeoutMs
        : undefined;
    const publishDeadline =
      Date.now() +
      (this.closeFlushTimeoutMs > 0
        ? this.closeFlushTimeoutMs
        : DEFAULT_CLOSE_FLUSH_TIMEOUT_MS);
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
      await this.withCloseDeadline(closeFlush, publishDeadline);

      const session = this.activeSession;
      const target = this.lastCommitBoundarySequence;
      if (
        drainDeadline !== undefined &&
        session &&
        target >= 0n &&
        sessionAcknowledgedSequence(session) < target
      ) {
        if (!session.waitForAcknowledged) {
          throw new Error(
            "this QWP ingress session does not expose an ACK watermark",
          );
        }
        const remaining = drainDeadline - Date.now();
        if (remaining <= 0) throw this.closeTimeoutError();
        try {
          await this.withCloseDeadline(
            session.waitForAcknowledged(target, remaining),
            drainDeadline,
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
      if (error instanceof QwpBatchTooLargeError) {
        // A cap rejection is a verdict on the batch's contents: no later flush
        // can make it fit, so close() discards it and finishes shutdown rather
        // than leaving it staged for a sender that is about to go away. Any
        // other failure is not a verdict on the batch and leaves staging alone.
        // This mirrors the Java client's close(), which calls
        // resetTableBuffersAfterFlush() for exactly this exception.
        const abandoned = this.discardStagedRows();
        this.log(
          "error",
          `Discarded ${abandoned} QWP row(s) on close: ${error.message}`,
        );
      }
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
      // flight. Abort it so the socket and its deadline go away now rather
      // than keeping the event loop alive until the connect timeout fires,
      // and still attach cleanup in case it had already connected.
      this.connectAbort.abort();
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

  private compileWriterSchema<Schema extends QwpWriterSchema>(
    tableName: string,
    schema: Schema,
  ): CompiledQwpWriterSchema {
    // Reuse the wire buffer's table validation so both sender APIs accept the
    // exact same identifiers.
    new QwpTableBuffer(tableName, this.maxNameLength);
    if (
      typeof schema !== "object" ||
      schema === null ||
      Array.isArray(schema)
    ) {
      throw new TypeError("QWP writer schema must be an object");
    }

    const entries = Object.entries(schema);
    if (entries.length === 0) {
      throw new TypeError("QWP writer schema must contain at least one column");
    }

    const columns: CompiledQwpWriterColumn[] = [];
    const inputNames = new Set<string>();
    const nameKeys = new Set<string>();
    let designatedTimestampCount = 0;
    for (const [inputName, candidate] of entries) {
      validateQwpColumnName(inputName, this.maxNameLength);
      if (!isQwpWriterColumn(candidate)) {
        throw new TypeError(
          `invalid QWP writer descriptor for column '${inputName}'`,
        );
      }
      if (candidate.designatedTimestamp) designatedTimestampCount++;
      if (designatedTimestampCount > 1) {
        throw new TypeError(
          "QWP writer schema cannot contain more than one designated timestamp",
        );
      }
      const wireName = candidate.designatedTimestamp ? "" : inputName;
      const nameKey = qwpColumnNameKey(wireName);
      if (nameKeys.has(nameKey)) {
        throw new TypeError(
          `duplicate case-insensitive QWP writer column '${inputName}'`,
        );
      }
      nameKeys.add(nameKey);
      inputNames.add(inputName);
      columns.push(
        Object.freeze({
          inputName,
          wireName,
          nameKey,
          type: qwpWriterColumnType(candidate),
          descriptor: candidate,
          ...qwpWriterColumnMetadata(candidate),
        }),
      );
    }

    return Object.freeze({
      tableName,
      columns: Object.freeze(columns),
      inputNames,
    });
  }

  private encodeCompiledWriterRow(
    schema: CompiledQwpWriterSchema,
    input: unknown,
    rowIndex: number | undefined,
  ): StagedRow {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new QwpWriterRowError(
        schema.tableName,
        undefined,
        rowIndex,
        new TypeError("row must be an object"),
      );
    }

    let inputKeys: string[];
    try {
      inputKeys = Object.keys(input);
    } catch (error) {
      throw new QwpWriterRowError(schema.tableName, undefined, rowIndex, error);
    }
    const unknownName = inputKeys.find(
      (inputName) => !schema.inputNames.has(inputName),
    );
    if (unknownName !== undefined) {
      throw new QwpWriterRowError(
        schema.tableName,
        unknownName,
        rowIndex,
        new TypeError("column is not present in the compiled schema"),
      );
    }

    const values = input as Record<string, unknown>;
    const columns = new Map<string, StagedColumn>();
    for (const column of schema.columns) {
      let value: unknown;
      try {
        value = Object.prototype.hasOwnProperty.call(input, column.inputName)
          ? values[column.inputName]
          : undefined;
      } catch (error) {
        throw new QwpWriterRowError(
          schema.tableName,
          column.inputName,
          rowIndex,
          error,
        );
      }
      if (value === null || value === undefined) {
        if (column.descriptor.designatedTimestamp) {
          throw new QwpWriterRowError(
            schema.tableName,
            column.inputName,
            rowIndex,
            new TypeError("designated timestamp is required"),
          );
        }
        continue;
      }
      try {
        const staged: StagedColumn = {
          name: column.wireName,
          type: column.type,
          value: encodeQwpWriterValue(column, value),
        };
        if (column.geohashPrecision !== undefined) {
          staged.geohashPrecision = column.geohashPrecision;
        }
        if (column.decimalScale !== undefined) {
          staged.decimalScale = column.decimalScale;
        }
        columns.set(column.nameKey, staged);
      } catch (error) {
        throw new QwpWriterRowError(
          schema.tableName,
          column.inputName,
          rowIndex,
          error,
        );
      }
    }

    // An all-nullish row is legal: QWP is columnar, so it is sent with no
    // columns, exactly as the fluent table().atNow() analogue and as README and
    // QWP.md document. A designated timestamp, when the schema has one, is
    // required above, so an empty row reaches here only for a schema with none.
    return { columns, estimatedBytes: stagedRowBytes(columns) };
  }

  private async appendCompiledWriterRow(
    schema: CompiledQwpWriterSchema,
    input: unknown,
    rowIndex: number | undefined,
  ): Promise<void> {
    this.throwIfUnavailable();
    // Report the conflicting fluent row before validating this one: it is the
    // actionable error, and row contents cannot be staged either way.
    if (this.current) {
      throw new QwpWriterRowError(
        schema.tableName,
        undefined,
        rowIndex,
        new Error("a fluent row is already in progress"),
      );
    }
    const row = this.encodeCompiledWriterRow(schema, input, rowIndex);

    const existingTable = this.tablesByName.get(schema.tableName);
    if (existingTable) {
      for (const [nameKey, column] of row.columns) {
        const existing = existingTable.schema.get(nameKey);
        if (
          existing &&
          (existing.type !== column.type ||
            existing.geohashPrecision !== column.geohashPrecision ||
            existing.decimalScale !== column.decimalScale)
        ) {
          const inputName = schema.columns.find(
            (candidate) => candidate.nameKey === nameKey,
          )?.inputName;
          throw new QwpWriterRowError(
            schema.tableName,
            inputName,
            rowIndex,
            new Error("column type conflicts with the sender's staged schema"),
          );
        }
      }
    }

    let table = existingTable;
    if (!table) {
      table = { name: schema.tableName, rows: [], schema: new Map() };
      this.tablesByName.set(schema.tableName, table);
      this.tables.push(table);
    }
    for (const [nameKey, column] of row.columns) {
      const existing = table.schema.get(nameKey);
      if (existing) column.name = existing.name;
      else {
        table.schema.set(nameKey, {
          name: column.name,
          type: column.type,
          geohashPrecision: column.geohashPrecision,
          decimalScale: column.decimalScale,
        });
      }
    }
    table.rows.push(row);
    this.pendingRowCount++;
    this.pendingByteCount += row.estimatedBytes;
    this.totalRowsStaged++;
    this.log(
      "debug",
      `Pending QWP rows: ${this.pendingRowCount}, estimated bytes: ${this.pendingByteCount}`,
    );
    await this.tryFlush();
  }

  private fixedDecimalColumn(
    name: string,
    unscaled: bigint | null | undefined,
    scale: number,
    type: QwpColumnType,
    bits: number,
    maximumScale: number,
  ): QwpSender {
    // The scale describes the column, not this row's value, so a bad constant
    // is reported whether or not this row happens to carry a decimal.
    if (!Number.isSafeInteger(scale) || scale < 0 || scale > maximumScale) {
      return this.failRow(
        new RangeError(`decimal scale must be between 0 and ${maximumScale}`),
      );
    }
    if (this.omitsNullish(name, unscaled)) return this;
    try {
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
          existingSchema.geohashPrecision !== metadata.geohashPrecision)
      ) {
        throw new Error(
          `column type mismatch for '${name}' [existing=${existingSchema.type}, received=${type}]`,
        );
      }
      if (
        existingSchema &&
        existingSchema.decimalScale !== metadata.decimalScale &&
        isDecimalType(type)
      ) {
        // The column locked its scale on its first value, as the Java client's
        // ColumnBuffer does; later values are rescaled onto it rather than
        // changing a scale the frame can only carry once.
        value = rescaleToColumnScale(
          name,
          value as bigint,
          metadata.decimalScale ?? 0,
          existingSchema.decimalScale ?? 0,
          type,
        );
        metadata = { ...metadata, decimalScale: existingSchema.decimalScale };
      }
      if (this.currentRow.has(nameKey)) return this;
      const canonicalName = existingSchema?.name ?? name;
      if (!existingSchema) this.currentRowSchemaKeys.push(nameKey);
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
    this.currentRowSchemaKeys.length = 0;
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

  /**
   * Drops the row in progress. A staged row is both its columns and its table
   * selection, so releasing only the columns would leave the sender inside a
   * row that table() then refuses to reopen.
   */
  private discardRow(): void {
    const table = this.current;
    if (table) {
      for (const key of this.currentRowSchemaKeys) table.schema.delete(key);
      // A table this row brought into being, and that nothing else has staged
      // or learned from, goes with it. Otherwise a loop that keeps rejecting
      // rows on fresh table names accumulates empty StagedTables forever.
      if (table.rows.length === 0 && table.schema.size === 0) {
        this.tablesByName.delete(table.name);
        const index = this.tables.indexOf(table);
        if (index >= 0) this.tables.splice(index, 1);
      }
    }
    this.currentRowSchemaKeys.length = 0;
    this.currentRow.clear();
    this.current = undefined;
  }

  private failRow(error: unknown): never {
    this.discardRow();
    throw error;
  }

  /** Removes a flush's staged rows from the pending buffers. */
  private releaseStagedRows(
    snapshots: readonly { table: StagedTable; rows: readonly StagedRow[] }[],
    generation: number,
  ): number {
    if (generation !== this.stagingGeneration) {
      // reset() dropped this staging and already zeroed the counters. The
      // tables these snapshots hold are detached from `tables`, so there is
      // nothing left to retire and subtracting would drive pendingRows
      // negative -- permanently, which delays every later row- and
      // byte-triggered auto-flush by that offset.
      return 0;
    }
    for (const { table, rows } of snapshots) {
      table.rows.splice(0, rows.length);
    }
    const rowCount = snapshots.reduce(
      (count, item) => count + item.rows.length,
      0,
    );
    const byteCount = snapshots.reduce(
      (total, item) =>
        total +
        item.rows.reduce(
          (tableTotal, row) => tableTotal + row.estimatedBytes,
          0,
        ),
      0,
    );
    this.pendingRowCount -= rowCount;
    this.pendingByteCount -= byteCount;
    return rowCount;
  }

  /**
   * Discards every staged row, the way the Java client's close() does with
   * resetTableBuffersAfterFlush() when the batch cap rejects the batch.
   */
  private discardStagedRows(): number {
    const snapshots = this.tables
      .filter((table) => table.rows.length > 0)
      .map((table) => ({ table, rows: table.rows.slice() }));
    return this.releaseStagedRows(snapshots, this.stagingGeneration);
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
    const generation = this.stagingGeneration;
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
    // planIngressFrames runs synchronously here, so an unfittable row throws
    // before anything reaches the transport and staging is retained: the
    // caller keeps the batch and can retry it. close() is where an over-cap
    // batch is finally discarded.
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
    if (publication) {
      await publication;
    }
    // These snapshot rows are exactly the ones whose frames entered the ingress
    // session, so they count as published even when a concurrent reset() has
    // since bumped the staging generation. releaseStagedRows() retires them from
    // the pending counters, returning early across that reset so pendingRows is
    // not driven negative -- how many rows were retired is a separate question
    // from how many were sent, and only the latter feeds the published metrics.
    const publishedRows = snapshots.reduce(
      (count, snapshot) => count + snapshot.rows.length,
      0,
    );
    this.releaseStagedRows(snapshots, generation);
    this.totalRowsPublished += publishedRows;
    this.lastFlushTime = Date.now();
    this.log(
      "debug",
      `${deferCommit ? "Auto-flushing" : "Flushing"} ${publishedRows} QWP row(s)${deferCommit ? " with commit deferred" : ""}`,
    );
    if (!deferCommit && publishedSequence >= 0n) {
      this.lastCommitBoundarySequence = publishedSequence;
    }

    if (deferCommit) {
      this.hasDeferredMessages = true;
      this.deferredRowCount += publishedRows;
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
    if (
      this.transactional &&
      (closesDeferredTransaction || publishedRows > 0)
    ) {
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
      // row.columns is already keyed by qwpColumnNameKey(column.name); passing
      // that key through avoids getOrCreateColumn recomputing it per cell.
      for (const [nameKey, column] of row.columns) {
        const target = result.getOrCreateColumn(
          column.name,
          column.type,
          nameKey,
        );
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
      // close() bounds its own flush with a deadline but cannot cancel it, so
      // an abandoned close flush stays runnable. Without this it could reach a
      // cleared sessionPromise, dial the database again, and write rows after
      // close() had already returned to the caller.
      //
      // Keyed on `closed`, not `closing`: close() is documented to publish
      // completed rows, and doing that legitimately needs a session even when
      // none was opened yet.
      if (this.closed) {
        return Promise.reject(this.unavailableError());
      }
      const connecting = this.sessionFactory(this.connectAbort.signal);
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

  private unavailableError(): Error {
    return new Error(
      this.closed ? "QWP sender is closed" : "QWP sender is closing",
    );
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
