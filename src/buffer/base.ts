// @ts-check
import { Buffer } from "node:buffer";

import { log, Logger } from "../logging";
import { validateColumnName, validateTableName } from "../validation";
import { SenderOptions } from "../options";
import {
  SenderBuffer,
  DEFAULT_BUFFER_SIZE,
  DEFAULT_MAX_BUFFER_SIZE,
} from "./index";
import {
  isInteger,
  timestampToMicros,
  timestampToNanos,
  TimestampUnit,
} from "../utils";

// Default maximum length for table and column names.
const DEFAULT_MAX_NAME_LENGTH = 127;

/**
 * Abstract base class for SenderBuffer implementations. <br>
 * Provides common functionality for writing data into the buffer.
 */
abstract class SenderBufferBase implements SenderBuffer {
  private bufferSize: number;
  private readonly maxBufferSize: number;
  protected buffer: Buffer<ArrayBuffer>;
  protected position: number;
  private endOfLastRow: number;

  private hasTable: boolean;
  private hasSymbols: boolean;
  private hasColumns: boolean;

  private readonly maxNameLength: number;

  protected readonly log: Logger;

  /**
   * Creates an instance of SenderBufferBase.
   *
   * @param options - Sender configuration object containing buffer and naming options
   */
  protected constructor(options: SenderOptions) {
    this.log = options && typeof options.log === "function" ? options.log : log;
    SenderOptions.resolveDeprecated(options, this.log);

    this.maxNameLength =
      options && isInteger(options.max_name_len, 1)
        ? options.max_name_len
        : DEFAULT_MAX_NAME_LENGTH;

    this.maxBufferSize =
      options && isInteger(options.max_buf_size, 1)
        ? options.max_buf_size
        : DEFAULT_MAX_BUFFER_SIZE;
    this.resize(
      options && isInteger(options.init_buf_size, 1)
        ? options.init_buf_size
        : DEFAULT_BUFFER_SIZE,
    );

    this.reset();
  }

  /**
   * Extends the size of the buffer. <br>
   * Can be used to increase the size of buffer if overflown.
   * The buffer's content is copied into the new buffer.
   *
   * @param bufferSize - New size of the buffer used by the sender, provided in bytes
   * @throws Error if the requested buffer size exceeds the maximum allowed size
   */
  private resize(bufferSize: number) {
    if (bufferSize > this.maxBufferSize) {
      throw new Error(
        `Max buffer size is ${this.maxBufferSize} bytes, requested buffer size: ${bufferSize}`,
      );
    }
    this.bufferSize = bufferSize;
    const newBuffer = Buffer.alloc(this.bufferSize, 0);
    if (this.buffer) {
      this.buffer.copy(newBuffer);
    }
    this.buffer = newBuffer;
  }

  /**
   * Resets the buffer, data added to the buffer will be lost. <br>
   * In other words it clears the buffer and sets the writing position to the beginning of the buffer.
   *
   * @return {Sender} Returns with a reference to this sender.
   */
  reset(): SenderBuffer {
    this.position = 0;
    this.startNewRow();
    return this;
  }

  private startNewRow() {
    this.endOfLastRow = this.position;
    this.hasTable = false;
    this.hasSymbols = false;
    this.hasColumns = false;
  }

  /**
   * @return {Buffer} Returns a cropped buffer, or null if there is nothing to send. <br>
   * The returned buffer is backed by this buffer instance, meaning the view can change as the buffer is mutated.
   * Used only in tests to assert the buffer's content.
   */
  toBufferView(pos = this.endOfLastRow): Buffer {
    return pos > 0 ? this.buffer.subarray(0, pos) : null;
  }

  /**
   * @return {Buffer} Returns a cropped buffer ready to send to the server, or null if there is nothing to send. <br>
   * The returned buffer is a copy of this buffer.
   * It also compacts the buffer.
   */
  toBufferNew(pos = this.endOfLastRow): Buffer {
    if (pos > 0) {
      const data = Buffer.allocUnsafe(pos);
      this.buffer.copy(data, 0, 0, pos);
      this.compact();
      return data;
    }
    return null;
  }

  /**
   * Writes the table name into the buffer.
   *
   * @param {string} table - Table name.
   * @return {Sender} Returns with a reference to this sender.
   */
  table(table: string): SenderBuffer {
    if (typeof table !== "string") {
      throw new Error(`Table name must be a string, received ${typeof table}`);
    }
    if (this.hasTable) {
      throw new Error("Table name has already been set");
    }
    validateTableName(table, this.maxNameLength);
    this.checkCapacity([table], table.length);
    this.writeEscaped(table);
    this.hasTable = true;
    return this;
  }

  /**
   * Writes a symbol name and value into the buffer.
   *
   * @param {string} name - Symbol name.
   * @param {unknown} value - Symbol value, toString() is called to extract the actual symbol value from the parameter.
   * @return {Sender} Returns with a reference to this sender.
   */
  symbol(name: string, value: unknown): SenderBuffer {
    if (typeof name !== "string") {
      throw new Error(`Symbol name must be a string, received ${typeof name}`);
    }
    if (!this.hasTable || this.hasColumns) {
      throw new Error(
        "Symbol can be added only after table name is set and before any column added",
      );
    }
    const valueStr = value.toString();
    this.checkCapacity([name, valueStr], 2 + name.length + valueStr.length);
    this.write(",");
    validateColumnName(name, this.maxNameLength);
    this.writeEscaped(name);
    this.write("=");
    this.writeEscaped(valueStr);
    this.hasSymbols = true;
    return this;
  }

  /**
   * Writes a string column with its value into the buffer.
   *
   * @param {string} name - Column name.
   * @param {string} value - Column value, accepts only string values.
   * @return {Sender} Returns with a reference to this sender.
   */
  stringColumn(name: string, value: string): SenderBuffer {
    this.writeColumn(
      name,
      value,
      () => {
        this.checkCapacity([value], 2 + value.length);
        this.write('"');
        this.writeEscaped(value, true);
        this.write('"');
      },
      "string",
    );
    return this;
  }

  /**
   * Writes a boolean column with its value into the buffer.
   *
   * @param {string} name - Column name.
   * @param {boolean} value - Column value, accepts only boolean values.
   * @return {Sender} Returns with a reference to this sender.
   */
  booleanColumn(name: string, value: boolean): SenderBuffer {
    this.writeColumn(
      name,
      value,
      () => {
        this.checkCapacity([], 1);
        this.write(value ? "t" : "f");
      },
      "boolean",
    );
    return this;
  }

  /**
   * Writes a float column with its value into the buffer.
   *
   * @param {string} name - Column name.
   * @param {number} value - Column value, accepts only number values.
   * @return {Sender} Returns with a reference to this sender.
   */
  abstract floatColumn(name: string, value: number): SenderBuffer;

  /**
   * Writes an array column with its values into the buffer.
   *
   * @param {string} name - Column name.
   * @param {unknown[]} value - Column value, accepts only arrays.
   * @return {Sender} Returns with a reference to this sender.
   */
  abstract arrayColumn(name: string, value: unknown[]): SenderBuffer;

  /**
   * Writes an integer column with its value into the buffer.
   *
   * @param {string} name - Column name.
   * @param {number} value - Column value, accepts only number values.
   * @return {Sender} Returns with a reference to this sender.
   * @throws Error if the value is not an integer
   */
  intColumn(name: string, value: number): SenderBuffer {
    if (!Number.isInteger(value)) {
      throw new Error(`Value must be an integer, received ${value}`);
    }
    this.writeColumn(name, value, () => {
      const valueStr = value.toString();
      this.checkCapacity([valueStr], 1);
      this.write(valueStr);
      this.write("i");
    });
    return this;
  }

  /**
   * Writes a timestamp column with its value into the buffer.
   *
   * @param {string} name - Column name.
   * @param {number | bigint} value - Epoch timestamp, accepts numbers or BigInts.
   * @param {string} [unit=us] - Timestamp unit. Supported values: 'ns' - nanoseconds, 'us' - microseconds, 'ms' - milliseconds. Defaults to 'us'.
   * @return {Sender} Returns with a reference to this sender.
   */
  timestampColumn(
    name: string,
    value: number | bigint,
    unit: TimestampUnit = "us",
  ): SenderBuffer {
    if (typeof value !== "bigint" && !Number.isInteger(value)) {
      throw new Error(`Value must be an integer or BigInt, received ${value}`);
    }
    this.writeColumn(name, value, () => {
      const valueMicros = timestampToMicros(BigInt(value), unit);
      const valueStr = valueMicros.toString();
      this.checkCapacity([valueStr], 1);
      this.write(valueStr);
      this.write("t");
    });
    return this;
  }

  /**
   * Closes the row after writing the designated timestamp into the buffer.
   *
   * @param {number | bigint} timestamp - Designated epoch timestamp, accepts numbers or BigInts.
   * @param {string} [unit=us] - Timestamp unit. Supported values: 'ns' - nanoseconds, 'us' - microseconds, 'ms' - milliseconds. Defaults to 'us'.
   */
  at(timestamp: number | bigint, unit: TimestampUnit = "us") {
    if (!this.hasSymbols && !this.hasColumns) {
      throw new Error(
        "The row must have a symbol or column set before it is closed",
      );
    }
    if (typeof timestamp !== "bigint" && !Number.isInteger(timestamp)) {
      throw new Error(
        `Designated timestamp must be an integer or BigInt, received ${timestamp}`,
      );
    }
    const timestampNanos = timestampToNanos(BigInt(timestamp), unit);
    const timestampStr = timestampNanos.toString();
    this.checkCapacity([timestampStr], 2);
    this.write(" ");
    this.write(timestampStr);
    this.write("\n");
    this.startNewRow();
  }

  /**
   * Closes the row without writing designated timestamp into the buffer. <br>
   * Designated timestamp will be populated by the server on this record.
   */
  atNow() {
    if (!this.hasSymbols && !this.hasColumns) {
      throw new Error(
        "The row must have a symbol or column set before it is closed",
      );
    }
    this.checkCapacity([], 1);
    this.write("\n");
    this.startNewRow();
  }

  /**
   * Returns the current position of the buffer. <br>
   * New data will be written into the buffer starting from this position.
   */
  currentPosition(): number {
    return this.position;
  }

  /**
   * Checks if the buffer has sufficient capacity for additional data and resizes if needed.
   * @param data - Array of strings to calculate the required capacity for
   * @param base - Base number of bytes to add to the calculation
   */
  protected checkCapacity(data: string[], base = 0) {
    let length = base;
    for (const str of data) {
      length += Buffer.byteLength(str, "utf8");
    }
    if (this.position + length > this.bufferSize) {
      let newSize = this.bufferSize;
      do {
        newSize += this.bufferSize;
      } while (this.position + length > newSize);
      this.resize(newSize);
    }
  }

  /**
   * Compacts the buffer by removing data from completed rows.
   * Moves any remaining data to the beginning of the buffer.
   */
  private compact() {
    if (this.endOfLastRow > 0) {
      this.buffer.copy(this.buffer, 0, this.endOfLastRow, this.position);
      this.position = this.position - this.endOfLastRow;
      this.endOfLastRow = 0;
    }
  }

  /**
   * Common logic for writing column data to the buffer.
   * @param name - Column name
   * @param value - Column value 
   * @param writeValue - Function to write the value portion to the buffer
   * @param valueType - Optional expected type for validation
   */
  protected writeColumn(
    name: string,
    value: unknown,
    writeValue: () => void,
    valueType?: string,
  ) {
    if (typeof name !== "string") {
      throw new Error(`Column name must be a string, received ${typeof name}`);
    }
    if (valueType && typeof value !== valueType) {
      throw new Error(
        `Column value must be of type ${valueType}, received ${typeof value}`,
      );
    }
    if (!this.hasTable) {
      throw new Error("Column can be set only after table name is set");
    }
    this.checkCapacity([name], 2 + name.length);
    this.write(this.hasColumns ? "," : " ");
    validateColumnName(name, this.maxNameLength);
    this.writeEscaped(name);
    this.write("=");
    writeValue();
    this.hasColumns = true;
  }

  /**
   * Writes string data to the buffer at the current position.
   * @param data - String data to write
   */
  protected write(data: string) {
    this.position += this.buffer.write(data, this.position);
  }

  /**
   * Writes a single byte to the buffer at the current position.
   * @param data - Byte value to write
   */
  protected writeByte(data: number) {
    this.position = this.buffer.writeInt8(data, this.position);
  }

  /**
   * Writes a 32-bit integer to the buffer in little-endian format.
   * @param data - Integer value to write
   */
  protected writeInt(data: number) {
    this.position = this.buffer.writeInt32LE(data, this.position);
  }

  /**
   * Writes a double-precision float to the buffer in little-endian format.
   * @param data - Double value to write
   */
  protected writeDouble(data: number) {
    this.position = this.buffer.writeDoubleLE(data, this.position);
  }

  private writeEscaped(data: string, quoted = false) {
    for (const ch of data) {
      if (ch > "\\") {
        this.write(ch);
        continue;
      }

      switch (ch) {
        case " ":
        case ",":
        case "=":
          if (!quoted) {
            this.write("\\");
          }
          this.write(ch);
          break;
        case "\n":
        case "\r":
          this.write("\\");
          this.write(ch);
          break;
        case '"':
          if (quoted) {
            this.write("\\");
          }
          this.write(ch);
          break;
        case "\\":
          this.write("\\\\");
          break;
        default:
          this.write(ch);
          break;
      }
    }
  }
}

export { SenderBufferBase };
