// @ts-check
import { SenderOptions } from "../options";
import { SenderBuffer } from "./index";
import { SenderBufferBase } from "./base";

const COLUMN_TYPE_DOUBLE: number = 10;
const COLUMN_TYPE_NULL: number = 33;

const ENTITY_TYPE_ARRAY: number = 14;
const ENTITY_TYPE_DOUBLE: number = 16;

const EQUALS_SIGN: number = "=".charCodeAt(0);

class SenderBufferV2 extends SenderBufferBase {
  constructor(options: SenderOptions) {
    super(options);
  }

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
    if (value !== null && value !== undefined && !Array.isArray(value)) {
      throw new Error(`The value must be an array [value=${JSON.stringify(value)}, type=${typeof value}]`);
    }
    this.writeColumn(name, value, () => {
      this.checkCapacity([], 3);
      this.writeByte(EQUALS_SIGN);
      this.writeByte(ENTITY_TYPE_ARRAY);

      if (!value) {
        this.writeByte(COLUMN_TYPE_NULL);
      } else {
        this.writeByte(COLUMN_TYPE_DOUBLE);
        this.writeArray(value);
      }
    });
    return this;
  }
}

export { SenderBufferV2 };
