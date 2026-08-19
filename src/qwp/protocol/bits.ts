import { Buffer } from "node:buffer";

/** LSB-first bit writer; trailing bits are zero-padded to a byte boundary. */
export class BitWriter {
  private readonly buf: Buffer;
  private byteIndex = 0;
  private bitIndex = 0;

  constructor(capacity: number) {
    this.buf = Buffer.alloc(capacity);
  }

  writeBits(value: number, count: number): void {
    for (let i = 0; i < count; i++) {
      if ((value >>> i) & 1) this.buf[this.byteIndex] |= 1 << this.bitIndex;
      if (++this.bitIndex === 8) {
        this.bitIndex = 0;
        this.byteIndex++;
      }
    }
  }

  finish(): Buffer {
    const len = this.byteIndex + (this.bitIndex > 0 ? 1 : 0);
    return this.buf.subarray(0, len);
  }
}
