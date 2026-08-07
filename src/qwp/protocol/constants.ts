import { Buffer } from "node:buffer";

/** ASCII "QWP1"; reads as 0x31505751 when interpreted little-endian. */
export const QWP_MAGIC = Buffer.from("QWP1", "ascii");
export const QWP_VERSION = 1;
export const HEADER_SIZE = 12;

export const FLAG_DEFER_COMMIT = 0x01;
export const FLAG_GORILLA = 0x04;
export const FLAG_DELTA_SYMBOL_DICT = 0x08;

// Column type codes (spec 6.3).
export const TYPE_BOOLEAN = 0x01;
export const TYPE_BYTE = 0x02;
export const TYPE_SHORT = 0x03;
export const TYPE_INT = 0x04;
export const TYPE_LONG = 0x05;
export const TYPE_FLOAT = 0x06;
export const TYPE_DOUBLE = 0x07;
export const TYPE_SYMBOL = 0x09;
export const TYPE_TIMESTAMP = 0x0a;
export const TYPE_DATE = 0x0b;
export const TYPE_UUID = 0x0c;
export const TYPE_LONG256 = 0x0d;
export const TYPE_GEOHASH = 0x0e;
export const TYPE_VARCHAR = 0x0f;
export const TYPE_TIMESTAMP_NANOS = 0x10;
export const TYPE_DOUBLE_ARRAY = 0x11;
export const TYPE_LONG_ARRAY = 0x12;
export const TYPE_DECIMAL64 = 0x13;
export const TYPE_DECIMAL128 = 0x14;
export const TYPE_DECIMAL256 = 0x15;
export const TYPE_CHAR = 0x16;
export const TYPE_BINARY = 0x17;
export const TYPE_IPV4 = 0x18;

export const ENCODING_UNCOMPRESSED = 0x00;
export const ENCODING_GORILLA = 0x01;

// Limits mirrored from the server (spec 6.4).
export const MAX_COLUMNS_PER_TABLE = 2048;
export const MAX_NAME_LENGTH = 127;
export const MAX_ROWS_PER_TABLE = 1_000_000;
export const MAX_SYMBOL_DICTIONARY_SIZE = 1_000_000;

export const WRITE_PATH = "/write/v4";

/** "Not advertised" is not "unbounded": cap dictionary catch-up when the cap is unknown (spec 7.5). */
export const UNCAPPED_CATCHUP_PACKING_LIMIT = 64 * 1024;
