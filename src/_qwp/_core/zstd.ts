import { decompress } from "fzstd";
import { QwpProtocolError } from "./errors";

/** Matches the Java client's per-connection decompression safety cap. */
export const QWP_MAX_ZSTD_DECOMPRESSED_SIZE = 64 * 1024 * 1024;

const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_MAX_BLOCK_SIZE = 128 * 1024;

/**
 * Bytes of marker appended after the declared content, and the value they
 * carry. fzstd decodes into the output buffer without reporting how far it
 * got, so the marker is how the decoded length is observed: a run this long
 * cannot be faked by a frame that stops early, because everything past what
 * the frame wrote is the untouched zero tail of the buffer.
 */
const ZSTD_SIZE_MARKER_BYTES = 8;
/**
 * The marker written past a frame's declared content size, as an eight-byte
 * raw block rather than a repeated byte.
 *
 * A run of one byte cannot say where it starts. A frame that ran long by k
 * bytes pushes the marker to contentSize + k, leaving its own k bytes in front
 * of it -- and a repeated-byte marker still matched at contentSize whenever
 * those k bytes happened to be that byte. Only min(k, 8) of them had to,
 * so overshooting by one needed a single byte with probability 1/256, and
 * 0xa5 is a legal UTF-8 continuation byte, so a VARCHAR ending in one collided
 * by accident.
 *
 * These eight bytes are distinct, so no proper prefix of the pattern equals a
 * proper suffix of it and no shift can reproduce it. The last byte is non-zero
 * so the scan for a short frame's marker still stops at the marker.
 */
const ZSTD_SIZE_MARKER = Uint8Array.of(
  0xa5,
  0x5a,
  0xc3,
  0x3c,
  0x69,
  0x96,
  0x0f,
  0xf0,
);
/**
 * Room past the marker, so a frame that overshoots by up to this much still
 * lands its marker inside the buffer and gets a report of the size it really
 * decoded rather than a bare decompression failure.
 */
const ZSTD_SIZE_SLACK_BYTES = 8;
/** How far back the marker is looked for when reporting a size mismatch. */
const ZSTD_SIZE_SEARCH_BYTES = 64 * 1024;

interface ZstdFrameInfo {
  readonly contentSize: number;
  readonly dataOffset: number;
  readonly checksum: boolean;
}

interface ZstdBlockLayout {
  /** Offset of the header of the block flagged last. */
  readonly lastBlockOffset: number;
  /** First byte after the last block, so before any content checksum. */
  readonly blocksEnd: number;
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

function validateSingleZstdFrame(
  frame: Uint8Array,
  info: ZstdFrameInfo,
): ZstdBlockLayout {
  let offset = info.dataOffset;
  let lastBlockOffset = info.dataOffset;
  let lastBlock = false;
  while (!lastBlock) {
    requireAvailable(frame, offset, 3, "block header");
    const header =
      frame[offset] | (frame[offset + 1] << 8) | (frame[offset + 2] << 16);
    lastBlockOffset = offset;
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
  const blocksEnd = offset;
  if (info.checksum) {
    requireAvailable(frame, offset, 4, "content checksum");
    offset += 4;
  }
  if (offset !== frame.byteLength) {
    throw new QwpProtocolError(
      `zstd body must contain exactly one frame [frameBytes=${offset}, actual=${frame.byteLength}]`,
    );
  }
  return { lastBlockOffset, blocksEnd };
}

/**
 * Reframes the blocks with a single-segment header, an eight-byte size marker
 * appended as a final RLE block, and the content size that marker needs.
 *
 * fzstd sizes its output from the declared content size and never reports how
 * far it actually got, so the marker is what makes the decoded length
 * observable: it lands wherever the frame's own output ends, which is the
 * declared content size and nowhere else for a frame that means what its
 * header says. Those bytes are also the headroom that lets an over-long frame
 * write past the declared size instead of being silently truncated into it.
 *
 * A single-segment window of the output's size is sufficient for all valid
 * frames because no match can refer before the decoded content, and it is what
 * makes fzstd decode in place: given a window that spans the whole output, it
 * resolves matches against the output itself instead of shifting a separate
 * window buffer down after every block, which is quadratic in the content
 * size. That shift cost a 4 KB frame declaring 64 MiB about 1.5 seconds.
 */
function frameWithSizeMarker(
  frame: Uint8Array,
  info: ZstdFrameInfo,
  layout: ZstdBlockLayout,
): Uint8Array {
  // Magic, then a single-segment descriptor with an 8-byte content size. The
  // checksum flag is dropped along with the trailing checksum bytes: nothing
  // verifies them, and the marker has to be the frame's last block.
  const headerSize = 4 + 1 + 8;
  const markerSize = 3 + ZSTD_SIZE_MARKER_BYTES;
  const blocks = frame.subarray(info.dataOffset, layout.blocksEnd);
  const reframed = new Uint8Array(headerSize + blocks.byteLength + markerSize);
  reframed.set(frame.subarray(0, 4));
  reframed[4] = 0xe0;
  let size = BigInt(
    info.contentSize + ZSTD_SIZE_MARKER_BYTES + ZSTD_SIZE_SLACK_BYTES,
  );
  for (let index = 0; index < 8; index++) {
    reframed[5 + index] = Number(size & 0xffn);
    size >>= 8n;
  }
  reframed.set(blocks, headerSize);
  // The marker block is the last one now, so the block that was carries the
  // flag no longer.
  reframed[headerSize + (layout.lastBlockOffset - info.dataOffset)] &= ~1;
  const marker = headerSize + blocks.byteLength;
  // Raw block, not RLE: the marker has to be eight chosen bytes, and an RLE
  // block can only repeat one.
  const header = 1 | (0 << 1) | (ZSTD_SIZE_MARKER_BYTES << 3);
  reframed[marker] = header & 0xff;
  reframed[marker + 1] = (header >>> 8) & 0xff;
  reframed[marker + 2] = (header >>> 16) & 0xff;
  reframed.set(ZSTD_SIZE_MARKER, marker + 3);
  return reframed;
}

function hasSizeMarkerAt(output: Uint8Array, offset: number): boolean {
  if (offset < 0 || offset + ZSTD_SIZE_MARKER_BYTES > output.byteLength) {
    return false;
  }
  for (let index = 0; index < ZSTD_SIZE_MARKER_BYTES; index++) {
    if (output[offset + index] !== ZSTD_SIZE_MARKER[index]) return false;
  }
  return true;
}

/**
 * Where the marker landed, searched downwards from `from`, or -1.
 *
 * Only a diagnostic: whether the frame is well formed at all was already
 * settled by testing the declared offset. fzstd stages a block's literals in
 * the unwritten tail of the output buffer, so that tail is not reliably zero
 * and the marker cannot be found by scanning back over zeros. The search is
 * bounded because a hostile frame chooses how far off its output ends.
 */
function findSizeMarker(output: Uint8Array, from: number): number {
  const start = Math.min(from, output.byteLength - ZSTD_SIZE_MARKER_BYTES);
  const floor = Math.max(0, start - ZSTD_SIZE_SEARCH_BYTES);
  for (let offset = start; offset >= floor; offset--) {
    if (hasSizeMarkerAt(output, offset)) return offset;
  }
  return -1;
}

/** Rejects a frame whose output did not end where its header said it would. */
function requireDeclaredSize(output: Uint8Array, contentSize: number): void {
  // The marker lands exactly where the frame's own output ended, and no shift
  // of it can spell itself, so this is the whole test: it holds for a frame
  // that means what its header says and for no other. A frame that overshot by
  // more than the slack could not land its marker inside the buffer at all,
  // and fzstd has already rejected it by the time we get here.
  if (hasSizeMarkerAt(output, contentSize)) return;
  const decoded = findSizeMarker(output, contentSize + ZSTD_SIZE_SLACK_BYTES);
  if (decoded >= 0 && decoded !== contentSize) {
    throw new QwpProtocolError(
      decoded < contentSize
        ? `zstd decompressed size ${decoded} does not match frame content size ${contentSize}`
        : `zstd output exceeds declared content size ${contentSize} by ${decoded - contentSize}`,
    );
  }
  throw new QwpProtocolError(
    `zstd output exceeds declared content size ${contentSize}`,
  );
}

/** Decompresses the single bounded Zstd frame carried by a RESULT_BATCH. */
export function decompressQwpZstdFrame(frame: Uint8Array): Uint8Array {
  const info = inspectZstdFrame(frame);
  const layout = validateSingleZstdFrame(frame, info);
  let output: Uint8Array;
  try {
    // fzstd allocates the output itself, from the declared content size the
    // marker is accounted for in. Handing it a buffer of our own instead costs
    // more than the decompression does: it compares that argument against a
    // sentinel with `!=`, and coercing a 64 MiB Uint8Array to a string for
    // that comparison took 840 ms where the whole decode takes 8 ms.
    output = decompress(frameWithSizeMarker(frame, info, layout));
  } catch (error) {
    if (error instanceof QwpProtocolError) throw error;
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new QwpProtocolError(`zstd decompression failed${detail}`);
  }
  requireDeclaredSize(output, info.contentSize);
  return output.subarray(0, info.contentSize);
}
