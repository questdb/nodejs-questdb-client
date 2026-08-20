export type QwpTimestampUnit = "ns" | "us" | "ms";

export type QwpWriterColumnKind =
  | "symbol"
  | "varchar"
  | "bool"
  | "byte"
  | "short"
  | "int32"
  | "int64"
  | "float32"
  | "float64"
  | "timestamp"
  | "date"
  | "char"
  | "binary"
  | "uuid"
  | "long256"
  | "ipv4"
  | "geohash"
  | "decimal64"
  | "decimal128"
  | "decimal256"
  | "doubleArray"
  | "longArray";

// Registered in the global symbol registry rather than created per module.
// The published package emits one bundle per entry point ('.', './qwp',
// './qwp/browser', './qwp/node'), so a module-private brand would differ
// between the bundle that stamps a column and the bundle that validates it:
// a schema built with the factories from './qwp' would be rejected by the
// writer() of a sender imported from './qwp/node'. The key carries a version
// so a future incompatible descriptor shape cannot interop with this one.
const QWP_WRITER_COLUMN: unique symbol = Symbol.for(
  "questdb.qwp.writer.column.v1",
);
// Type-level only: never stamped at runtime, so it needs no shared identity.
const QWP_WRITER_INPUT: unique symbol = Symbol("QWP writer input");

/** Maximum DECIMAL scale of each fixed-width decimal column type. */
export const QWP_DECIMAL_MAX_SCALE = {
  decimal64: 18,
  decimal128: 38,
  decimal256: 76,
} as const;

/** A reusable, immutable column definition for a compiled QWP table writer. */
export interface QwpWriterColumn<
  T,
  DesignatedTimestamp extends boolean = false,
> {
  readonly kind: QwpWriterColumnKind;
  readonly designatedTimestamp: DesignatedTimestamp;
  readonly unit?: QwpTimestampUnit;
  /** GEOHASH precision in bits, fixed for the whole column. */
  readonly precisionBits?: number;
  /** DECIMAL scale, fixed for the whole column. */
  readonly scale?: number;
  /** @internal Carries the input type without adding a runtime value. */
  readonly [QWP_WRITER_INPUT]?: T;
}

interface BrandedQwpWriterColumn<T, DesignatedTimestamp extends boolean>
  extends QwpWriterColumn<T, DesignatedTimestamp> {
  readonly [QWP_WRITER_COLUMN]: true;
}

export type QwpWriterSchema = Readonly<
  Record<string, QwpWriterColumn<unknown, boolean>>
>;

type QwpWriterColumnInput<Column> =
  Column extends QwpWriterColumn<infer Input, boolean> ? Input : never;

type QwpDesignatedTimestampKey<Schema extends QwpWriterSchema> = {
  [Key in keyof Schema]: Schema[Key] extends QwpWriterColumn<unknown, true>
    ? Key
    : never;
}[keyof Schema];

type QwpRegularColumnKey<Schema extends QwpWriterSchema> = Exclude<
  keyof Schema,
  QwpDesignatedTimestampKey<Schema>
>;

/** The object accepted by a table writer compiled from `Schema`. */
export type QwpWriterRow<Schema extends QwpWriterSchema> = {
  [Key in QwpDesignatedTimestampKey<Schema>]-?: QwpWriterColumnInput<
    Schema[Key]
  >;
} & {
  [Key in QwpRegularColumnKey<Schema>]?:
    | QwpWriterColumnInput<Schema[Key]>
    | null
    | undefined;
};

type TimestampInput<Unit extends QwpTimestampUnit> = Unit extends "ns"
  ? bigint
  : number | bigint;

/** UUID input: canonical text, 16 bytes, or the egress limb pair. */
export type QwpUuidInput =
  | string
  | Uint8Array
  | { readonly low: bigint; readonly high: bigint };

/** LONG256 little-endian words; word 0 is least significant. */
export type QwpLong256Words = readonly [bigint, bigint, bigint, bigint];

/**
 * LONG256 input: an unsigned 256-bit `bigint`, a `0x`-prefixed hex string of
 * up to 64 digits, four little-endian words, or the egress word record.
 */
export type QwpLong256Input =
  | bigint
  | string
  | QwpLong256Words
  | { readonly words: QwpLong256Words };

/** IPV4 input: dotted-quad text or the packed 32-bit address. */
export type QwpIpv4Input = string | number;

/**
 * GEOHASH input: the raw bits, base-32 geohash text whose length matches the
 * column precision, or the egress bit record.
 */
export type QwpGeohashInput =
  | bigint
  | number
  | string
  | { readonly bits: bigint; readonly precisionBits: number };

/**
 * DECIMAL input: the unscaled `bigint` at the column's scale, decimal text (or
 * a number) that is exactly representable at that scale, or the egress record.
 */
export type QwpDecimalInput =
  | bigint
  | number
  | string
  | { readonly unscaled: bigint; readonly scale: number };

/** Nested DOUBLE array of uniform shape. */
export type QwpNestedNumberArray = readonly (number | QwpNestedNumberArray)[];

/** Nested LONG array of uniform shape. */
export type QwpNestedLongArray = readonly (
  | number
  | bigint
  | QwpNestedLongArray
)[];

/** DOUBLE array input: nested arrays or a flat shape-and-values record. */
export type QwpDoubleArrayInput =
  | QwpNestedNumberArray
  | {
      readonly dimensions: readonly number[];
      readonly values: readonly number[];
    };

/** LONG array input: nested arrays or a flat shape-and-values record. */
export type QwpLongArrayInput =
  | QwpNestedLongArray
  | {
      readonly dimensions: readonly number[];
      readonly values: readonly (number | bigint)[];
    };

interface QwpWriterColumnMetadata {
  unit?: QwpTimestampUnit;
  precisionBits?: number;
  scale?: number;
}

function column<T, DesignatedTimestamp extends boolean>(
  kind: QwpWriterColumnKind,
  designatedTimestamp: DesignatedTimestamp,
  metadata: QwpWriterColumnMetadata = {},
): QwpWriterColumn<T, DesignatedTimestamp> {
  return Object.freeze({
    kind,
    designatedTimestamp,
    ...metadata,
    [QWP_WRITER_COLUMN]: true,
  }) as BrandedQwpWriterColumn<T, DesignatedTimestamp>;
}

function validateTimestampUnit(unit: QwpTimestampUnit): void {
  if (unit !== "ns" && unit !== "us" && unit !== "ms") {
    throw new TypeError(`unsupported timestamp unit '${String(unit)}'`);
  }
}

/** @internal Shared by the writer factories and the schema compiler. */
export function validateGeohashPrecision(precisionBits: number): number {
  if (
    !Number.isSafeInteger(precisionBits) ||
    precisionBits < 1 ||
    precisionBits > 60
  ) {
    throw new RangeError("geohash precision must be between 1 and 60 bits");
  }
  return precisionBits;
}

/** @internal Shared by the writer factories and the schema compiler. */
export function validateDecimalScale(
  scale: number,
  kind: keyof typeof QWP_DECIMAL_MAX_SCALE,
): number {
  const maximumScale = QWP_DECIMAL_MAX_SCALE[kind];
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > maximumScale) {
    throw new RangeError(`${kind} scale must be between 0 and ${maximumScale}`);
  }
  return scale;
}

/** Defines a string-valued QuestDB SYMBOL column. */
export function symbol(): QwpWriterColumn<string> {
  return column("symbol", false);
}

/** Defines a string-valued QuestDB VARCHAR column. */
export function varchar(): QwpWriterColumn<string> {
  return column("varchar", false);
}

/** Defines a QuestDB BOOLEAN column. */
export function bool(): QwpWriterColumn<boolean> {
  return column("bool", false);
}

/** Defines a signed 8-bit QuestDB BYTE column. */
export function byte(): QwpWriterColumn<number> {
  return column("byte", false);
}

/** Defines a signed 16-bit QuestDB SHORT column. */
export function short(): QwpWriterColumn<number> {
  return column("short", false);
}

/** Defines a signed 32-bit QuestDB INT column. */
export function int32(): QwpWriterColumn<number> {
  return column("int32", false);
}

/** Defines a signed 64-bit QuestDB LONG column. Inputs must be bigint. */
export function int64(): QwpWriterColumn<bigint> {
  return column("int64", false);
}

/** Defines a signed 64-bit QuestDB LONG column. Alias of {@link int64}. */
export function long(): QwpWriterColumn<bigint> {
  return int64();
}

/** Defines a 32-bit QuestDB FLOAT column. */
export function float32(): QwpWriterColumn<number> {
  return column("float32", false);
}

/** Defines a 64-bit QuestDB DOUBLE column. */
export function float64(): QwpWriterColumn<number> {
  return column("float64", false);
}

/** Defines a 64-bit QuestDB DOUBLE column. Alias of {@link float64}. */
export function double(): QwpWriterColumn<number> {
  return float64();
}

/** Defines a regular timestamp column with an explicit input unit. */
export function timestamp<const Unit extends QwpTimestampUnit = "us">(
  unit: Unit = "us" as Unit,
): QwpWriterColumn<TimestampInput<Unit>> {
  validateTimestampUnit(unit);
  return column("timestamp", false, { unit });
}

/** Defines the writer's required designated timestamp field. */
export function designatedTimestamp<const Unit extends QwpTimestampUnit = "us">(
  unit: Unit = "us" as Unit,
): QwpWriterColumn<TimestampInput<Unit>, true> {
  validateTimestampUnit(unit);
  return column("timestamp", true, { unit });
}

/** Defines a QuestDB DATE column. Inputs are milliseconds since the epoch. */
export function date(): QwpWriterColumn<number | bigint> {
  return column("date", false);
}

/** Defines a QuestDB CHAR column. Inputs are one UTF-16 code unit. */
export function char(): QwpWriterColumn<string> {
  return column("char", false);
}

/** Defines a QuestDB BINARY column. Inputs are copied on append. */
export function binary(): QwpWriterColumn<Uint8Array> {
  return column("binary", false);
}

/** Defines a QuestDB UUID column. */
export function uuid(): QwpWriterColumn<QwpUuidInput> {
  return column("uuid", false);
}

/** Defines a QuestDB LONG256 column. */
export function long256(): QwpWriterColumn<QwpLong256Input> {
  return column("long256", false);
}

/** Defines a QuestDB IPV4 column. `0.0.0.0` is the NULL sentinel. */
export function ipv4(): QwpWriterColumn<QwpIpv4Input> {
  return column("ipv4", false);
}

/**
 * Defines a QuestDB GEOHASH column of fixed precision.
 *
 * @param precisionBits - Precision in bits, 1 through 60. Base-32 text inputs
 * carry five bits per character, so `geohash(20)` accepts four characters.
 */
export function geohash(
  precisionBits: number,
): QwpWriterColumn<QwpGeohashInput> {
  return column("geohash", false, {
    precisionBits: validateGeohashPrecision(precisionBits),
  });
}

/** Defines a QuestDB DECIMAL64 column of fixed scale, up to 18. */
export function decimal64(scale: number): QwpWriterColumn<QwpDecimalInput> {
  return column("decimal64", false, {
    scale: validateDecimalScale(scale, "decimal64"),
  });
}

/** Defines a QuestDB DECIMAL128 column of fixed scale, up to 38. */
export function decimal128(scale: number): QwpWriterColumn<QwpDecimalInput> {
  return column("decimal128", false, {
    scale: validateDecimalScale(scale, "decimal128"),
  });
}

/** Defines a QuestDB DECIMAL256 column of fixed scale, up to 76. */
export function decimal256(scale: number): QwpWriterColumn<QwpDecimalInput> {
  return column("decimal256", false, {
    scale: validateDecimalScale(scale, "decimal256"),
  });
}

/** Defines a QuestDB DOUBLE[] column of any uniform shape. */
export function doubleArray(): QwpWriterColumn<QwpDoubleArrayInput> {
  return column("doubleArray", false);
}

/** Defines a QuestDB LONG[] column of any uniform shape. */
export function longArray(): QwpWriterColumn<QwpLongArrayInput> {
  return column("longArray", false);
}

/** A complete object row failed compiled-writer validation. */
export class QwpWriterRowError extends Error {
  readonly cause: unknown;

  constructor(
    readonly tableName: string,
    readonly columnName: string | undefined,
    readonly rowIndex: number | undefined,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const row = rowIndex === undefined ? "" : ` at index ${rowIndex}`;
    const columnNameSuffix =
      columnName === undefined ? "" : `, column '${columnName}'`;
    super(
      `invalid QWP row for table '${tableName}'${row}${columnNameSuffix}: ${detail}`,
    );
    this.name = "QwpWriterRowError";
    this.cause = cause;
  }
}

/** @internal */
export function isQwpWriterColumn(
  value: unknown,
): value is QwpWriterColumn<unknown, boolean> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<BrandedQwpWriterColumn<unknown, boolean>>)[
      QWP_WRITER_COLUMN
    ] === true
  );
}
