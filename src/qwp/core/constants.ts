/** ASCII `QWP1`, represented as its little-endian uint32 value. */
export const QWP_MAGIC = 0x31505751;
export const QWP_VERSION = 1;
export const QWP_HEADER_SIZE = 12;

export const QWP_FLAG_DEFER_COMMIT = 0x01;
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
export const QWP_MAX_COLUMN_NAME_LENGTH = 127;
export const QWP_MAX_TABLE_NAME_LENGTH = 127;
export const QWP_MAX_ROWS_PER_TABLE = 1_000_000;
export const QWP_MAX_SYMBOL_DICTIONARY_SIZE = 1_000_000;
export const QWP_MAX_ERROR_MESSAGE_LENGTH = 1024;

export const QWP_INGRESS_PATH = "/write/v4";
export const QWP_EGRESS_PATH = "/read/v1";
