import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { QWP_MAX_SYMBOL_DICTIONARY_SIZE } from "../qwp/core";
import {
  QwpIngressReplayRecord,
  QwpIngressReplayStore,
} from "../qwp/transport";

const MAGIC = Buffer.from("QWPR");
const FORMAT_VERSION = 1;
const HEADER_SIZE = 52;
const SHA256_SIZE = 32;
const MAX_FRAME_SEQUENCE = 0xffffffffffffffffn;
const RECORD_SUFFIX = ".qwp";
const TEMP_MARKER = ".tmp-";
const DICTIONARY_MAGIC = Buffer.from("QWPD");
const DICTIONARY_FILE = "symbols.qwpdict";
const DICTIONARY_HEADER_SIZE = 8;
const DICTIONARY_BLOCK_HEADER_SIZE = 44;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

interface StoredRecord {
  readonly path: string;
  readonly size: number;
}

export interface QwpNodeFileReplayStoreOptions {
  /** Exclusive directory used by one ingress session. */
  directory: string;
  /** Maximum journal size including record headers. Defaults to 1 GiB. */
  maxBytes?: number;
}

export class QwpReplayStoreError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "QwpReplayStoreError";
    this.cause = cause;
  }
}

export class QwpReplayStoreFullError extends QwpReplayStoreError {
  constructor(
    readonly maxBytes: number,
    readonly requiredBytes: number,
  ) {
    super(
      `QWP store-and-forward journal is full [maxBytes=${maxBytes}, requiredBytes=${requiredBytes}]`,
    );
    this.name = "QwpReplayStoreFullError";
  }
}

/**
 * Crash-safe Node store-and-forward journal.
 *
 * Each frame is fsynced under a temporary name before an atomic rename. An ACK
 * removes its covered files and fsyncs the directory. A crash between the
 * server ACK and local deletion can therefore cause at-least-once replay, but
 * cannot silently lose an unacknowledged frame.
 */
export class QwpNodeFileReplayStore implements QwpIngressReplayStore {
  private readonly directory: string;
  private readonly maxBytes: number;
  private readonly records = new Map<bigint, StoredRecord>();
  private readonly symbols: string[] = [];
  private readonly symbolValues = new Set<string>();
  private operationTail: Promise<void> = Promise.resolve();
  private totalBytes = 0;
  private dictionaryFileSize = 0;
  private loaded = false;
  private closing = false;
  private closed = false;

  constructor(options: QwpNodeFileReplayStoreOptions) {
    const directory = options.directory.trim();
    if (!directory) {
      throw new RangeError("store-and-forward directory must not be empty");
    }
    const maxBytes = options.maxBytes ?? 1024 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= HEADER_SIZE) {
      throw new RangeError(
        `store-and-forward maxBytes must be a safe integer greater than ${HEADER_SIZE}`,
      );
    }
    this.directory = directory;
    this.maxBytes = maxBytes;
  }

  load(): Promise<readonly QwpIngressReplayRecord[]> {
    if (this.closing || this.closed) return Promise.reject(this.closedError());
    return this.enqueue(async () => {
      this.assertOpen();
      if (this.loaded) {
        throw new QwpReplayStoreError(
          "QWP store-and-forward journal has already been loaded",
        );
      }
      await mkdir(this.directory, { recursive: true });
      const entries = await readdir(this.directory, { withFileTypes: true });
      const recordNames: string[] = [];
      let removedTemporaryFile = false;
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name.includes(TEMP_MARKER)) {
          await ignoreMissing(unlink(join(this.directory, entry.name)));
          removedTemporaryFile = true;
        } else if (entry.name.endsWith(RECORD_SUFFIX)) {
          recordNames.push(entry.name);
        }
      }
      if (removedTemporaryFile) await syncDirectory(this.directory);
      recordNames.sort();

      const recovered: QwpIngressReplayRecord[] = [];
      let previous = -1n;
      for (const name of recordNames) {
        const path = join(this.directory, name);
        let bytes: Buffer;
        try {
          bytes = await readFile(path);
        } catch (error) {
          throw new QwpReplayStoreError(
            `could not read QWP store-and-forward record [file=${name}]`,
            error,
          );
        }
        const record = decodeRecord(bytes, name);
        if (record.frameSequence <= previous) {
          throw new QwpReplayStoreError(
            `QWP store-and-forward sequence is not strictly increasing [file=${name}]`,
          );
        }
        const expectedName = recordFileName(record.frameSequence);
        if (name !== expectedName) {
          throw new QwpReplayStoreError(
            `QWP store-and-forward filename does not match its sequence [file=${name}, expected=${expectedName}]`,
          );
        }
        this.totalBytes += bytes.byteLength;
        if (this.totalBytes > this.maxBytes) {
          throw new QwpReplayStoreFullError(this.maxBytes, this.totalBytes);
        }
        this.records.set(record.frameSequence, {
          path,
          size: bytes.byteLength,
        });
        recovered.push(record);
        previous = record.frameSequence;
      }
      await this.loadDictionaryFile();
      this.loaded = true;
      return recovered;
    });
  }

  append(record: QwpIngressReplayRecord): Promise<void> {
    if (this.closing || this.closed) return Promise.reject(this.closedError());
    return this.enqueue(async () => {
      this.assertReady();
      validateFrameSequence(record.frameSequence);
      if (this.records.has(record.frameSequence)) {
        throw new QwpReplayStoreError(
          `QWP store-and-forward sequence already exists [frameSequence=${record.frameSequence}]`,
        );
      }
      const bytes = encodeRecord(record);
      const requiredBytes = this.totalBytes + bytes.byteLength;
      if (requiredBytes > this.maxBytes) {
        throw new QwpReplayStoreFullError(this.maxBytes, requiredBytes);
      }

      const name = recordFileName(record.frameSequence);
      const finalPath = join(this.directory, name);
      const temporaryPath = join(
        this.directory,
        `${name}${TEMP_MARKER}${process.pid}-${randomUUID()}`,
      );
      try {
        const file = await open(temporaryPath, "wx", 0o600);
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporaryPath, finalPath);
        await syncDirectory(this.directory);
      } catch (error) {
        await ignoreMissing(unlink(temporaryPath));
        throw new QwpReplayStoreError(
          `could not persist QWP store-and-forward record [frameSequence=${record.frameSequence}]`,
          error,
        );
      }
      this.records.set(record.frameSequence, {
        path: finalPath,
        size: bytes.byteLength,
      });
      this.totalBytes = requiredBytes;
    });
  }

  acknowledgeThrough(frameSequence: bigint): Promise<void> {
    if (this.closing || this.closed) return Promise.reject(this.closedError());
    return this.enqueue(async () => {
      this.assertReady();
      let changed = false;
      for (const [sequence, record] of this.records) {
        if (sequence > frameSequence) break;
        try {
          await ignoreMissing(unlink(record.path));
        } catch (error) {
          throw new QwpReplayStoreError(
            `could not acknowledge QWP store-and-forward record [frameSequence=${sequence}]`,
            error,
          );
        }
        this.records.delete(sequence);
        this.totalBytes -= record.size;
        changed = true;
      }
      if (changed) await syncDirectory(this.directory);
    });
  }

  loadSymbolDictionary(): Promise<readonly string[]> {
    if (this.closing || this.closed) return Promise.reject(this.closedError());
    return this.enqueue(async () => {
      this.assertReady();
      return this.symbols.slice();
    });
  }

  appendSymbolDictionary(
    startId: number,
    entries: readonly string[],
  ): Promise<void> {
    if (this.closing || this.closed) return Promise.reject(this.closedError());
    return this.enqueue(async () => {
      this.assertReady();
      if (startId !== this.symbols.length) {
        throw new QwpReplayStoreError(
          `QWP symbol dictionary is not dense [expected=${this.symbols.length}, received=${startId}]`,
        );
      }
      if (startId + entries.length > QWP_MAX_SYMBOL_DICTIONARY_SIZE) {
        throw new QwpReplayStoreError(
          `QWP symbol dictionary exceeds maximum size ${QWP_MAX_SYMBOL_DICTIONARY_SIZE}`,
        );
      }
      if (entries.length === 0) return;
      const additions = new Set<string>();
      for (const entry of entries) {
        if (this.symbolValues.has(entry) || additions.has(entry)) {
          throw new QwpReplayStoreError(
            `QWP symbol dictionary contains a duplicate value: '${entry}'`,
          );
        }
        additions.add(entry);
      }
      const block = encodeDictionaryBlock(startId, entries);
      const initial = this.dictionaryFileSize === 0;
      const addedBytes =
        block.byteLength + (initial ? DICTIONARY_HEADER_SIZE : 0);
      const requiredBytes = this.totalBytes + addedBytes;
      if (requiredBytes > this.maxBytes) {
        throw new QwpReplayStoreFullError(this.maxBytes, requiredBytes);
      }
      const finalPath = join(this.directory, DICTIONARY_FILE);
      if (initial) {
        const temporaryPath = join(
          this.directory,
          `${DICTIONARY_FILE}${TEMP_MARKER}${process.pid}-${randomUUID()}`,
        );
        try {
          const file = await open(temporaryPath, "wx", 0o600);
          try {
            await file.writeFile(
              Buffer.concat([encodeDictionaryHeader(), block]),
            );
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(temporaryPath, finalPath);
          await syncDirectory(this.directory);
        } catch (error) {
          await ignoreMissing(unlink(temporaryPath));
          throw new QwpReplayStoreError(
            `could not create QWP symbol dictionary [startId=${startId}]`,
            error,
          );
        }
      } else {
        try {
          const file = await open(finalPath, "a", 0o600);
          try {
            await file.writeFile(block);
            await file.sync();
          } finally {
            await file.close();
          }
        } catch (error) {
          throw new QwpReplayStoreError(
            `could not append QWP symbol dictionary [startId=${startId}]`,
            error,
          );
        }
      }
      this.symbols.push(...entries);
      for (const entry of entries) this.symbolValues.add(entry);
      this.dictionaryFileSize += addedBytes;
      this.totalBytes = requiredBytes;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    await this.operationTail;
    this.closed = true;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertOpen(): void {
    if (this.closed) throw this.closedError();
  }

  private async loadDictionaryFile(): Promise<void> {
    const path = join(this.directory, DICTIONARY_FILE);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return;
      throw new QwpReplayStoreError(
        "could not read QWP symbol dictionary",
        error,
      );
    }
    if (bytes.byteLength < DICTIONARY_HEADER_SIZE) {
      throw corruptDictionary("file is shorter than its header");
    }
    if (!bytes.subarray(0, 4).equals(DICTIONARY_MAGIC)) {
      throw corruptDictionary("invalid magic");
    }
    if (bytes.readUInt8(4) !== FORMAT_VERSION) {
      throw corruptDictionary(`unsupported version ${bytes.readUInt8(4)}`);
    }
    let offset = DICTIONARY_HEADER_SIZE;
    while (offset < bytes.byteLength) {
      if (bytes.byteLength - offset < DICTIONARY_BLOCK_HEADER_SIZE) {
        await truncateDictionaryTail(path, offset, this.directory);
        break;
      }
      const startId = bytes.readUInt32LE(offset);
      const count = bytes.readUInt32LE(offset + 4);
      const payloadLength = bytes.readUInt32LE(offset + 8);
      const blockEnd = offset + DICTIONARY_BLOCK_HEADER_SIZE + payloadLength;
      if (blockEnd > bytes.byteLength) {
        await truncateDictionaryTail(path, offset, this.directory);
        break;
      }
      if (startId !== this.symbols.length) {
        throw corruptDictionary(
          `dictionary is not dense [expected=${this.symbols.length}, received=${startId}]`,
        );
      }
      if (startId + count > QWP_MAX_SYMBOL_DICTIONARY_SIZE) {
        throw corruptDictionary(
          `dictionary exceeds maximum size ${QWP_MAX_SYMBOL_DICTIONARY_SIZE}`,
        );
      }
      const payload = bytes.subarray(
        offset + DICTIONARY_BLOCK_HEADER_SIZE,
        blockEnd,
      );
      const expectedDigest = bytes.subarray(offset + 12, offset + 44);
      const actualDigest = createHash("sha256")
        .update(bytes.subarray(offset, offset + 12))
        .update(payload)
        .digest();
      if (!actualDigest.equals(expectedDigest)) {
        if (blockEnd === bytes.byteLength) {
          await truncateDictionaryTail(path, offset, this.directory);
          break;
        }
        throw corruptDictionary(`checksum mismatch at ID ${startId}`);
      }
      let payloadOffset = 0;
      for (let index = 0; index < count; index++) {
        if (payloadOffset + 4 > payload.byteLength) {
          throw corruptDictionary(`entry ${startId + index} is truncated`);
        }
        const length = payload.readUInt32LE(payloadOffset);
        payloadOffset += 4;
        if (payloadOffset + length > payload.byteLength) {
          throw corruptDictionary(`entry ${startId + index} is truncated`);
        }
        let entry: string;
        try {
          entry = UTF8_DECODER.decode(
            payload.subarray(payloadOffset, payloadOffset + length),
          );
        } catch {
          throw corruptDictionary(`entry ${startId + index} is not UTF-8`);
        }
        payloadOffset += length;
        if (this.symbolValues.has(entry)) {
          throw corruptDictionary(
            `duplicate value at ID ${startId + index}: '${entry}'`,
          );
        }
        this.symbolValues.add(entry);
        this.symbols.push(entry);
      }
      if (payloadOffset !== payload.byteLength) {
        throw corruptDictionary(`block at ID ${startId} has trailing bytes`);
      }
      offset = blockEnd;
    }
    this.dictionaryFileSize = offset;
    this.totalBytes += offset;
    if (this.totalBytes > this.maxBytes) {
      throw new QwpReplayStoreFullError(this.maxBytes, this.totalBytes);
    }
  }

  private assertReady(): void {
    this.assertOpen();
    if (!this.loaded) {
      throw new QwpReplayStoreError(
        "QWP store-and-forward journal must be loaded before use",
      );
    }
  }

  private closedError(): QwpReplayStoreError {
    return new QwpReplayStoreError("QWP store-and-forward journal is closed");
  }
}

function encodeRecord(record: QwpIngressReplayRecord): Buffer {
  validateFrameSequence(record.frameSequence);
  if (record.payload.byteLength > 0xffffffff) {
    throw new QwpReplayStoreError(
      `QWP frame is too large for the store-and-forward format [size=${record.payload.byteLength}]`,
    );
  }
  const bytes = Buffer.allocUnsafe(HEADER_SIZE + record.payload.byteLength);
  MAGIC.copy(bytes, 0);
  bytes.writeUInt8(FORMAT_VERSION, 4);
  bytes.fill(0, 5, 8);
  bytes.writeBigUInt64LE(record.frameSequence, 8);
  bytes.writeUInt32LE(record.payload.byteLength, 16);
  const digest = createHash("sha256").update(record.payload).digest();
  digest.copy(bytes, 20);
  Buffer.from(
    record.payload.buffer,
    record.payload.byteOffset,
    record.payload.byteLength,
  ).copy(bytes, HEADER_SIZE);
  return bytes;
}

function decodeRecord(bytes: Buffer, name: string): QwpIngressReplayRecord {
  if (bytes.byteLength < HEADER_SIZE) {
    throw corruptRecord(name, "record is shorter than its header");
  }
  if (!bytes.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
    throw corruptRecord(name, "invalid magic");
  }
  if (bytes.readUInt8(4) !== FORMAT_VERSION) {
    throw corruptRecord(name, `unsupported version ${bytes.readUInt8(4)}`);
  }
  const frameSequence = bytes.readBigUInt64LE(8);
  const payloadLength = bytes.readUInt32LE(16);
  if (HEADER_SIZE + payloadLength !== bytes.byteLength) {
    throw corruptRecord(name, "payload length does not match file size");
  }
  const payload = bytes.subarray(HEADER_SIZE);
  const expectedDigest = bytes.subarray(20, 20 + SHA256_SIZE);
  const actualDigest = createHash("sha256").update(payload).digest();
  if (!actualDigest.equals(expectedDigest)) {
    throw corruptRecord(name, "payload checksum mismatch");
  }
  return { frameSequence, payload: new Uint8Array(payload) };
}

function encodeDictionaryHeader(): Buffer {
  const header = Buffer.alloc(DICTIONARY_HEADER_SIZE);
  DICTIONARY_MAGIC.copy(header, 0);
  header.writeUInt8(FORMAT_VERSION, 4);
  return header;
}

function encodeDictionaryBlock(
  startId: number,
  entries: readonly string[],
): Buffer {
  if (!Number.isSafeInteger(startId) || startId < 0 || startId > 0xffffffff) {
    throw new QwpReplayStoreError(
      `QWP symbol dictionary start ID is outside uint32 range [startId=${startId}]`,
    );
  }
  if (startId + entries.length > QWP_MAX_SYMBOL_DICTIONARY_SIZE) {
    throw new QwpReplayStoreError(
      `QWP symbol dictionary exceeds maximum size ${QWP_MAX_SYMBOL_DICTIONARY_SIZE}`,
    );
  }
  if (entries.length > 0xffffffff) {
    throw new QwpReplayStoreError("QWP symbol dictionary block is too large");
  }
  const encoded = entries.map((entry) => {
    if (typeof entry !== "string") {
      throw new QwpReplayStoreError(
        "QWP symbol dictionary values must be strings",
      );
    }
    return Buffer.from(entry, "utf8");
  });
  let payloadLength = 0;
  for (const entry of encoded) {
    payloadLength += 4 + entry.byteLength;
    if (payloadLength > 0xffffffff) {
      throw new QwpReplayStoreError(
        "QWP symbol dictionary block payload is too large",
      );
    }
  }
  const block = Buffer.allocUnsafe(
    DICTIONARY_BLOCK_HEADER_SIZE + payloadLength,
  );
  block.writeUInt32LE(startId, 0);
  block.writeUInt32LE(entries.length, 4);
  block.writeUInt32LE(payloadLength, 8);
  let offset = DICTIONARY_BLOCK_HEADER_SIZE;
  for (const entry of encoded) {
    block.writeUInt32LE(entry.byteLength, offset);
    offset += 4;
    entry.copy(block, offset);
    offset += entry.byteLength;
  }
  const digest = createHash("sha256")
    .update(block.subarray(0, 12))
    .update(block.subarray(DICTIONARY_BLOCK_HEADER_SIZE))
    .digest();
  digest.copy(block, 12);
  return block;
}

function corruptDictionary(reason: string): QwpReplayStoreError {
  return new QwpReplayStoreError(`corrupt QWP symbol dictionary: ${reason}`);
}

async function truncateDictionaryTail(
  path: string,
  size: number,
  directory: string,
): Promise<void> {
  const file = await open(path, "r+");
  try {
    await file.truncate(size);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(directory);
}

function corruptRecord(name: string, reason: string): QwpReplayStoreError {
  return new QwpReplayStoreError(
    `corrupt QWP store-and-forward record [file=${name}]: ${reason}`,
  );
}

function validateFrameSequence(frameSequence: bigint): void {
  if (frameSequence < 0n || frameSequence > MAX_FRAME_SEQUENCE) {
    throw new QwpReplayStoreError(
      `QWP store-and-forward sequence is outside uint64 range [frameSequence=${frameSequence}]`,
    );
  }
}

function recordFileName(frameSequence: bigint): string {
  return `${frameSequence.toString().padStart(20, "0")}${RECORD_SUFFIX}`;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function ignoreMissing(operation: Promise<void>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
