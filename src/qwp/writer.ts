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
  | "timestamp";

const QWP_WRITER_COLUMN = Symbol("QWP writer column");
const QWP_WRITER_INPUT: unique symbol = Symbol("QWP writer input");

/** A reusable, immutable column definition for a compiled QWP table writer. */
export interface QwpWriterColumn<
  T,
  DesignatedTimestamp extends boolean = false,
> {
  readonly kind: QwpWriterColumnKind;
  readonly designatedTimestamp: DesignatedTimestamp;
  readonly unit?: QwpTimestampUnit;
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

function column<T, DesignatedTimestamp extends boolean>(
  kind: QwpWriterColumnKind,
  designatedTimestamp: DesignatedTimestamp,
  unit?: QwpTimestampUnit,
): QwpWriterColumn<T, DesignatedTimestamp> {
  return Object.freeze({
    kind,
    designatedTimestamp,
    unit,
    [QWP_WRITER_COLUMN]: true,
  }) as BrandedQwpWriterColumn<T, DesignatedTimestamp>;
}

function validateTimestampUnit(unit: QwpTimestampUnit): void {
  if (unit !== "ns" && unit !== "us" && unit !== "ms") {
    throw new TypeError(`unsupported timestamp unit '${String(unit)}'`);
  }
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
  return column("timestamp", false, unit);
}

/** Defines the writer's required designated timestamp field. */
export function designatedTimestamp<const Unit extends QwpTimestampUnit = "us">(
  unit: Unit = "us" as Unit,
): QwpWriterColumn<TimestampInput<Unit>, true> {
  validateTimestampUnit(unit);
  return column("timestamp", true, unit);
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
