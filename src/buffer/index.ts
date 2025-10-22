// @ts-check
import { Buffer } from "node:buffer";

import {
  SenderOptions,
  PROTOCOL_VERSION_V1,
  PROTOCOL_VERSION_V2,
  PROTOCOL_VERSION_AUTO,
  PROTOCOL_VERSION_V3,
} from "../options";
import { TimestampUnit } from "../utils";
import { SenderBufferV1 } from "./bufferv1";
import { SenderBufferV2 } from "./bufferv2";
import { SenderBufferV3 } from "./bufferv3";

// Default initial buffer size in bytes (64 KB).
const DEFAULT_BUFFER_SIZE = 65536; //  64 KB

// Default maximum buffer size in bytes (100 MB).
const DEFAULT_MAX_BUFFER_SIZE = 104857600; // 100 MB

/**
 * Factory function to create a SenderBuffer instance based on the protocol version.
 * @param options - Sender configuration object.
 * See {@link SenderOptions} documentation for detailed description of configuration options.
 * @returns A SenderBuffer instance appropriate for the specified protocol version
 * @throws Error if protocol version is not specified or is unsupported
 */
function createBuffer(options: SenderOptions): SenderBuffer {
  switch (options.protocol_version) {
    case PROTOCOL_VERSION_V3:
      return new SenderBufferV3(options);
    case PROTOCOL_VERSION_V2:
      return new SenderBufferV2(options);
    case PROTOCOL_VERSION_V1:
      return new SenderBufferV1(options);
    case PROTOCOL_VERSION_AUTO:
    case undefined:
    case null:
    case "":
      throw new Error(
        "Provide the 'protocol_version' option, or call 'await SenderOptions.resolveAuto(options)' first",
      );
    default:
      throw new Error(
        `Unsupported protocol version: ${options.protocol_version}`,
      );
  }
}

/**
 * Buffer used by the Sender for data serialization. <br>
 * Provides methods for writing different data types into the buffer.
 */
interface SenderBuffer {
  /**
   * Resets the buffer, data sitting in the buffer will be lost.
   * In other words it clears the buffer, and sets the writing position to the beginning of the buffer.
   * @returns Returns with a reference to this buffer.
   */
  reset(): SenderBuffer;

  /**
   * Returns a cropped buffer, or null if there is nothing to send.
   * The returned buffer is backed by this buffer instance, meaning the view can change as the buffer is mutated.
   * Used only in tests to assert the buffer's content.
   * @param pos - Optional position parameter
   * @returns A view of the buffer
   */
  toBufferView(pos?: number): Buffer;

  /**
   * Returns a cropped buffer ready to send to the server, or null if there is nothing to send.
   * The returned buffer is a copy of this buffer.
   * It also compacts the buffer.
   * @param pos - Optional position parameter
   * @returns A copy of the buffer ready to send, or null
   */
  toBufferNew(pos?: number): Buffer | null;

  /**
   * Writes the table name into the buffer.
   * @param table - Table name.
   * @returns Returns with a reference to this buffer.
   */
  table(table: string): SenderBuffer;

  /**
   * Writes a symbol name and value into the buffer.
   * Use it to insert into SYMBOL columns.
   * @param name - Symbol name.
   * @param value - Symbol value, toString() is called to extract the actual symbol value from the parameter.
   * @returns Returns with a reference to this buffer.
   */
  symbol(name: string, value: unknown): SenderBuffer;

  /**
   * Writes a string column with its value into the buffer.
   * Use it to insert into VARCHAR and STRING columns.
   * @param name - Column name.
   * @param value - Column value, accepts only string values.
   * @returns Returns with a reference to this buffer.
   */
  stringColumn(name: string, value: string): SenderBuffer;

  /**
   * Writes a boolean column with its value into the buffer.
   * Use it to insert into BOOLEAN columns.
   * @param name - Column name.
   * @param value - Column value, accepts only boolean values.
   * @returns Returns with a reference to this buffer.
   */
  booleanColumn(name: string, value: boolean): SenderBuffer;

  /**
   * Writes a 64-bit floating point value into the buffer.
   * Use it to insert into DOUBLE or FLOAT database columns.
   * @param name - Column name.
   * @param value - Column value, accepts only number values.
   * @returns Returns with a reference to this buffer.
   */
  floatColumn(name: string, value: number): SenderBuffer;

  /**
   * Writes an array column with its values into the buffer.
   * @param name - Column name
   * @param value - Array values to write (currently supports double arrays)
   * @returns Returns with a reference to this buffer.
   * @throws Error if arrays are not supported by the buffer implementation, or array validation fails:
   * - value is not an array
   * - or the shape of the array is irregular: the length of sub-arrays are different
   * - or the array is not homogeneous: its elements are not all the same type
   */
  arrayColumn(name: string, value: unknown[]): SenderBuffer;

  /**
   * Writes a 64-bit signed integer into the buffer.
   * Use it to insert into LONG, INT, SHORT and BYTE columns.
   * @param name - Column name.
   * @param value - Column value, accepts only number values.
   * @returns Returns with a reference to this buffer.
   * @throws Error if the value is not an integer
   */
  intColumn(name: string, value: number): SenderBuffer;

  /**
   * Writes a timestamp column with its value into the buffer.
   * Use it to insert into TIMESTAMP columns.
   * @param name - Column name.
   * @param value - Epoch timestamp, accepts numbers or BigInts.
   * @param unit - Timestamp unit. Supported values: 'ns' - nanoseconds, 'us' - microseconds, 'ms' - milliseconds.
   * @returns Returns with a reference to this buffer.
   */
  timestampColumn(
    name: string,
    value: number | bigint,
    unit: TimestampUnit,
  ): SenderBuffer;

  /**
   * Writes a decimal value into the buffer using the text format.
   *
   * Use it to insert into DECIMAL database columns.
   *
   * @param {string} name - Column name.
   * @param {number} value - Column value, accepts only number/string values.
   * @returns {Sender} Returns with a reference to this buffer.
   */
  decimalColumnText(name: string, value: string | number): SenderBuffer;

  /**
   * Writes a decimal value into the buffer using the binary format.
   *
   * Use it to insert into DECIMAL database columns.
   *
   * @param {string} name - Column name.
   * @param {number} unscaled - The unscaled value of the decimal in two's
   * complement representation and big-endian byte order.
   * An empty array represents the NULL value.
   * @param {number} scale - The scale of the decimal value.
   * @returns {Sender} Returns with a reference to this buffer.
   */
  decimalColumnUnscaled(
    name: string,
    unscaled: Int8Array | bigint,
    scale: number,
  ): SenderBuffer;

  /**
   * Closes the row after writing the designated timestamp into the buffer.
   * @param timestamp - Designated epoch timestamp, accepts numbers or BigInts.
   * @param unit - Timestamp unit. Supported values: 'ns' - nanoseconds, 'us' - microseconds, 'ms' - milliseconds.
   */
  at(timestamp: number | bigint, unit: TimestampUnit): void;

  /**
   * Closes the row without writing designated timestamp into the buffer.
   * Designated timestamp will be populated by the server on this record.
   */
  atNow(): void;

  /**
   * Returns the current position of the buffer.
   * New data will be written into the buffer starting from this position.
   * @returns The current write position in the buffer
   */
  currentPosition(): number;
}

export {
  SenderBuffer,
  createBuffer,
  DEFAULT_BUFFER_SIZE,
  DEFAULT_MAX_BUFFER_SIZE,
};
