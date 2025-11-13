// @ts-check
import { SenderOptions } from "../options";
import { SenderBuffer } from "./index";
import { bigintToTwosComplementBytes } from "../utils";
import { SenderBufferV2 } from "./bufferv2";
import { validateDecimalText } from "../validation";

// Entity type constants for protocol v3.
const ENTITY_TYPE_DECIMAL: number = 23;

// ASCII code for equals sign used in binary protocol.
const EQUALS_SIGN: number = "=".charCodeAt(0);

/**
 * Buffer implementation for protocol version 3.
 *
 * Provides support for decimals.
 */
class SenderBufferV3 extends SenderBufferV2 {
  /**
   * Creates a new SenderBufferV3 instance.
   *
   * @param {SenderOptions} options - Sender configuration object.
   *
   * See SenderOptions documentation for detailed description of configuration options.
   */
  constructor(options: SenderOptions) {
    super(options);
  }

  /**
   * Writes a decimal value into the buffer using its text format.
   *
   * Use it to insert into DECIMAL database columns.
   *
   * @param {string} name - Column name.
   * @param {string | number} value - The decimal value to write.
   *   - Accepts either a `number` or a `string` containing a valid decimal representation.
   *   - String values should follow standard decimal notation (e.g., `"123.45"` or `"-0.001"`).
   * @returns {Sender} Returns with a reference to this buffer.
   * @throws Error If decimals are not supported by the buffer implementation, or validation fails.
   * Possible validation errors:
   * - The provided string is not a valid decimal representation.
   */
  decimalColumnText(name: string, value: string | number): SenderBuffer {
    let str = "";
    if (typeof value === "string") {
      validateDecimalText(value);
      str = value;
    } else if (typeof value === "number") {
      str = value.toString();
    } else {
      throw new TypeError(`Invalid decimal value type: ${typeof value}`);
    }
    this.writeColumn(name, str, () => {
      this.checkCapacity([str], 1);
      this.write(str);
      this.write("d");
    });
    return this;
  }

  /**
   * Writes a decimal value into the buffer using its binary format.
   *
   * Use it to insert into DECIMAL database columns.
   *
   * @param {string} name - Column name.
   * @param {bigint | Int8Array} unscaled - The unscaled integer portion of the decimal value.
   *   - If a `bigint` is provided, it will be converted automatically.
   *   - If an `Int8Array` is provided, it must contain the two’s complement representation
   *     of the unscaled value in **big-endian** byte order.
   *   - An empty `Int8Array` represents a `NULL` value.
   * @param {number} scale - The number of fractional digits (the scale) of the decimal value.
   * @returns {SenderBuffer} Returns with a reference to this buffer.
   * @throws {Error} If decimals are not supported by the buffer implementation, or validation fails.
   * Possible validation errors:
   * - `unscaled` length is not between 0 and 32 bytes.
   * - `scale` is not between 0 and 76.
   * - `unscaled` contains invalid bytes.
   */
  decimalColumn(
    name: string,
    unscaled: bigint | Int8Array,
    scale: number,
  ): SenderBuffer {
    if (scale < 0 || scale > 76) {
      throw new RangeError("Scale must be between 0 and 76");
    }
    let arr: number[];
    if (typeof unscaled === "bigint") {
      arr = bigintToTwosComplementBytes(unscaled);
    } else if (unscaled instanceof Int8Array) {
      arr = Array.from(unscaled);
    } else {
      throw new TypeError(
        `Invalid unscaled value type: ${typeof unscaled}, expected Int8Array or bigint`,
      );
    }
    if (arr.length > 32) {
      throw new RangeError(
        "Unscaled value length must be between 0 and 32 bytes",
      );
    }
    this.writeColumn(name, unscaled, () => {
      this.checkCapacity([], 4 + arr.length);
      this.writeByte(EQUALS_SIGN);
      this.writeByte(ENTITY_TYPE_DECIMAL);
      this.writeByte(scale);
      this.writeByte(arr.length);
      for (let i = 0; i < arr.length; i++) {
        let byte = arr[i];
        if (byte > 255 || byte < -128) {
          throw new RangeError(
            `Unscaled value contains invalid byte [index=${i}, value=${byte}]`,
          );
        }
        if (byte > 127) {
          byte -= 256;
        }
        this.writeByte(byte);
      }
    });
    return this;
  }
}

export { SenderBufferV3 };
