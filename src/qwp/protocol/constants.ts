import { Buffer } from "node:buffer";

/** ASCII "QWP1"; reads as 0x31505751 when interpreted little-endian. */
export const QWP_MAGIC = Buffer.from("QWP1", "ascii");
export const QWP_VERSION = 1;
export const HEADER_SIZE = 12;

export const FLAG_DEFER_COMMIT = 0x01;
export const FLAG_GORILLA = 0x04;
export const FLAG_DELTA_SYMBOL_DICT = 0x08;

// Column type codes (spec 6.3). Only the four this plan encodes.
export const TYPE_DOUBLE = 0x07;
export const TYPE_SYMBOL = 0x09;
export const TYPE_TIMESTAMP = 0x0a;
export const TYPE_LONG = 0x05;

// Limits mirrored from the server (spec 6.4).
export const MAX_COLUMNS_PER_TABLE = 2048;
export const MAX_NAME_LENGTH = 127;
export const MAX_ROWS_PER_TABLE = 1_000_000;

export const WRITE_PATH = "/write/v4";
