// @ts-check
import { SenderOptions } from "../options";
import { SenderBuffer } from "./index";
import { SenderBufferBase } from "./base";
import { ArrayPrimitive, getDimensions, validateArray } from "../utils";

// Column type constants for protocol v2.
const COLUMN_TYPE_DOUBLE: number = 10;
const COLUMN_TYPE_NULL: number = 33;

// Entity type constants for protocol v2.
const ENTITY_TYPE_ARRAY: number = 14;
const ENTITY_TYPE_DOUBLE: number = 16;

// ASCII code for equals sign used in binary protocol.
const EQUALS_SIGN: number = "=".charCodeAt(0);

/**
 * Buffer implementation for protocol version 2,
 * extends the {@link SenderBufferBase} abstract base class.
 * Sends floating point numbers in binary form, and provides support for arrays.
 */
class SenderBufferV2 extends SenderBufferBase {
  /**
   * Creates a new SenderBufferV2 instance.
   *
   * @param {SenderOptions} options - Sender configuration object. <br>
   * See SenderOptions documentation for detailed description of configuration options.
   */
  constructor(options: SenderOptions) {
    super(options);
  }

  /**
   * Writes a 64-bit floating point value into the buffer using v2 serialization (binary format). <br>
   * Use it to insert into DOUBLE or FLOAT database columns.
   *
   * @param {string} name - Column name.
   * @param {number} value - Column value, accepts only number values.
   * @returns {Sender} Returns with a reference to this buffer.
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
   *
   * @param {string} name - Column name
   * @param {unknown[]} value - Array values to write (currently supports double arrays)
   * @returns {Sender} Returns with a reference to this buffer.
   * @throws Error if array validation fails:
   * - value is not an array
   * - or the shape of the array is irregular: the length of sub-arrays are different
   * - or the array is not homogeneous: its elements are not all the same type
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

  private writeArray(
    arr: unknown[],
    dimensions: number[],
    type: ArrayPrimitive,
  ) {
    this.checkCapacity([], 1 + dimensions.length * 4);
    this.writeByte(dimensions.length);
    for (let i = 0; i < dimensions.length; i++) {
      this.writeInt(dimensions[i]);
    }

    this.checkCapacity([], SenderBufferV2.arraySize(dimensions, type));
    this.writeArrayValues(arr, dimensions);
  }

  private writeArrayValues(arr: unknown[], dimensions: number[]) {
    if (Array.isArray(arr[0])) {
      for (let i = 0; i < arr.length; i++) {
        this.writeArrayValues(arr[i] as unknown[], dimensions);
      }
    } else {
      const type = arr[0] !== undefined ? typeof arr[0] : null;
      switch (type) {
        case "number":
          for (let i = 0; i < arr.length; i++) {
            this.position = this.buffer.writeDoubleLE(
              arr[i] as number,
              this.position,
            );
          }
          break;
        case null:
          // empty array
          break;
        default:
          throw new Error(`Unsupported array type [type=${type}]`);
      }
    }
  }

  private static arraySize(dimensions: number[], type: ArrayPrimitive): number {
    let numOfElements = 1;
    for (let i = 0; i < dimensions.length; i++) {
      numOfElements *= dimensions[i];
    }

    switch (type) {
      case "number":
        return numOfElements * 8;
      case "boolean":
        return numOfElements;
      case "string":
        // in case of string[] capacity check is done separately for each array element
        return 0;
      case null:
        // empty array
        return 0;
      default:
        throw new Error(`Unsupported array type [type=${type}]`);
    }
  }
}

export { SenderBufferV2 };
