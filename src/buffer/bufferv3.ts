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
   * Creates a new SenderBufferV2 instance.
   *
   * @param {SenderOptions} options - Sender configuration object.
   *
   * See SenderOptions documentation for detailed description of configuration options.
   */
  constructor(options: SenderOptions) {
    super(options);
  }

  /**
   * Writes a decimal value into the buffer using the text format.
   *
   * Use it to insert into DECIMAL database columns.
   *
   * @param {string} name - Column name.
   * @param {number} value - Column value, accepts only number/string values.
   * @returns {Sender} Returns with a reference to this buffer.
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
    if (arr.length > 127) {
      throw new RangeError(
        "Unscaled value length must be between 0 and 127 bytes",
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
