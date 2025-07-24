// @ts-check
import { SenderOptions } from "../options";
import { SenderBuffer } from "./index";
import { SenderBufferBase } from "./base";

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
}

export { SenderBufferV2 };
