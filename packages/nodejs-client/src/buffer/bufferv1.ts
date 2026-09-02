// @ts-check
import { SenderOptions } from "../options";
import { SenderBuffer } from "./index";
import { SenderBufferBase } from "./base";
import { timestampToMicros, timestampToNanos, TimestampUnit } from "../utils";

/**
 * Buffer implementation for protocol version 1. <br>
 * Sends floating point numbers in their text form.
 */
class SenderBufferV1 extends SenderBufferBase {
  /**
   * Creates a new SenderBufferV1 instance.
   *
   * @param {SenderOptions} options - Sender configuration object. <br>
   * See SenderOptions documentation for detailed description of configuration options.
   */
  constructor(options: SenderOptions) {
    super(options);
  }

  /**
   * Writes a 64-bit floating point value into the buffer using v1 serialization (text format). <br>
   * Use it to insert into DOUBLE or FLOAT database columns.
   *
   * @param {string} name - Column name.
   * @param {number | null | undefined} value - Column value, accepts only number values. A null or undefined value omits the column entirely (stored as NULL).
   * @return {Sender} Returns with a reference to this sender.
   */
  floatColumn(name: string, value: number | null | undefined): SenderBuffer {
    this.validateColumnCall(name);
    // A null or undefined value omits the column entirely (see issue #28).
    if (this.isNullOrUndefined(value)) {
      return this.omitColumn();
    }
    this.writeColumn(
      name,
      value,
      () => {
        const valueStr = value.toString();
        this.checkCapacity([valueStr]);
        this.write(valueStr);
      },
      "number",
    );
    return this;
  }

  protected writeTimestamp(
    timestamp: number | bigint,
    unit: TimestampUnit = "us",
    designated: boolean,
  ): void {
    const biValue = BigInt(timestamp);
    const timestampValue = designated
      ? timestampToNanos(biValue, unit)
      : timestampToMicros(biValue, unit);
    const timestampStr = timestampValue.toString();
    this.checkCapacity([timestampStr], 2);
    this.write(timestampStr);
    if (!designated) {
      this.write("t");
    }
  }

  /* eslint-disable @typescript-eslint/no-unused-vars */
  /**
   * Array columns are not supported in protocol v1. <br>
   * The capability check applies even when the value is null or undefined.
   *
   * @param {string} name - Column name.
   * @param {unknown[] | null | undefined} value - Array values.
   * @returns {SenderBuffer} Returns with a reference to this buffer.
   * @throws Error indicating arrays are not supported in v1
   */
  arrayColumn(name: string, value: unknown[] | null | undefined): SenderBuffer {
    this.validateColumnCall(name);
    throw new Error("Arrays are not supported in protocol v1");
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */
}

export { SenderBufferV1 };
