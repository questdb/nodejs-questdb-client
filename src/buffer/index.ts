// @ts-check
import { Buffer } from "node:buffer";

import {
  SenderOptions,
  PROTOCOL_VERSION_V1,
  PROTOCOL_VERSION_V2,
  PROTOCOL_VERSION_AUTO,
} from "../options";
import { TimestampUnit } from "../utils";
import { SenderBufferV1 } from "./bufferv1";
import { SenderBufferV2 } from "./bufferv2";

// Default initial buffer size in bytes (64 KB).
const DEFAULT_BUFFER_SIZE = 65536; //  64 KB

// Default maximum buffer size in bytes (100 MB).
const DEFAULT_MAX_BUFFER_SIZE = 104857600; // 100 MB

/**
 * Factory function to create a SenderBuffer instance based on the protocol version.
 *
 * @param {SenderOptions} options - Sender configuration object. <br>
 * See SenderOptions documentation for detailed description of configuration options.
 *
 * @returns {SenderBuffer} A SenderBuffer instance appropriate for the specified protocol version
 * @throws Error if protocol version is not specified or is unsupported
 */
function createBuffer(options: SenderOptions): SenderBuffer {
  switch (options.protocol_version) {
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
 * Buffer used by the Sender.
 */
interface SenderBuffer {
  /**
   * Resets the buffer, data sitting in the buffer will be lost. <br>
   * In other words it clears the buffer, and sets the writing position to the beginning of the buffer.
   *
   * @return {Sender} Returns with a reference to this sender.
   */
  reset(): SenderBuffer;

  /**
   * @return {Buffer} Returns a cropped buffer, or null if there is nothing to send. <br>
   * The returned buffer is backed by this buffer instance, meaning the view can change as the buffer is mutated.
   * Used only in tests to assert the buffer's content.
   */
  toBufferView(pos?: number): Buffer;

  /**
   * @return {Buffer} Returns a cropped buffer ready to send to the server, or null if there is nothing to send. <br>
   * The returned buffer is a copy of this buffer.
   * It also compacts the buffer.
   */
  toBufferNew(pos?: number): Buffer | null;

  /**
   * Writes the table name into the buffer.
   *
   * @param {string} table - Table name.
   * @return {Sender} Returns with a reference to this sender.
   */
  table(table: string): SenderBuffer;

  /**
   * Writes a symbol name and value into the buffer. <br>
   * Use it to insert into SYMBOL columns.
   *
   * @param {string} name - Symbol name.
   * @param {unknown} value - Symbol value, toString() is called to extract the actual symbol value from the parameter.
   * @return {Sender} Returns with a reference to this sender.
   */
  symbol(name: string, value: unknown): SenderBuffer;

  /**
   * Writes a string column with its value into the buffer. <br>
   * Use it to insert into VARCHAR and STRING columns.
   *
   * @param {string} name - Column name.
   * @param {string} value - Column value, accepts only string values.
   * @return {Sender} Returns with a reference to this sender.
   */
  stringColumn(name: string, value: string): SenderBuffer;

  /**
   * Writes a boolean column with its value into the buffer. <br>
   * Use it to insert into BOOLEAN columns.
   *
   * @param {string} name - Column name.
   * @param {boolean} value - Column value, accepts only boolean values.
   * @return {Sender} Returns with a reference to this sender.
   */
  booleanColumn(name: string, value: boolean): SenderBuffer;

  /**
   * Writes a 64-bit floating point value into the buffer. <br>
   * Use it to insert into DOUBLE or FLOAT database columns.
   *
   * @param {string} name - Column name.
   * @param {number} value - Column value, accepts only number values.
   * @return {Sender} Returns with a reference to this sender.
   */
  floatColumn(name: string, value: number): SenderBuffer;

  /**
   * Writes an array column with its values into the buffer.
   *
   * @param {string} name - Column name
   * @param {unknown[]} value - Array values to write (currently supports double arrays)
   * @returns {Sender} Returns with a reference to this buffer.
   * @throws Error if arrays are not supported by the buffer implementation, or array validation fails:
   * - value is not an array
   * - or the shape of the array is irregular: the length of sub-arrays are different
   * - or the array is not homogeneous: its elements are not all the same type
   */
  arrayColumn(name: string, value: unknown[]): SenderBuffer;

  /**
   * Writes a 64-bit signed integer into the buffer. <br>
   * Use it to insert into LONG, INT, SHORT and BYTE columns.
   *
   * @param {string} name - Column name.
   * @param {number} value - Column value, accepts only number values.
   * @return {Sender} Returns with a reference to this sender.
   * @throws Error if the value is not an integer
   */
  intColumn(name: string, value: number): SenderBuffer;

  /**
   * Writes a timestamp column with its value into the buffer. <br>
   * Use it to insert into TIMESTAMP columns.
   *
   * @param {string} name - Column name.
   * @param {number | bigint} value - Epoch timestamp, accepts numbers or BigInts.
   * @param {string} [unit=us] - Timestamp unit. Supported values: 'ns' - nanoseconds, 'us' - microseconds, 'ms' - milliseconds. Defaults to 'us'.
   * @return {Sender} Returns with a reference to this sender.
   */
  timestampColumn(
    name: string,
    value: number | bigint,
    unit: TimestampUnit,
  ): SenderBuffer;

  /**
   * Closes the row after writing the designated timestamp into the buffer.
   *
   * @param {number | bigint} timestamp - Designated epoch timestamp, accepts numbers or BigInts.
   * @param {string} [unit=us] - Timestamp unit. Supported values: 'ns' - nanoseconds, 'us' - microseconds, 'ms' - milliseconds. Defaults to 'us'.
   */
  at(timestamp: number | bigint, unit: TimestampUnit): void;

  /**
   * Closes the row without writing designated timestamp into the buffer. <br>
   * Designated timestamp will be populated by the server on this record.
   */
  atNow(): void;

  /**
   * Returns the current position of the buffer. <br>
   * New data will be written into the buffer starting from this position.
   */
  currentPosition(): number;
}

export {
  SenderBuffer,
  createBuffer,
  DEFAULT_BUFFER_SIZE,
  DEFAULT_MAX_BUFFER_SIZE,
};
