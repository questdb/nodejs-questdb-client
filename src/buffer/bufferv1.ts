// @ts-check
import { SenderOptions } from "../options";
import { SenderBuffer } from "./index";
import { SenderBufferBase } from "./base";

/**
 * Buffer implementation for QuestDB line protocol version 1.
 * Supports basic column types but does not support array columns.
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
   * Write a float column with its value into the buffer using v1 format.
   * @param name - Column name
   * @param value - Float value to write
   * @returns Reference to this sender buffer for method chaining
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
