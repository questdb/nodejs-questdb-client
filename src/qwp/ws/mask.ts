import { Buffer } from "node:buffer";
import { randomFillSync } from "node:crypto";

/** RFC 6455 §10.3 requires a fresh, unpredictable key per frame. */
export function newMaskKey(): Buffer {
  return randomFillSync(Buffer.allocUnsafe(4));
}

export function applyMask(payload: Buffer, key: Buffer): void {
  for (let i = 0; i < payload.length; i++) {
    payload[i] ^= key[i & 3];
  }
}
