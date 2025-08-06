// @ts-check
import { SenderOptions } from "../options";
import { SenderBuffer } from "./index";
import { SenderBufferBase } from "./base";
import { ArrayPrimitive, getDimensions, validateArray } from "../utils";

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
      const type = typeof arr[0];
      switch (type) {
        case "number":
          for (let i = 0; i < arr.length; i++) {
            this.position = this.buffer.writeDoubleLE(
              arr[i] as number,
              this.position,
            );
          }
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
      default:
        throw new Error(`Unsupported array type [type=${type}]`);
    }
  }
}

export { SenderBufferV2 };
