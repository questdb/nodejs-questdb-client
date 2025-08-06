// @ts-check
import { SenderOptions } from "../options";
import { SenderBuffer } from "./index";
import { SenderBufferBase } from "./base";

/**
 * Buffer implementation for protocol version 1.
 * Sends floating point numbers in their text form.
 */
class SenderBufferV1 extends SenderBufferBase {
  /**
   * Creates a new SenderBufferV1 instance.
   * @param options - Sender configuration options
   */
  constructor(options: SenderOptions) {
    super(options);
  }

  /**
   * Writes a float column with its value into the buffer using v1 serialization (text format).
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
        const valueStr = value.toString();
        this.checkCapacity([valueStr]);
        this.write(valueStr);
      },
      "number",
    );
    return this;
  }

  /**
   * Array columns are not supported in protocol v1.
   * @throws Error indicating arrays are not supported in v1
   */
  arrayColumn(): SenderBuffer {
    throw new Error("Arrays are not supported in protocol v1");
  }
}

export { SenderBufferV1 };
