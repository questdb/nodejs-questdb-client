// @ts-check
import { SenderOptions } from "../options";
import { SenderBuffer } from "./index";
import { SenderBufferBase } from "./base";
import { getDimensions, validateArray } from "../utils";

const COLUMN_TYPE_DOUBLE: number = 10;
const COLUMN_TYPE_NULL: number = 33;

const ENTITY_TYPE_ARRAY: number = 14;
const ENTITY_TYPE_DOUBLE: number = 16;

const EQUALS_SIGN: number = "=".charCodeAt(0);

/**
 * Buffer implementation for protocol version 2.
 * Sends floating point numbers in binary form.
 */
class SenderBufferV2 extends SenderBufferBase {
  constructor(options: SenderOptions) {
    super(options);
  }

  /**
   * Writes a float column with its value into the buffer using v2 serialization (binary format).
   *
   * @param {string} name - Column name.
   * @param {number} value - Column value, accepts only number values.
   * @return {Sender} Returns with a reference to this sender.
   */
  floatColumn(name: string, value: number): SenderBuffer {
    this.writeColumn(
      name,
      value,
      () => {
        this.checkCapacity([], 10);
        this.writeByte(EQUALS_SIGN);
        this.writeByte(ENTITY_TYPE_DOUBLE);
        this.writeDouble(value);
      },
      "number",
    );
    return this;
  }

  arrayColumn(name: string, value: unknown[]): SenderBuffer {
    const dimensions = getDimensions(value);
    const type = validateArray(value, dimensions);
    // only number arrays and NULL supported for now
    if (type !== "number" && type !== null) {
      throw new Error(`Unsupported array type [type=${type}]`);
    }

    this.writeColumn(name, value, () => {
      this.checkCapacity([], 3);
      this.writeByte(EQUALS_SIGN);
      this.writeByte(ENTITY_TYPE_ARRAY);

      if (!value) {
        this.writeByte(COLUMN_TYPE_NULL);
      } else {
        this.writeByte(COLUMN_TYPE_DOUBLE);
        this.writeArray(value, dimensions, type);
      }
    });
    return this;
  }
}

export { SenderBufferV2 };
