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
// QwpEgressSession is public, because connectQwp*Egress() and the pooled clients
// hand it to callers as the query API, but constructing one is not: the
// factories that open one are internal, and so are the options it takes on its
// own, which each runtime's egress options include.
export {
  QWP_DEFAULT_EGRESS_BUFFER_POOL_SIZE,
  QWP_DEFAULT_EGRESS_INITIAL_CREDIT,
  QWP_DEFAULT_EGRESS_SERVER_INFO_TIMEOUT_MS,
  QwpEgressQuery,
  QwpEgressQueryAbandonedError,
  QwpEgressQueryCancelTimeoutError,
  QwpEgressQueryError,
  QwpEgressQueryTimeoutError,
  QwpEgressSession,
  QwpEgressSessionClosedError,
} from "../_qwp/egress-session";
export type {
  QwpEgressMetrics,
  QwpEgressQueryOptions,
  QwpEgressViewCallbackControl,
  QwpEgressViewQuery,
  QwpQueryCompletion,
  QwpResultBatchViewHandler,
} from "../_qwp/egress-session";
// QwpIngressSession is the internal layer below QwpSender, as in the Java, Rust
// and Python clients, so only what the sender API surfaces is public: its
// notifications, metrics and errors. Its options, like the sender's own, are
// part of each runtime's ingress options rather than types of their own.
export {
  QWP_INGRESS_PROGRESS_KIND,
  QwpBatchTooLargeError,
  QwpIngressAckAbandonedError,
  QwpIngressNackError,
  QwpIngressSessionClosedError,
} from "../_qwp/ingress-session";
export type {
  QwpIngressErrorEvent,
  QwpIngressMetrics,
  QwpIngressProgressEvent,
  QwpIngressProgressKind,
} from "../_qwp/ingress-session";
export {
  QwpSender,
  QwpSenderCloseTimeoutError,
  QwpTableWriter,
} from "../_qwp/sender";
export type { QwpSenderLogger, QwpSenderMetrics } from "../_qwp/sender";
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
