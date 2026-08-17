import { Decompress } from "fzstd";
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

function frameWithProbeContentSize(
  frame: Uint8Array,
  info: ZstdFrameInfo,
): Uint8Array {
  // fzstd uses the frame content size as its output allocation and otherwise
  // truncates a corrupt frame whose real output is larger. Reframe the same
  // blocks with one extra byte of capacity so our callback can detect that
  // overflow. A single-segment window of expected size + 1 is sufficient for
  // all valid frames because no match can refer before the decoded content.
  const headerSize = 4 + 1 + 8;
  const blocks = frame.subarray(info.dataOffset);
  const probe = new Uint8Array(headerSize + blocks.byteLength);
  probe.set(frame.subarray(0, 4));
  probe[4] = 0xe0 | (info.checksum ? 0x04 : 0);
  let size = BigInt(info.contentSize + 1);
  for (let index = 0; index < 8; index++) {
    probe[5 + index] = Number(size & 0xffn);
    size >>= 8n;
  }
  probe.set(blocks, headerSize);
  return probe;
}

/** Decompresses the single bounded Zstd frame carried by a RESULT_BATCH. */
export function decompressQwpZstdFrame(frame: Uint8Array): Uint8Array {
  const info = inspectZstdFrame(frame);
  validateSingleZstdFrame(frame, info);
  const probeFrame = frameWithProbeContentSize(frame, info);
  const output = new Uint8Array(info.contentSize);
  let written = 0;
  try {
    const decoder = new Decompress((chunk) => {
      if (written + chunk.byteLength > output.byteLength) {
        throw new QwpProtocolError(
          `zstd output exceeds declared content size ${info.contentSize}`,
        );
      }
      output.set(chunk, written);
      written += chunk.byteLength;
    });
    decoder.push(probeFrame, true);
  } catch (error) {
    if (error instanceof QwpProtocolError) throw error;
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new QwpProtocolError(`zstd decompression failed${detail}`);
  }
  if (written !== info.contentSize) {
    throw new QwpProtocolError(
      `zstd decompressed size ${written} does not match frame content size ${info.contentSize}`,
    );
  }
  return output;
}
