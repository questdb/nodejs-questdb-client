/**
 * Browser-safe QuestDB Wire Protocol primitives.
 *
 * This private shared surface intentionally contains no Node.js imports. The
 * public browser and Node packages add their runtime-specific adapters.
 *
 * @packageDocumentation
 */
export * from "../_qwp/_core";
export * from "../_qwp/client";
export * from "../_qwp/egress-session";
export * from "../_qwp/ingress-session";
export * from "../_qwp/sender";
export * from "../_qwp/sender-error";
export * from "../_qwp/transport";
export {
  binary,
  bool,
  byte,
  char,
  date,
  decimal64,
  decimal128,
  decimal256,
  designatedTimestamp,
  double,
  doubleArray,
  float32,
  float64,
  geohash,
  int32,
  int64,
  ipv4,
  long,
  long256,
  longArray,
  short,
  symbol,
  timestamp,
  uuid,
  varchar,
  QWP_DECIMAL_MAX_SCALE,
  QwpWriterRowError,
} from "../_qwp/writer";
export type {
  QwpDecimalInput,
  QwpDoubleArrayInput,
  QwpGeohashInput,
  QwpIpv4Input,
  QwpLong256Input,
  QwpLong256Words,
  QwpLongArrayInput,
  QwpNestedLongArray,
  QwpNestedNumberArray,
  QwpTimestampUnit,
  QwpUuidInput,
  QwpWriterColumn,
  QwpWriterColumnKind,
  QwpWriterRow,
  QwpWriterSchema,
} from "../_qwp/writer";
