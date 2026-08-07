import { Buffer } from "node:buffer";
import { crc32c } from "./crc32c";

export const SEGMENT_MAGIC = Buffer.from("SF01", "ascii");
export const SEGMENT_HEADER_SIZE = 24;
export const FRAME_HEADER_SIZE = 8;

export interface ScanResult {
  baseSeq: number;
  frames: Buffer[];
  /** Bytes of non-zero residue after the last valid frame. 0 = clean fill. */
  tornTailBytes: number;
  /** Offset where the next append must start. */
  appendOffset: number;
}

export function buildSegment(baseSeq: number, frames: Buffer[], capacity: number): Buffer {
  const buf = Buffer.alloc(capacity);
  SEGMENT_MAGIC.copy(buf, 0);
  buf.writeUInt8(1, 4); // version
  buf.writeUInt8(0, 5); // flags
  buf.writeUInt16LE(0, 6); // reserved
  buf.writeBigUInt64LE(BigInt(baseSeq), 8);
  buf.writeBigUInt64LE(0n, 16); // createdMicros; stamped by the caller if needed
  let o = SEGMENT_HEADER_SIZE;
  for (const f of frames) o = appendFrame(buf, o, f);
  return buf;
}

/** Returns the new offset, or -1 when the frame does not fit. */
export function appendFrame(buf: Buffer, offset: number, payload: Buffer): number {
  const need = FRAME_HEADER_SIZE + payload.length;
  if (offset + need > buf.length) return -1;
  // CRC covers (payloadLen, payload) together -- not the payload alone.
  const lenAndPayload = Buffer.allocUnsafe(4 + payload.length);
  lenAndPayload.writeUInt32LE(payload.length, 0);
  payload.copy(lenAndPayload, 4);
  buf.writeUInt32LE(crc32c(lenAndPayload), offset);
  buf.writeUInt32LE(payload.length, offset + 4);
  payload.copy(buf, offset + 8);
  return offset + need;
}

export function scanSegment(buf: Buffer): ScanResult {
  if (buf.length < SEGMENT_HEADER_SIZE || !buf.subarray(0, 4).equals(SEGMENT_MAGIC)) {
    throw new Error("segment: bad magic");
  }
  if (buf.readUInt8(4) !== 1) throw new Error("segment: unsupported version");
  const baseSeq = Number(buf.readBigUInt64LE(8));

  const frames: Buffer[] = [];
  let o = SEGMENT_HEADER_SIZE;
  for (;;) {
    if (o + FRAME_HEADER_SIZE > buf.length) break;
    const crc = buf.readUInt32LE(o);
    const len = buf.readUInt32LE(o + 4);
    if (len === 0 && crc === 0) break; // unwritten space
    if (o + FRAME_HEADER_SIZE + len > buf.length) break; // declared length overruns
    const lenAndPayload = buf.subarray(o + 4, o + FRAME_HEADER_SIZE + len);
    if (crc32c(lenAndPayload) !== crc) break; // first bad CRC ends the chain
    frames.push(Buffer.from(buf.subarray(o + FRAME_HEADER_SIZE, o + FRAME_HEADER_SIZE + len)));
    o += FRAME_HEADER_SIZE + len;
  }

  // Non-zero residue means a write was attempted and failed. Do NOT zero it
  // here: after a mid-file tear it can hold valid-CRC frames that are the only
  // surviving copy of real payloads (spec 8.1.5).
  let torn = 0;
  for (let i = o; i < buf.length; i++) if (buf[i] !== 0) torn++;

  return { baseSeq, frames, tornTailBytes: torn, appendOffset: o };
}
