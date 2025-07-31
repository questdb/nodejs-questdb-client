// @ts-check
import { SenderOptions } from "../options";
import { SenderBuffer } from "./index";
import { SenderBufferBase } from "./base";
import { getDimensions, validateArray } from "../utils";

// Column type constants for protocol v2.
const COLUMN_TYPE_DOUBLE: number = 10;
const COLUMN_TYPE_NULL: number = 33;

// Entity type constants for protocol v2.
const ENTITY_TYPE_ARRAY: number = 14;
const ENTITY_TYPE_DOUBLE: number = 16;

// ASCII code for equals sign used in binary protocol.
const EQUALS_SIGN: number = "=".charCodeAt(0);

/**
 * Buffer implementation for QuestDB line protocol version 2.
 * Supports all column types including arrays with binary encoding for doubles.
 */
class SenderBufferV2 extends SenderBufferBase {
  /**
   * Creates a new SenderBufferV2 instance.
   * @param options - Sender configuration options
   */
  constructor(options: SenderOptions) {
    super(options);
  }

  /**
   * Write a float column with its value into the buffer using v2 binary format.
   * @param name - Column name
   * @param value - Float value to write
   * @returns Reference to this sender buffer for method chaining
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

  /**
   * Write an array column with its values into the buffer using v2 format.
   * @param name - Column name
   * @param value - Array values to write (currently supports double arrays)
   * @returns Reference to this sender buffer for method chaining
   * @throws Error if value is not an array when provided
   */
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
