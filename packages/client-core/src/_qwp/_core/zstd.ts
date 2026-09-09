import { decompress } from "fzstd";
import { QwpProtocolError } from "./errors";

/** Matches the Java client's per-connection decompression safety cap. */
export const QWP_MAX_ZSTD_DECOMPRESSED_SIZE = 64 * 1024 * 1024;

const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_MAX_BLOCK_SIZE = 128 * 1024;

interface ZstdFrameInfo {
  readonly contentSize: number;
  readonly dataOffset: number;
  readonly checksum: boolean;
}

function requireAvailable(
  bytes: Uint8Array,
  offset: number,
  length: number,
  label: string,
): void {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
    throw new QwpProtocolError(`truncated zstd ${label}`);
  }
}

function readLittleEndian(
  bytes: Uint8Array,
  offset: number,
  length: number,
): bigint {
  requireAvailable(bytes, offset, length, "frame header");
  let value = 0n;
  for (let index = 0; index < length; index++) {
    value |= BigInt(bytes[offset + index]) << BigInt(index * 8);
  }
  return value;
}

function inspectZstdFrame(frame: Uint8Array): ZstdFrameInfo {
  if (frame.byteLength > QWP_MAX_ZSTD_DECOMPRESSED_SIZE) {
    throw new QwpProtocolError(
      `zstd frame size ${frame.byteLength} exceeds client cap ${QWP_MAX_ZSTD_DECOMPRESSED_SIZE}`,
    );
  }
  requireAvailable(frame, 0, 5, "frame header");
  if (Number(readLittleEndian(frame, 0, 4)) !== ZSTD_MAGIC) {
    throw new QwpProtocolError("invalid zstd frame magic");
  }

  const descriptor = frame[4];
  if ((descriptor & 0x08) !== 0) {
    throw new QwpProtocolError("zstd frame uses its reserved descriptor bit");
  }
  const singleSegment = (descriptor & 0x20) !== 0;
  const checksum = (descriptor & 0x04) !== 0;
  const dictionaryIdFlag = descriptor & 0x03;
  const contentSizeFlag = descriptor >>> 6;
  let offset = 5;

  let windowSize: bigint | undefined;
  if (!singleSegment) {
    requireAvailable(frame, offset, 1, "window descriptor");
    const windowDescriptor = frame[offset++];
    const base = 1n << BigInt(10 + (windowDescriptor >>> 3));
    windowSize = base + (base >> 3n) * BigInt(windowDescriptor & 0x07);
  }

  const dictionaryIdSize = dictionaryIdFlag === 3 ? 4 : dictionaryIdFlag;
  requireAvailable(frame, offset, dictionaryIdSize, "dictionary ID");
  if (dictionaryIdSize !== 0) {
    throw new QwpProtocolError(
      "zstd frames using an external dictionary are not supported",
    );
  }
  offset += dictionaryIdSize;

  const contentSizeBytes =
    contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
  if (contentSizeBytes === 0) {
    throw new QwpProtocolError(
      "zstd frame is missing its declared content size",
    );
  }
  let contentSize = readLittleEndian(frame, offset, contentSizeBytes);
  offset += contentSizeBytes;
  if (contentSizeFlag === 1) contentSize += 256n;

  const cap = BigInt(QWP_MAX_ZSTD_DECOMPRESSED_SIZE);
  if (contentSize > cap) {
    throw new QwpProtocolError(
      `zstd frame content size ${contentSize} exceeds client cap ${cap}`,
    );
  }
  if (windowSize !== undefined && windowSize > cap) {
    throw new QwpProtocolError(
      `zstd frame window size ${windowSize} exceeds client cap ${cap}`,
    );
  }
  return { contentSize: Number(contentSize), dataOffset: offset, checksum };
}

function validateSingleZstdFrame(frame: Uint8Array, info: ZstdFrameInfo): void {
  let offset = info.dataOffset;
  let lastBlock = false;
  while (!lastBlock) {
    requireAvailable(frame, offset, 3, "block header");
    const header =
      frame[offset] | (frame[offset + 1] << 8) | (frame[offset + 2] << 16);
    offset += 3;
    lastBlock = (header & 1) !== 0;
    const blockType = (header >>> 1) & 0x03;
    if (blockType === 3) {
      throw new QwpProtocolError("zstd frame contains a reserved block type");
    }
    const blockSize = header >>> 3;
    if (blockSize > ZSTD_MAX_BLOCK_SIZE) {
      throw new QwpProtocolError(
        `zstd block size ${blockSize} exceeds format maximum ${ZSTD_MAX_BLOCK_SIZE}`,
      );
    }
    const encodedSize = blockType === 1 ? 1 : blockSize;
    requireAvailable(frame, offset, encodedSize, "block body");
    offset += encodedSize;
  }
  if (info.checksum) {
    requireAvailable(frame, offset, 4, "content checksum");
    offset += 4;
  }
  if (offset !== frame.byteLength) {
    throw new QwpProtocolError(
      `zstd body must contain exactly one frame [frameBytes=${offset}, actual=${frame.byteLength}]`,
    );
  }
}

interface ZstdSizeError {
  readonly actual?: unknown;
  readonly declared?: unknown;
}

/** Decompresses the single bounded Zstd frame carried by a RESULT_BATCH. */
export function decompressQwpZstdFrame(frame: Uint8Array): Uint8Array {
  const info = inspectZstdFrame(frame);
  validateSingleZstdFrame(frame, info);
  try {
    // The patched one-shot decoder writes directly into its bounded output and
    // verifies its exact write offset without the streaming decoder's window
    // shifts or a caller-provided output buffer.
    return decompress(frame);
  } catch (error) {
    const sizeError = error as ZstdSizeError;
    if (
      typeof sizeError.actual === "number" &&
      typeof sizeError.declared === "number"
    ) {
      throw new QwpProtocolError(
        sizeError.actual > sizeError.declared
          ? `zstd output exceeds declared content size ${sizeError.declared} [actual=${sizeError.actual}]`
          : `zstd decompressed size ${sizeError.actual} does not match frame content size ${sizeError.declared}`,
      );
    }
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new QwpProtocolError(`zstd decompression failed${detail}`);
  }
}
