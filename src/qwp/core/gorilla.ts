import { QwpByteWriter } from "./bytes";

const INT32_MIN = -2147483648n;
const INT32_MAX = 2147483647n;

class QwpBitWriter {
  private readonly bytes: Uint8Array;
  private byteIndex = 0;
  private bitIndex = 0;

  constructor(capacity: number) {
    this.bytes = new Uint8Array(capacity);
  }

  writeBits(value: number, count: number): void {
    for (let index = 0; index < count; index++) {
      if ((value >>> index) & 1) {
        this.bytes[this.byteIndex] |= 1 << this.bitIndex;
      }
      this.bitIndex++;
      if (this.bitIndex === 8) {
        this.bitIndex = 0;
        this.byteIndex++;
      }
    }
  }

  finish(): Uint8Array {
    const length = this.byteIndex + (this.bitIndex > 0 ? 1 : 0);
    return this.bytes.slice(0, length);
  }
}

function encodedDeltaBits(deltaOfDelta: bigint): number {
  if (deltaOfDelta === 0n) return 1;
  if (deltaOfDelta >= -64n && deltaOfDelta <= 63n) return 9;
  if (deltaOfDelta >= -256n && deltaOfDelta <= 255n) return 12;
  if (deltaOfDelta >= -2048n && deltaOfDelta <= 2047n) return 16;
  return 36;
}

/** Encoded byte count, or -1 when a delta-of-delta leaves int32 range. */
export function qwpGorillaSize(timestamps: readonly bigint[]): number {
  if (timestamps.length === 0) return 0;
  if (timestamps.length === 1) return 8;
  if (timestamps.length === 2) return 16;
  let previousTimestamp = timestamps[1];
  let previousDelta = timestamps[1] - timestamps[0];
  let bits = 0;
  for (let index = 2; index < timestamps.length; index++) {
    const delta = timestamps[index] - previousTimestamp;
    const deltaOfDelta = delta - previousDelta;
    if (deltaOfDelta < INT32_MIN || deltaOfDelta > INT32_MAX) return -1;
    bits += encodedDeltaBits(deltaOfDelta);
    previousDelta = delta;
    previousTimestamp = timestamps[index];
  }
  return 16 + Math.ceil(bits / 8);
}

/** Encodes timestamps with the QWP LSB-first Gorilla variant. */
export function encodeQwpGorilla(timestamps: readonly bigint[]): Uint8Array {
  const size = qwpGorillaSize(timestamps);
  if (size < 0) {
    throw new Error("Gorilla delta-of-delta is outside the int32 range");
  }
  const writer = new QwpByteWriter(Math.max(size, 1));
  if (timestamps.length === 0) return writer.toUint8Array();
  writer.writeBigInt64(timestamps[0]);
  if (timestamps.length === 1) return writer.toUint8Array();
  writer.writeBigInt64(timestamps[1]);
  if (timestamps.length === 2) return writer.toUint8Array();

  const bits = new QwpBitWriter(size - 16);
  let previousTimestamp = timestamps[1];
  let previousDelta = timestamps[1] - timestamps[0];
  for (let index = 2; index < timestamps.length; index++) {
    const delta = timestamps[index] - previousTimestamp;
    const deltaOfDelta = delta - previousDelta;
    // Prefixes are bit-reversed because QWP packs bits least-significant first.
    if (deltaOfDelta === 0n) {
      bits.writeBits(0, 1);
    } else if (deltaOfDelta >= -64n && deltaOfDelta <= 63n) {
      bits.writeBits(0b01, 2);
      bits.writeBits(Number(deltaOfDelta & 0x7fn), 7);
    } else if (deltaOfDelta >= -256n && deltaOfDelta <= 255n) {
      bits.writeBits(0b011, 3);
      bits.writeBits(Number(deltaOfDelta & 0x1ffn), 9);
    } else if (deltaOfDelta >= -2048n && deltaOfDelta <= 2047n) {
      bits.writeBits(0b0111, 4);
      bits.writeBits(Number(deltaOfDelta & 0xfffn), 12);
    } else {
      bits.writeBits(0b1111, 4);
      bits.writeBits(Number(deltaOfDelta & 0xffffffffn), 32);
    }
    previousDelta = delta;
    previousTimestamp = timestamps[index];
  }
  writer.writeBytes(bits.finish());
  return writer.toUint8Array();
}
