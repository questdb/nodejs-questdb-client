/** ASCII `QWP1`, represented as its little-endian uint32 value. */
export const QWP_MAGIC = 0x31505751;
export const QWP_VERSION = 1;
export const QWP_HEADER_SIZE = 12;

export const QWP_FLAG_DEFER_COMMIT = 0x01;
/** Table-less ingress control frame that polls negotiated durable-ACK progress. */
export const QWP_FLAG_DURABLE_ACK_POLL = 0x02;
export const QWP_FLAG_GORILLA = 0x04;
export const QWP_FLAG_DELTA_SYMBOL_DICTIONARY = 0x08;
export const QWP_FLAG_ZSTD = 0x10;

export const QWP_COLUMN_TYPE = {
  BOOLEAN: 0x01,
  BYTE: 0x02,
  SHORT: 0x03,
  INT: 0x04,
  LONG: 0x05,
  FLOAT: 0x06,
  DOUBLE: 0x07,
  SYMBOL: 0x09,
  TIMESTAMP: 0x0a,
  DATE: 0x0b,
  UUID: 0x0c,
  LONG256: 0x0d,
  GEOHASH: 0x0e,
  VARCHAR: 0x0f,
  TIMESTAMP_NANOS: 0x10,
  DOUBLE_ARRAY: 0x11,
  LONG_ARRAY: 0x12,
  DECIMAL64: 0x13,
  DECIMAL128: 0x14,
  DECIMAL256: 0x15,
  CHAR: 0x16,
  BINARY: 0x17,
  IPV4: 0x18,
} as const;

export type QwpColumnType =
  (typeof QWP_COLUMN_TYPE)[keyof typeof QWP_COLUMN_TYPE];

export const QWP_ENCODING_UNCOMPRESSED = 0x00;
export const QWP_ENCODING_GORILLA = 0x01;

export const QWP_STATUS = {
  OK: 0x00,
  SERVER_INFO: 0x01,
  DURABLE_ACK: 0x02,
  SCHEMA_MISMATCH: 0x03,
  PARSE_ERROR: 0x05,
  INTERNAL_ERROR: 0x06,
  SECURITY_ERROR: 0x08,
  WRITE_ERROR: 0x09,
  CANCELLED: 0x0a,
  LIMIT_EXCEEDED: 0x0b,
  NOT_WRITABLE: 0x0c,
  DICTIONARY_GAP: 0x0d,
} as const;

export const QWP_EGRESS_MESSAGE = {
  QUERY_REQUEST: 0x10,
  RESULT_BATCH: 0x11,
  RESULT_END: 0x12,
  QUERY_ERROR: 0x13,
  CANCEL: 0x14,
  CREDIT: 0x15,
  EXEC_DONE: 0x16,
  CACHE_RESET: 0x17,
  SERVER_INFO: 0x18,
} as const;

export const QWP_EGRESS_CAPABILITY = {
  ZONE: 0x00000001,
  QUERY_FLAGS: 0x00000002,
  COMPRESSION: 0x00000004,
} as const;

export const QWP_COMPRESSION_CODEC = {
  RAW: 0,
  ZSTD: 1,
} as const;

export const QWP_QUERY_FLAG_RESET_DICTIONARY = 0x01;
export const QWP_RESET_MASK_DICTIONARY = 0x01;

export const QWP_SERVER_ROLE = {
  STANDALONE: 0,
  PRIMARY: 1,
  REPLICA: 2,
  PRIMARY_CATCHUP: 3,
} as const;

export const QWP_MAX_COLUMNS_PER_TABLE = 2048;
/** Maximum array rank accepted by QuestDB's QWP ingress decoder. */
export const QWP_MAX_ARRAY_DIMENSIONS = 32;
/** Maximum signed int32 array-axis length accepted by QWP ingress. */
export const QWP_MAX_ARRAY_DIMENSION_LENGTH = 2_147_483_647;
/** Default QWP ingress identifier limits, in UTF-8 wire bytes. */
export const QWP_MAX_COLUMN_NAME_LENGTH = 127;
export const QWP_MAX_TABLE_NAME_LENGTH = 127;
/**
 * Defensive byte bound for identifiers decoded from query results.
 *
 * Existing tables may have names created through APIs that apply Java's
 * 127-UTF-16-code-unit metadata limit. One code unit takes at most three UTF-8
 * bytes, so query decoding accepts that larger representation even though QWP
 * ingress enforces its 127-byte protocol limit.
 */
export const QWP_MAX_IDENTIFIER_BYTES = QWP_MAX_TABLE_NAME_LENGTH * 3;
export const QWP_MAX_ROWS_PER_TABLE = 1_000_000;
export const QWP_MAX_SYMBOL_DICTIONARY_SIZE = 1_000_000;
// No QWP_MAX_ERROR_MESSAGE_LENGTH. Server-supplied error text is bounded by
// its u16 length field and by the frame that carries it, and by nothing else:
// the server truncates ingress error text at
// (http.send.buffer.size - 100) / 1.5 characters and caps egress QUERY_ERROR
// at whatever its caller passes, so no fixed client-side ceiling matches the
// protocol. The Java client agrees -- its own MAX_ERROR_MESSAGE_LENGTH is a
// write-side truncation bound and is never applied when decoding.
/** Largest client-requested egress RESULT_BATCH row cap. */
export const QWP_MAX_BATCH_ROWS_UPPER_BOUND = 1_048_576;
/**
 * Largest `rowCount * columnCount` a single RESULT_BATCH may declare.
 *
 * The row and column caps above bound each dimension on its own, and their
 * product does not have to be reachable: 1,048,576 rows of 2,048 columns is
 * 2.1 billion cells. Decoding materializes two `rowCount`-length arrays per
 * column, measured at 16 bytes per cell, so the product is what decides how
 * much memory a response can cost. It is also the dimension a compressed body
 * detaches from the wire: an all-NULL column is one bit per cell before zstd,
 * so without this bound a few kilobytes of RLE-compressed bitmap declares a
 * grid no heap can hold.
 *
 * 32Mi cells is roughly 512 MB decoded. That is far above any plausible
 * result -- the widest supported table at 16k rows, or a full 1,048,576-row
 * batch at 32 columns -- and far below what the caps alone would permit.
 */
export const QWP_MAX_CELLS_PER_BATCH = 33_554_432;

export const QWP_INGRESS_PATH = "/write/v4";
export const QWP_EGRESS_PATH = "/read/v1";
