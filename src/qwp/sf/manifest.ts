import { Buffer } from "node:buffer";
import { writeBoundary, readBoundary, BOUNDARY_FILE_SIZE } from "./boundary";

/**
 * SfManifest (spec 8.2, 8.1.1) — the crash-safe boundary record that lets
 * recovery cross-check the scanned segment chain head against a recorded head.
 *
 * Same alternating-generation scheme as `.ack-watermark`: an 8 KiB file holding
 * two independently CRC-protected 64-byte records at offsets 0 and 4096. Writes
 * alternate between the slots by generation parity; recovery keeps the valid
 * record with the greatest generation, falling back to no manifest when neither
 * validates or the file is absent.
 *
 * The recorded value is the chain head — the `baseSeq` of the newest (active)
 * segment. Spec 8.1.1: "the chain head must match the manifest's recorded head".
 */
export const MANIFEST_FILE_NAME = "sf-manifest.bin";
/** 'SFM1' as little-endian u32 (spec 8.2). */
export const SFM1_MAGIC = 0x314d4653;

export interface ManifestRecord {
  generation: number;
  /** Recorded chain head = baseSeq of the active segment. */
  headBaseSeq: number;
}

/** Writes the manifest into an 8 KiB buffer, alternating slots by generation. */
export function writeManifest(
  buf: Buffer,
  generation: number,
  headBaseSeq: number,
): void {
  writeBoundary(buf, generation, BigInt(headBaseSeq), SFM1_MAGIC);
}

/** Reads the manifest; returns null when absent or neither record validates. */
export function readManifest(buf: Buffer): ManifestRecord | null {
  const b = readBoundary(buf, SFM1_MAGIC);
  return b ? { generation: b.generation, headBaseSeq: Number(b.value) } : null;
}

export { BOUNDARY_FILE_SIZE as MANIFEST_FILE_SIZE };
