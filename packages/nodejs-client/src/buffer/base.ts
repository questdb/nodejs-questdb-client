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
import { isInteger, TimestampUnit } from "../utils";

// Default maximum length for table and column names.
const DEFAULT_MAX_NAME_LENGTH = 127;

/**
 * Abstract base class for sender buffer implementations. <br>
 * Provides common functionality for writing data into the buffer.
 */
abstract class SenderBufferBase implements SenderBuffer {
  private bufferSize: number;
  private readonly maxBufferSize: number;
  protected buffer: Buffer;
  protected position: number;
  private endOfLastRow: number;

  private hasTable: boolean;
  private hasSymbols: boolean;
  private hasColumns: boolean;
  /**
   * Whether a column setter has been called on the row being built, whether or
   * not it wrote anything. Distinct from {@link hasColumns}, which tracks bytes
   * in the buffer and therefore decides the field separator and whether the row
   * can be closed. Symbol ordering is a property of the call sequence, so it
   * must be judged on calls: a column whose value was nullish emits nothing but
   * still means the caller has moved past the symbol section.
   */
  private hasColumnCall: boolean;

  private readonly maxNameLength: number;

  protected readonly log: Logger;

  /**
   * Creates an instance of SenderBufferBase.
   *
   * @param {SenderOptions} options - Sender configuration object. <br>
   * See SenderOptions documentation for detailed description of configuration options.
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
   * @ignore
   * Resizes the buffer. <br>
   * Can be used to increase the size of the buffer if data to be written would not fit.
   * Creates a new buffer, and copies the content of the old buffer into the new one.
   *
   * @param {number} bufferSize - New size of the buffer used by the sender, provided in bytes
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
   * Resets the buffer, data sitting in the buffer will be lost. <br>
   * In other words it clears the buffer, and sets the writing position to the beginning of the buffer.
   *
   * @return {SenderBuffer} Returns with a reference to this buffer.
   */
  reset(): SenderBuffer {
    this.position = 0;
    this.startNewRow();
    return this;
  }

  /**
   * @ignore
   * Drops the row being built, so a row that cannot be closed leaves the
   * buffer exactly as it was before table() -- the same contract the QWP
   * sender's cancelRow() offers.
   *
   * Without this, a rejected close left `hasTable` set and `position` past
   * `endOfLastRow`: every later table() raised "Table name has already been
   * set", including after a successful flush(), because compact() moves bytes
   * without touching the row flags. reset() was the only way out and it
   * discards whatever was already staged. An invalid timestamp unit also used
   * to reach writeTimestamp() after the separator was written, so retrying at()
   * produced a second one and corrupted the line.
   */
  private discardIncompleteRow() {
    this.position = this.endOfLastRow;
    this.startNewRow();
  }

  private validateTimestampUnit(unit: TimestampUnit): void {
    if (unit !== "ns" && unit !== "us" && unit !== "ms") {
      throw new Error(`Unknown timestamp unit: ${unit}`);
    }
  }

  private startNewRow() {
    this.endOfLastRow = this.position;
    this.hasTable = false;
    this.hasSymbols = false;
    this.hasColumns = false;
    this.hasColumnCall = false;
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
   * @return {SenderBuffer} Returns with a reference to this buffer.
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
   * Writes a symbol name and value into the buffer. <br>
   * Use it to insert into SYMBOL columns.
   *
   * @param {string} name - Symbol name.
   * @param {unknown} value - Symbol value, toString() is called to extract the actual symbol value from the parameter. A null or undefined value omits the symbol entirely (stored as NULL).
   * @return {SenderBuffer} Returns with a reference to this buffer.
   */
  symbol(name: string, value: unknown): SenderBuffer {
    this.validateSymbolCall(name);
    // A null or undefined value omits the symbol entirely (see issue #28).
    // A symbol never closes the symbol section, so this does not mark a
    // column call the way the omitting column setters do.
    if (this.isNullOrUndefined(value)) {
      return this;
    }
    const valueStr = value.toString();
    this.checkCapacity([name, valueStr], 2 + name.length + valueStr.length);
    this.write(",");
    this.writeEscaped(name);
    this.write("=");
    this.writeEscaped(valueStr);
    this.hasSymbols = true;
    return this;
  }

  /**
   * Writes a string column with its value into the buffer. <br>
   * Use it to insert into VARCHAR and STRING columns.
   *
   * @param {string} name - Column name.
   * @param {string | null | undefined} value - Column value, accepts only string values. A null or undefined value omits the column entirely (stored as NULL).
   * @return {SenderBuffer} Returns with a reference to this buffer.
   */
  stringColumn(name: string, value: string | null | undefined): SenderBuffer {
    this.validateColumnCall(name);
    // A null or undefined value omits the column entirely (see issue #28).
    if (this.isNullOrUndefined(value)) {
      return this.omitColumn();
    }
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
   * Writes a boolean column with its value into the buffer. <br>
   * Use it to insert into BOOLEAN columns.
   *
   * @param {string} name - Column name.
   * @param {boolean | null | undefined} value - Column value, accepts only boolean values. A null or undefined value omits the column entirely (stored as NULL).
   * @return {SenderBuffer} Returns with a reference to this buffer.
   */
  booleanColumn(name: string, value: boolean | null | undefined): SenderBuffer {
    this.validateColumnCall(name);
    // A null or undefined value omits the column entirely (see issue #28).
    if (this.isNullOrUndefined(value)) {
      return this.omitColumn();
    }
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
   * Writes a 64-bit floating point value into the buffer. <br>
   * Use it to insert into DOUBLE or FLOAT database columns.
   *
   * @param {string} name - Column name.
   * @param {number | null | undefined} value - Column value, accepts only number values. A null or undefined value omits the column entirely (stored as NULL).
   * @return {SenderBuffer} Returns with a reference to this buffer.
   */
  abstract floatColumn(
    name: string,
    value: number | null | undefined,
  ): SenderBuffer;

  /**
   * Writes an array column with its values into the buffer.
   *
   * @param {string} name - Column name
   * @param {unknown[] | null | undefined} value - Array values to write (currently supports double arrays). A null or undefined value omits the column entirely when arrays are supported; protocol v1 rejects the call for every value.
   * @returns {SenderBuffer} Returns with a reference to this buffer.
   * @throws Error if arrays are not supported by the buffer implementation, or array validation fails:
   * - value is not an array
   * - or the shape of the array is irregular: the length of sub-arrays are different
   * - or the array is not homogeneous: its elements are not all the same type
   */
  abstract arrayColumn(
    name: string,
    value: unknown[] | null | undefined,
  ): SenderBuffer;

  /**
   * Writes a 64-bit signed integer into the buffer. <br>
   * Use it to insert into LONG, INT, SHORT and BYTE columns.
   *
   * @param {string} name - Column name.
   * @param {number | null | undefined} value - Column value, accepts only number values. A null or undefined value omits the column entirely (stored as NULL).
   * @return {SenderBuffer} Returns with a reference to this buffer.
   * @throws Error if the value is not an integer
   */
  intColumn(name: string, value: number | null | undefined): SenderBuffer {
    this.validateColumnCall(name);
    // A null or undefined value omits the column entirely (see issue #28).
    if (this.isNullOrUndefined(value)) {
      return this.omitColumn();
    }
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

  protected abstract writeTimestamp(
    timestamp: number | bigint,
    unit: TimestampUnit,
    designated: boolean,
  ): void;

  /**
   * Writes a timestamp column and its value into the buffer.
   *
   * Use this method to insert data into `TIMESTAMP` or `TIMESTAMP_NS` columns.
   *
   * **Precision rules**:
   * - **Protocol v2 and higher:**
   *   Timestamps passed with unit `'ns'` (nanoseconds) are sent with full nanosecond precision.
   *   All other timestamps are sent with microsecond precision.
   * - **Protocol v1:**
   *   Always uses microsecond precision, even if the timestamp is specified in nanoseconds.
   *
   * @param {string} name - The column name.
   * @param {number | bigint | null | undefined} value - The epoch timestamp. Must be an integer or a `BigInt`. A null or undefined value omits the column entirely (stored as NULL).
   * @param {'ns' | 'us' | 'ms'} [unit='us'] - The time unit of the timestamp.
   * Supported values:
   *   - `'ns'` — nanoseconds (requires `BigInt`)
   *   - `'us'` — microseconds *(default)*
   *   - `'ms'` — milliseconds
   *
   * @returns {SenderBuffer} Returns with a reference to this buffer.
   *
   * @throws {Error} If `unit` is not one of `'ns'`, `'us'`, or `'ms'` (checked
   * even when `value` is null or undefined).
   * @throws {Error} If `value` is not an integer or `BigInt`.
   * @throws {Error} If `unit` is `'ns'` but `value` is not a `BigInt`.
   */
  timestampColumn(
    name: string,
    value: number | bigint | null | undefined,
    unit: TimestampUnit = "us",
  ): SenderBuffer {
    this.validateColumnCall(name);
    // The unit describes how to read the timestamp, not this row's value, so a
    // bad unit is rejected before the value is: otherwise it is only reported
    // on rows that carry a value and stays silent on the ones that omit it.
    // (Same principle as the scale check in SenderBufferV3.decimalColumn; the
    // ns/BigInt rule below stays value-dependent, as null omits the column.)
    this.validateTimestampUnit(unit);
    // A null or undefined value omits the column entirely (see issue #28).
    if (this.isNullOrUndefined(value)) {
      return this.omitColumn();
    }
    if (typeof value !== "bigint" && !Number.isInteger(value)) {
      throw new Error(
        `Timestamp value must be an integer or BigInt, received ${value}`,
      );
    }
    if (unit == "ns" && typeof value !== "bigint") {
      throw new Error(
        `Timestamp value must be a BigInt if it is set in nanoseconds`,
      );
    }
    this.writeColumn(name, value, () =>
      this.writeTimestamp(value, unit, false),
    );
    return this;
  }

  /**
   * Closes the row after writing the designated timestamp into the buffer.
   *
   * **Precision rules**:
   * - **Protocol v2 and higher:**
   *   Timestamps passed with unit `'ns'` (nanoseconds) are sent with full nanosecond precision.
   *   All other timestamps are sent with microsecond precision.
   * - **Protocol v1:**
   *   Always uses microsecond precision, even if the timestamp is specified in nanoseconds.
   *
   * @param {number | bigint} timestamp - Designated epoch timestamp. Must be an integer or a `BigInt`.
   * @param {'ns' | 'us' | 'ms'} [unit='us'] - The time unit of the timestamp.
   * Supported values:
   *   - `'ns'` — nanoseconds (requires `BigInt`)
   *   - `'us'` — microseconds *(default)*
   *   - `'ms'` — milliseconds
   *
   * @returns {SenderBuffer} Returns with a reference to this buffer.
   *
   * @throws {Error} If `timestamp` is not an integer or `BigInt`.
   * @throws {Error} If `unit` is `'ns'` but `timestamp` is not a `BigInt`.
   * @throws {Error} If `unit` is not one of `'ns'`, `'us'`, or `'ms'`. This
   * validation leaves the open row unchanged so the call can be retried.
   * @throws {Error} If the row cannot be closed within `max_buf_size`. The
   * partial close is rewound, so the same call succeeds once a `flush()` frees
   * space.
   */
  at(timestamp: number | bigint, unit: TimestampUnit = "us") {
    // The unit is a call-site parameter, so reject it before attempting to
    // close (and potentially discard) the row. This also avoids writing the
    // timestamp separator before discovering that the unit is invalid.
    this.validateTimestampUnit(unit);
    try {
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
      if (unit == "ns" && typeof timestamp !== "bigint") {
        throw new Error(
          `Designated timestamp must be a BigInt if it is set in nanoseconds`,
        );
      }
    } catch (error) {
      this.discardIncompleteRow();
      throw error;
    }
    // A full buffer is not a malformed row: the row is still intact and a
    // flush() that frees space lets the same at() succeed -- which is what
    // happened before the discard contract existed. Discarding here dropped a
    // fully built row and then reported "The row must have a symbol or column
    // set before it is closed" on the retry, naming the wrong problem
    // entirely.
    //
    // This reservation covers the separator only; writeTimestamp() reserves
    // its own digits and is where a full buffer actually throws, one byte into
    // the close. Rewinding is what makes that retryable, so the reservation
    // cannot carry the guarantee on its own.
    this.checkCapacity([], 1);
    const startOfClose = this.position;
    try {
      this.write(" ");
      this.writeTimestamp(timestamp, unit, true);
      this.write("\n");
      this.startNewRow();
    } catch (error) {
      // Everything the close writes lives at or above startOfClose, and the
      // row's own bytes below it are untouched, so rewinding restores exactly
      // the state before this call. A half-encoded close leaves nothing behind
      // to discard the row over.
      this.position = startOfClose;
      throw error;
    }
  }

  /**
   * Closes the row without writing designated timestamp into the buffer. <br>
   * Designated timestamp will be populated by the server on this record.
   */
  atNow() {
    try {
      if (!this.hasSymbols && !this.hasColumns) {
        throw new Error(
          "The row must have a symbol or column set before it is closed",
        );
      }
    } catch (error) {
      this.discardIncompleteRow();
      throw error;
    }
    // See at(): a capacity failure leaves the row intact and retryable after a
    // flush, so it must not discard. The reservation covers this whole close,
    // which is one byte, but the rewind keeps both closers under one rule.
    this.checkCapacity([], 1);
    const startOfClose = this.position;
    try {
      this.write("\n");
      this.startNewRow();
    } catch (error) {
      this.position = startOfClose;
      throw error;
    }
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
   * @ignore
   * Compacts the buffer by removing completed rows.
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
   * @ignore
   * Determines whether a column value is null or undefined. <br>
   * Such values cause the column (or symbol) to be omitted from the row
   * entirely, which QuestDB records as NULL. This mirrors the Python client
   * and resolves https://github.com/questdb/nodejs-questdb-client/issues/28
   *
   * @param value - The column or symbol value to test.
   * @returns True if the value is null or undefined.
   */
  protected isNullOrUndefined(value: unknown): value is null | undefined {
    return value === null || value === undefined;
  }

  /**
   * @ignore
   * Validates everything about a column call that does not depend on its
   * value. Every setter runs this before testing the value for nullish, so a
   * malformed name or a misplaced call is reported whether or not this
   * particular row happens to carry a value for that column -- otherwise the
   * same call site raises on some rows and stays silent on others, and a
   * misspelled or over-long name first surfaces in production, on the row that
   * happens to be populated.
   *
   * It deliberately does not mark {@link hasColumnCall}: a call that throws
   * contributed nothing to the row, so it must not close the symbol section.
   * See {@link omitColumn} and {@link writeColumn}, which mark it once the
   * call is known to write or to deliberately omit.
   *
   * @param name - The column name to validate.
   */
  protected validateColumnCall(name: string): void {
    if (typeof name !== "string") {
      throw new Error(`Column name must be a string, received ${typeof name}`);
    }
    if (!this.hasTable) {
      throw new Error("Column can be set only after table name is set");
    }
    validateColumnName(name, this.maxNameLength);
  }

  /**
   * @ignore
   * Records a column call that deliberately wrote nothing, and returns the
   * buffer so setters can `return this.omitColumn()`.
   *
   * A nullish value omits the column but still moves the caller past the
   * symbol section, so the ordering rule has to count it. A call that *threw*
   * did not, which is why the flag is set here rather than in
   * {@link validateColumnCall}: marking it up front closed the symbol section
   * on rejected calls too, so a caller that caught the error and fell back to
   * symbol() -- probing arrayColumn() on protocol v1, say -- got a second,
   * unrelated "Symbol can be added only after table name is set" failure.
   */
  protected omitColumn(): SenderBuffer {
    this.hasColumnCall = true;
    return this;
  }

  /**
   * @ignore
   * The symbol equivalent of {@link validateColumnCall}. Symbols carry an
   * extra ordering rule: they must precede every column on the row.
   *
   * The rule is enforced against {@link hasColumnCall}, not {@link hasColumns},
   * so it does not depend on this row's data. Testing the written-bytes flag
   * let the same call site pass whenever the preceding column happened to be
   * nullish and throw whenever it carried a value -- the exact data-dependent
   * validation {@link validateColumnCall} exists to avoid.
   *
   * @param name - The symbol name to validate.
   */
  protected validateSymbolCall(name: string): void {
    if (typeof name !== "string") {
      throw new Error(`Symbol name must be a string, received ${typeof name}`);
    }
    if (!this.hasTable || this.hasColumnCall) {
      throw new Error(
        "Symbol can be added only after table name is set and before any column added",
      );
    }
    validateColumnName(name, this.maxNameLength);
  }

  /**
   * @ignore
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
    // The name and row-state checks ran in validateColumnCall(), which every
    // setter calls before deciding whether the value is nullish. Repeating
    // validateColumnName() here would rescan the name on every cell.
    if (valueType && typeof value !== valueType) {
      throw new Error(
        `Column value must be of type ${valueType}, received ${typeof value}`,
      );
    }
    // checkCapacity() is the last thing that can reject before a byte is
    // written -- a full buffer at max_buf_size throws here -- so the flag has
    // to be set after it, not before. Setting it first closed the symbol
    // section on a call that contributed nothing, and the row then could not
    // be closed at all: symbol() raised the ordering error and at()/atNow()
    // raised "The row must have a symbol or column set before it is closed",
    // neither of which named the full buffer that actually stopped the call.
    this.checkCapacity([name], 2 + name.length);
    // Past every check that can reject the call: this one writes.
    this.hasColumnCall = true;
    this.write(this.hasColumns ? "," : " ");
    this.writeEscaped(name);
    this.write("=");
    writeValue();
    this.hasColumns = true;
  }

  /**
   * @ignore
   * Writes string data to the buffer at the current position.
   * @param data - String data to write
   */
  protected write(data: string) {
    this.position += this.buffer.write(data, this.position);
  }

  /**
   * @ignore
   * Writes a single byte to the buffer at the current position.
   * @param data - Byte value to write
   */
  protected writeByte(data: number) {
    this.position = this.buffer.writeInt8(data, this.position);
  }

  /**
   * @ignore
   * Writes a 32-bit integer to the buffer in little-endian format.
   * @param data - Integer value to write
   */
  protected writeInt(data: number) {
    this.position = this.buffer.writeInt32LE(data, this.position);
  }

  /**
   * @ignore
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

  /* eslint-disable @typescript-eslint/no-unused-vars */
  /**
   * Writes a decimal value into the buffer using its text format.
   *
   * Use it to insert into DECIMAL database columns.
   *
   * Decimals are not supported by protocol v1/v2, so this base implementation
   * rejects the call even when the value is null or undefined. Protocol v3
   * overrides this with a validating implementation.
   *
   * @param {string} name - Column name.
   * @param {string | number | null | undefined} value - The decimal value to
   * write.
   * @returns {SenderBuffer} Returns with a reference to this buffer.
   * @throws {Error} Indicating decimals are not supported in protocol v1/v2.
   */
  decimalColumnText(
    name: string,
    value: string | number | null | undefined,
  ): SenderBuffer {
    this.validateColumnCall(name);
    throw new Error("Decimals are not supported in protocol v1/v2");
  }

  /**
   * Writes a decimal value into the buffer using its binary format.
   *
   * Use it to insert into DECIMAL database columns.
   *
   * Decimals are not supported by protocol v1/v2, so this base implementation
   * rejects the call even when the value is null or undefined. Protocol v3
   * overrides this with a validating implementation.
   *
   * @param {string} name - Column name.
   * @param {bigint | Int8Array | null | undefined} unscaled - The unscaled
   * integer portion of the decimal value.
   * @param {number} scale - The number of fractional digits (the scale) of the decimal value.
   * @returns {SenderBuffer} Returns with a reference to this buffer.
   * @throws {RangeError} If `scale` is not between 0 and 76. Scale validation
   * runs even when `unscaled` is null or undefined.
   * @throws {Error} Indicating decimals are not supported in protocol v1/v2.
   */
  decimalColumn(
    name: string,
    unscaled: bigint | Int8Array | null | undefined,
    scale: number,
  ): SenderBuffer {
    this.validateColumnCall(name);
    // The scale describes the column, not this row's value. Keep its validation
    // consistent with protocol v3 even though v1/v2 reject the decimal API.
    if (scale < 0 || scale > 76) {
      throw new RangeError("Scale must be between 0 and 76");
    }
    throw new Error("Decimals are not supported in protocol v1/v2");
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */
}

export { SenderBufferBase };
