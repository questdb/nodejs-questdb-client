import { Buffer } from "node:buffer";
import { crc32c } from "./crc32c";

export const BOUNDARY_FILE_SIZE = 8192;
const RECORD_SIZE = 64;
const SLOT_STRIDE = 4096;
const CRC_OFFSET = 60;
const MAGIC = 0x31574b41; // 'AKW1' (LE: 41 4b 57 31)

export interface Boundary {
  generation: number;
  value: bigint;
}

/** Alternates slots by generation parity; the CRC is written last. */
export function writeBoundary(buf: Buffer, generation: number, value: bigint): void {
  const slot = (generation % 2) * SLOT_STRIDE;
  buf.fill(0, slot, slot + RECORD_SIZE);
  buf.writeUInt32LE(MAGIC, slot);
  buf.writeUInt32LE(1, slot + 4);
  buf.writeBigUInt64LE(BigInt(generation), slot + 8);
  buf.writeBigInt64LE(value, slot + 16);
  const crc = crc32c(buf.subarray(slot, slot + CRC_OFFSET));
  buf.writeUInt32LE(crc, slot + CRC_OFFSET);
}

export function readBoundary(buf: Buffer): Boundary | null {
  let best: Boundary | null = null;
  for (const slot of [0, SLOT_STRIDE]) {
    if (slot + RECORD_SIZE > buf.length) continue;
    if (buf.readUInt32LE(slot) !== MAGIC) continue;
    const stored = buf.readUInt32LE(slot + CRC_OFFSET);
    if (crc32c(buf.subarray(slot, slot + CRC_OFFSET)) !== stored) continue;
    const generation = Number(buf.readBigUInt64LE(slot + 8));
    const value = buf.readBigInt64LE(slot + 16);
    if (!best || generation > best.generation) best = { generation, value };
  }
  return best;
}
