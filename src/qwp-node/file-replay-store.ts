import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
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
const SEGMENT_SUFFIX = ".qwps";
const TEMP_MARKER = ".tmp-";
const ACK_MAGIC = Buffer.from("QWPA");
const ACK_FILE = "ack.qwpstate";
const ACK_STATE_SIZE = 48;
const DICTIONARY_MAGIC = Buffer.from("QWPD");
const DICTIONARY_FILE = "symbols.qwpdict";
const DICTIONARY_HEADER_SIZE = 8;
const DICTIONARY_BLOCK_HEADER_SIZE = 44;
const LOCK_DIRECTORY = ".qwp.lock";
const LOCK_OWNER_FILE = "owner.json";
const LOCK_RECOVERY_FILE = "recovery.json";
const ABANDONED_LOCK_PREFIX = ".qwp.lock.abandoned-";
const QUARANTINE_SLOT_INFIX = ".unreplayable-";
const QUARANTINE_FAILED_SENTINEL = ".qwp.failed";
const MAX_QUARANTINE_SLOT_ATTEMPTS = 64;
// Preserve two default-sized QWP batches, mirroring Java's active+spare
// liveness floor when the current dictionary generation consumes the cap.
const DEFAULT_LIVE_FRAME_BYTES = 2 * 16 * 1024 * 1024;
const DEFAULT_MAX_SEGMENT_BYTES = 4 * 1024 * 1024;
const DEFAULT_CHECKPOINT_INTERVAL_MS = 5_000;
const DEFAULT_APPEND_DEADLINE_MS = 30_000;
const MAX_TIMER_DELAY_MS = 0x7fffffff;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export const QWP_SF_DURABILITY = {
  MEMORY: "memory",
  PERIODIC: "periodic",
  APPEND: "append",
} as const;

export type QwpSfDurability =
  (typeof QWP_SF_DURABILITY)[keyof typeof QWP_SF_DURABILITY];

export const QWP_SF_BACKPRESSURE_POLICY = {
  ERROR: "error",
  WAIT: "wait",
} as const;

export type QwpSfBackpressurePolicy =
  (typeof QWP_SF_BACKPRESSURE_POLICY)[keyof typeof QWP_SF_BACKPRESSURE_POLICY];

interface StoredRecord {
  readonly path: string;
  readonly size: number;
  readonly segment?: StoredSegment;
}

interface StoredSegment {
  readonly path: string;
  readonly firstSequence: bigint;
  size: number;
  liveRecords: number;
}

interface RecoveredStoredRecord {
  readonly record: QwpIngressReplayRecord;
  readonly stored: StoredRecord;
}

interface PendingCapacity {
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface ReplayStoreLockOwner {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly createdAtMs: number;
}

export interface QwpNodeFileReplayStoreOptions {
  /** Exclusive directory used by one ingress session. */
  directory: string;
  /**
   * Target maximum journal size including record headers and symbol metadata.
   * Defaults to 1 GiB. The current symbol dictionary may exceed this target so
   * it cannot consume the journal's live frame budget before a drained close
   * retires that dictionary generation.
   */
  maxBytes?: number;
  /**
   * Maximum QWP frame payload and target segment data size. Segments may exceed
   * this value by one record header so a maximum-sized frame still fits.
   * Defaults to 4 MiB.
   */
  maxSegmentBytes?: number;
  /**
   * Local persistence barrier. `append` preserves the existing fsync-per-frame
   * behavior, `periodic` checkpoints dirty files in the background, and
   * `memory` relies on OS page-cache writeback. Defaults to `append`.
   */
  durability?: QwpSfDurability;
  /** Periodic durability checkpoint cadence. Defaults to 5 seconds. */
  checkpointIntervalMs?: number;
  /**
   * Behavior when maxBytes is exhausted. `error` fails immediately; `wait`
   * pauses the append until ACK trimming frees space or its deadline expires.
   * Defaults to `error` for backwards compatibility.
   */
  backpressurePolicy?: QwpSfBackpressurePolicy;
  /** Per-append disk-capacity wait deadline. Defaults to 30 seconds. */
  appendDeadlineMs?: number;
}

export interface QwpNodeFileReplayStoreMetrics {
  readonly durability: QwpSfDurability;
  readonly backpressurePolicy: QwpSfBackpressurePolicy;
  readonly pendingRecords: number;
  readonly pendingSegments: number;
  readonly totalBytes: number;
  readonly dirtyRecords: number;
  readonly checkpointPending: boolean;
  readonly waitingAppends: number;
  readonly totalCheckpoints: number;
  readonly totalCheckpointFailures: number;
  readonly totalBackpressureStalls: number;
  readonly totalAppendTimeouts: number;
  readonly lastCheckpointError?: QwpReplayStoreCheckpointError;
}

export class QwpReplayStoreError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "QwpReplayStoreError";
    this.cause = cause;
  }
}

/** Durable journal bytes are structurally corrupt and cannot be replayed. */
export class QwpReplayStoreCorruptionError extends QwpReplayStoreError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "QwpReplayStoreCorruptionError";
  }
}

/** A terminal replay slot was preserved under a quarantine pathname. */
export class QwpReplayStoreQuarantinedError extends QwpReplayStoreError {
  constructor(
    readonly directory: string,
    readonly quarantineDirectory: string,
    cause: unknown,
  ) {
    super(
      `QWP store-and-forward recovery could not replay the existing slot; its data was preserved at ${quarantineDirectory} and the producer continued with a fresh slot at ${directory}`,
      cause,
    );
    this.name = "QwpReplayStoreQuarantinedError";
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

export class QwpReplayStoreSegmentTooLargeError extends QwpReplayStoreError {
  constructor(
    readonly maxSegmentBytes: number,
    readonly payloadBytes: number,
  ) {
    super(
      `QWP store-and-forward frame exceeds sf_max_segment_bytes [maxSegmentBytes=${maxSegmentBytes}, payloadBytes=${payloadBytes}]`,
    );
    this.name = "QwpReplayStoreSegmentTooLargeError";
  }
}

export class QwpReplayStoreAppendTimeoutError extends QwpReplayStoreError {
  constructor(
    readonly maxBytes: number,
    readonly requiredBytes: number,
    readonly timeoutMs: number,
  ) {
    super(
      `QWP store-and-forward append remained backpressured for ${timeoutMs} ms [maxBytes=${maxBytes}, requiredBytes=${requiredBytes}]`,
    );
    this.name = "QwpReplayStoreAppendTimeoutError";
  }
}

export class QwpReplayStoreCheckpointError extends QwpReplayStoreError {
  constructor(
    readonly directory: string,
    cause?: unknown,
  ) {
    super(
      `could not checkpoint QWP store-and-forward journal [directory=${directory}]`,
      cause,
    );
    this.name = "QwpReplayStoreCheckpointError";
  }
}

export class QwpReplayStoreLockedError extends QwpReplayStoreError {
  constructor(
    readonly directory: string,
    readonly holderPid?: number,
    readonly holderHostname?: string,
  ) {
    const holder =
      holderPid === undefined
        ? "unknown"
        : `${holderPid}${holderHostname ? `@${holderHostname}` : ""}`;
    super(
      `QWP store-and-forward directory is already in use [directory=${directory}, holder=${holder}]`,
    );
    this.name = "QwpReplayStoreLockedError";
  }
}

/**
 * Node store-and-forward journal with configurable local durability.
 *
 * `append` fsyncs each frame before its atomic rename, while `periodic` batches
 * those barriers and `memory` relies on OS writeback. An ACK removes its
 * covered files. A crash between the server ACK and local deletion can cause
 * at-least-once replay. An exclusive, lifetime lock prevents another process
 * from recovering or mutating the same directory.
 */
export class QwpNodeFileReplayStore implements QwpIngressReplayStore {
  private readonly directory: string;
  private readonly maxBytes: number;
  private readonly maxSegmentBytes: number;
  private readonly liveFrameBytes: number;
  private readonly durability: QwpSfDurability;
  private readonly checkpointIntervalMs: number;
  private readonly backpressurePolicy: QwpSfBackpressurePolicy;
  private readonly appendDeadlineMs: number;
  private readonly records = new Map<bigint, StoredRecord>();
  private readonly segments = new Map<string, StoredSegment>();
  private readonly symbols: string[] = [];
  private readonly symbolValues = new Set<string>();
  private readonly dirtyRecordPaths = new Set<string>();
  private readonly capacityWaiters = new Set<PendingCapacity>();
  private operationTail: Promise<void> = Promise.resolve();
  private totalBytes = 0;
  private dictionaryFileSize = 0;
  private acknowledgedThrough = -1n;
  private dictionaryDirty = false;
  private acknowledgementDirty = false;
  private directoryDirty = false;
  private capacityGeneration = 0;
  private checkpointTimer?: ReturnType<typeof setTimeout>;
  private checkpointFailure?: QwpReplayStoreCheckpointError;
  private totalCheckpoints = 0;
  private totalCheckpointFailures = 0;
  private totalBackpressureStalls = 0;
  private totalAppendTimeouts = 0;
  private lockOwner?: ReplayStoreLockOwner;
  private closePromise?: Promise<void>;
  private loaded = false;
  private closing = false;
  private closed = false;
  private activeSegment?: StoredSegment;

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
    this.maxSegmentBytes = validatePositiveSafeInteger(
      options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES,
      "store-and-forward maxSegmentBytes",
    );
    this.liveFrameBytes = Math.min(maxBytes, DEFAULT_LIVE_FRAME_BYTES);
    this.durability = validateDurability(
      options.durability ?? QWP_SF_DURABILITY.APPEND,
    );
    this.backpressurePolicy = validateBackpressurePolicy(
      options.backpressurePolicy ?? QWP_SF_BACKPRESSURE_POLICY.ERROR,
    );
    this.checkpointIntervalMs = validateTimerDelay(
      options.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS,
      "store-and-forward checkpointIntervalMs",
    );
    if (
      options.checkpointIntervalMs !== undefined &&
      this.durability !== QWP_SF_DURABILITY.PERIODIC
    ) {
      throw new RangeError(
        "store-and-forward checkpointIntervalMs requires durability='periodic'",
      );
    }
    this.appendDeadlineMs = validateTimerDelay(
      options.appendDeadlineMs ?? DEFAULT_APPEND_DEADLINE_MS,
      "store-and-forward appendDeadlineMs",
    );
  }

  get metrics(): QwpNodeFileReplayStoreMetrics {
    return Object.freeze({
      durability: this.durability,
      backpressurePolicy: this.backpressurePolicy,
      pendingRecords: this.records.size,
      pendingSegments: this.segments.size,
      totalBytes: this.totalBytes,
      dirtyRecords: this.dirtyRecordPaths.size,
      checkpointPending:
        this.dirtyRecordPaths.size > 0 ||
        this.dictionaryDirty ||
        this.acknowledgementDirty ||
        this.directoryDirty,
      waitingAppends: this.capacityWaiters.size,
      totalCheckpoints: this.totalCheckpoints,
      totalCheckpointFailures: this.totalCheckpointFailures,
      totalBackpressureStalls: this.totalBackpressureStalls,
      totalAppendTimeouts: this.totalAppendTimeouts,
      lastCheckpointError: this.checkpointFailure,
    });
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
      let loadSucceeded = false;
      try {
        await this.acquireDirectoryLock();
        const entries = await readdir(this.directory, { withFileTypes: true });
        const recordNames: string[] = [];
        const segmentNames: string[] = [];
        let removedTemporaryFile = false;
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          if (entry.name.includes(TEMP_MARKER)) {
            await ignoreMissing(unlink(join(this.directory, entry.name)));
            removedTemporaryFile = true;
          } else if (entry.name.endsWith(RECORD_SUFFIX)) {
            recordNames.push(entry.name);
          } else if (entry.name.endsWith(SEGMENT_SUFFIX)) {
            segmentNames.push(entry.name);
          }
        }
        if (removedTemporaryFile) await syncDirectory(this.directory);
        recordNames.sort();
        segmentNames.sort();

        const acknowledgedThrough = await this.loadAcknowledgedThrough();
        const recoveredEntries: RecoveredStoredRecord[] = [];
        let removedDrainedSegment = false;
        for (let index = 0; index < segmentNames.length; index++) {
          const name = segmentNames[index];
          const path = join(this.directory, name);
          let bytes: Buffer;
          try {
            bytes = await readFile(path);
          } catch (error) {
            throw new QwpReplayStoreError(
              `could not read QWP store-and-forward segment [file=${name}]`,
              error,
            );
          }
          const decoded = decodeSegment(bytes, name);
          if (decoded.tornTail) {
            if (
              decoded.records.length === 0 ||
              index !== segmentNames.length - 1
            ) {
              throw corruptRecord(
                name,
                "segment has an unrecoverable torn record tail",
              );
            }
            await truncateSegmentTail(path, decoded.validBytes, this.directory);
            bytes = bytes.subarray(0, decoded.validBytes);
          }
          if (decoded.records.length === 0) {
            await ignoreMissing(unlink(path));
            removedDrainedSegment = true;
            continue;
          }
          const firstSequence = decoded.records[0].frameSequence;
          const expectedName = segmentFileName(firstSequence);
          if (name !== expectedName) {
            throw new QwpReplayStoreCorruptionError(
              `QWP store-and-forward segment filename does not match its first sequence [file=${name}, expected=${expectedName}]`,
            );
          }
          const liveRecords = decoded.records.filter(
            (record) => record.frameSequence > acknowledgedThrough,
          );
          if (liveRecords.length === 0) {
            await ignoreMissing(unlink(path));
            removedDrainedSegment = true;
            continue;
          }
          const segment: StoredSegment = {
            path,
            firstSequence,
            size: bytes.byteLength,
            liveRecords: liveRecords.length,
          };
          this.segments.set(path, segment);
          this.totalBytes += bytes.byteLength;
          for (const record of liveRecords) {
            recoveredEntries.push({
              record,
              stored: { path, size: 0, segment },
            });
          }
          this.activeSegment = segment;
        }
        if (removedDrainedSegment) await syncDirectory(this.directory);

        let previous = acknowledgedThrough;
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
          const expectedName = recordFileName(record.frameSequence);
          if (name !== expectedName) {
            throw new QwpReplayStoreCorruptionError(
              `QWP store-and-forward filename does not match its sequence [file=${name}, expected=${expectedName}]`,
            );
          }
          this.totalBytes += bytes.byteLength;
          if (record.frameSequence > acknowledgedThrough) {
            recoveredEntries.push({
              record,
              stored: { path, size: bytes.byteLength },
            });
          } else {
            await ignoreMissing(unlink(path));
            this.totalBytes -= bytes.byteLength;
            removedDrainedSegment = true;
          }
        }
        if (removedDrainedSegment) await syncDirectory(this.directory);
        recoveredEntries.sort((left, right) =>
          left.record.frameSequence < right.record.frameSequence
            ? -1
            : left.record.frameSequence > right.record.frameSequence
              ? 1
              : 0,
        );
        const recovered: QwpIngressReplayRecord[] = [];
        for (const { record, stored } of recoveredEntries) {
          if (record.frameSequence <= previous) {
            throw new QwpReplayStoreCorruptionError(
              `QWP store-and-forward sequence is not strictly increasing [frameSequence=${record.frameSequence}]`,
            );
          }
          if (previous >= 0n && record.frameSequence !== previous + 1n) {
            throw new QwpReplayStoreCorruptionError(
              `QWP store-and-forward sequence has a gap [previous=${previous}, received=${record.frameSequence}]`,
            );
          }
          this.records.set(record.frameSequence, stored);
          recovered.push(record);
          previous = record.frameSequence;
        }
        if (recovered.length === 0 && acknowledgedThrough >= 0n) {
          await this.removeAcknowledgedThrough();
        }
        if (this.totalBytes > this.maxBytes) {
          throw new QwpReplayStoreFullError(this.maxBytes, this.totalBytes);
        }
        await this.loadDictionaryFile();
        this.loaded = true;
        loadSucceeded = true;
        this.scheduleCheckpoint();
        return recovered;
      } finally {
        if (!loadSucceeded) await this.releaseDirectoryLock();
      }
    });
  }

  append(record: QwpIngressReplayRecord): Promise<void> {
    if (this.closing || this.closed) return Promise.reject(this.closedError());
    if (record.payload.byteLength > this.maxSegmentBytes) {
      return Promise.reject(
        new QwpReplayStoreSegmentTooLargeError(
          this.maxSegmentBytes,
          record.payload.byteLength,
        ),
      );
    }
    const bytes = encodeRecord(record);
    if (bytes.byteLength > this.maxBytes) {
      return Promise.reject(
        new QwpReplayStoreFullError(this.maxBytes, bytes.byteLength),
      );
    }
    return this.appendWithBackpressure(record, bytes);
  }

  acknowledgeThrough(frameSequence: bigint): Promise<void> {
    if (this.closing || this.closed) return Promise.reject(this.closedError());
    return this.enqueue(async () => {
      this.assertReady();
      const acknowledged: Array<[bigint, StoredRecord]> = [];
      for (const entry of this.records.entries()) {
        if (entry[0] > frameSequence) break;
        acknowledged.push(entry);
      }
      if (acknowledged.length === 0) return;
      // Persist the logical cursor before mutating files or in-memory state. A
      // crash after this point can leave extra bytes, but never resurrects an
      // acknowledged prefix from a partially-live segment.
      await this.persistAcknowledgedThrough(frameSequence);
      const emptiedSegments = new Set<StoredSegment>();
      for (const [sequence, record] of acknowledged) {
        if (record.segment) {
          record.segment.liveRecords--;
          if (record.segment.liveRecords === 0) {
            emptiedSegments.add(record.segment);
          }
        } else {
          try {
            await ignoreMissing(unlink(record.path));
          } catch (error) {
            throw new QwpReplayStoreError(
              `could not acknowledge QWP store-and-forward record [frameSequence=${sequence}]`,
              error,
            );
          }
          this.dirtyRecordPaths.delete(record.path);
          this.totalBytes -= record.size;
        }
        this.records.delete(sequence);
      }
      for (const segment of emptiedSegments) {
        try {
          await ignoreMissing(unlink(segment.path));
        } catch (error) {
          throw new QwpReplayStoreError(
            `could not acknowledge QWP store-and-forward segment [firstSequence=${segment.firstSequence}]`,
            error,
          );
        }
        this.segments.delete(segment.path);
        this.dirtyRecordPaths.delete(segment.path);
        this.totalBytes -= segment.size;
        if (this.activeSegment === segment) this.activeSegment = undefined;
      }
      if (this.records.size === 0) await this.removeAcknowledgedThrough();
      if (this.durability === QWP_SF_DURABILITY.APPEND) {
        await syncDirectory(this.directory);
      } else if (this.durability === QWP_SF_DURABILITY.PERIODIC) {
        this.directoryDirty = true;
      }
      this.signalCapacity();
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
            if (this.durability === QWP_SF_DURABILITY.APPEND) {
              await file.sync();
            }
          } finally {
            await file.close();
          }
          await rename(temporaryPath, finalPath);
          if (this.durability === QWP_SF_DURABILITY.APPEND) {
            await syncDirectory(this.directory);
          } else if (this.durability === QWP_SF_DURABILITY.PERIODIC) {
            this.dictionaryDirty = true;
            this.directoryDirty = true;
          }
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
            if (this.durability === QWP_SF_DURABILITY.APPEND) {
              await file.sync();
            } else if (this.durability === QWP_SF_DURABILITY.PERIODIC) {
              this.dictionaryDirty = true;
            }
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

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = undefined;
    this.rejectCapacityWaiters(this.closedError());
    this.closePromise = this.operationTail.then(async () => {
      let failure: unknown;
      try {
        if (this.durability === QWP_SF_DURABILITY.PERIODIC) {
          await this.checkpointDirty();
        }
        if (this.checkpointFailure) throw this.checkpointFailure;
        await this.retireDrainedDictionary();
      } catch (error) {
        failure = error;
      }
      try {
        await this.releaseDirectoryLock();
      } catch (error) {
        failure ??= error;
      } finally {
        this.closed = true;
      }
      if (failure) throw failure;
    });
    return this.closePromise;
  }

  private async appendWithBackpressure(
    record: QwpIngressReplayRecord,
    bytes: Buffer,
  ): Promise<void> {
    let deadline = 0;
    let stalled = false;
    for (;;) {
      if (this.closing || this.closed) throw this.closedError();
      const capacityGeneration = this.capacityGeneration;
      try {
        await this.enqueue(() => this.appendOnce(record, bytes));
        return;
      } catch (error) {
        if (!(error instanceof QwpReplayStoreFullError)) throw error;
        if (this.backpressurePolicy === QWP_SF_BACKPRESSURE_POLICY.ERROR) {
          throw error;
        }
        if (!stalled) {
          stalled = true;
          deadline = Date.now() + this.appendDeadlineMs;
          this.totalBackpressureStalls++;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          this.totalAppendTimeouts++;
          throw new QwpReplayStoreAppendTimeoutError(
            this.maxBytes,
            error.requiredBytes,
            this.appendDeadlineMs,
          );
        }
        await this.waitForCapacity(capacityGeneration, remainingMs, error);
      }
    }
  }

  private async appendOnce(
    record: QwpIngressReplayRecord,
    bytes: Buffer,
  ): Promise<void> {
    this.assertReady();
    validateFrameSequence(record.frameSequence);
    if (this.records.has(record.frameSequence)) {
      throw new QwpReplayStoreError(
        `QWP store-and-forward sequence already exists [frameSequence=${record.frameSequence}]`,
      );
    }
    const requiredBytes = this.totalBytes + bytes.byteLength;
    const frameBytes = this.totalBytes - this.dictionaryFileSize;
    const requiredFrameBytes = frameBytes + bytes.byteLength;
    const preservesLiveness =
      this.dictionaryFileSize > 0 &&
      (requiredFrameBytes <= this.liveFrameBytes || frameBytes === 0);
    if (requiredBytes > this.maxBytes && !preservesLiveness) {
      throw new QwpReplayStoreFullError(this.maxBytes, requiredBytes);
    }

    const segmentLimit = this.maxSegmentBytes + HEADER_SIZE;
    let segment = this.activeSegment;
    if (!segment || segment.size + bytes.byteLength > segmentLimit) {
      const name = segmentFileName(record.frameSequence);
      const finalPath = join(this.directory, name);
      const temporaryPath = join(
        this.directory,
        `${name}${TEMP_MARKER}${process.pid}-${randomUUID()}`,
      );
      try {
        const file = await open(temporaryPath, "wx", 0o600);
        try {
          await file.writeFile(bytes);
          if (this.durability === QWP_SF_DURABILITY.APPEND) await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporaryPath, finalPath);
        if (this.durability === QWP_SF_DURABILITY.APPEND) {
          await syncDirectory(this.directory);
        } else if (this.durability === QWP_SF_DURABILITY.PERIODIC) {
          this.dirtyRecordPaths.add(finalPath);
          this.directoryDirty = true;
        }
      } catch (error) {
        await ignoreMissing(unlink(temporaryPath));
        throw new QwpReplayStoreError(
          `could not create QWP store-and-forward segment [frameSequence=${record.frameSequence}]`,
          error,
        );
      }
      segment = {
        path: finalPath,
        firstSequence: record.frameSequence,
        size: 0,
        liveRecords: 0,
      };
      this.segments.set(finalPath, segment);
      this.activeSegment = segment;
    } else {
      const previousSize = segment.size;
      try {
        const file = await open(segment.path, "a", 0o600);
        try {
          await file.writeFile(bytes);
          if (this.durability === QWP_SF_DURABILITY.APPEND) await file.sync();
        } catch (error) {
          await file.truncate(previousSize).catch(() => undefined);
          throw error;
        } finally {
          await file.close();
        }
        if (this.durability === QWP_SF_DURABILITY.PERIODIC) {
          this.dirtyRecordPaths.add(segment.path);
        }
      } catch (error) {
        throw new QwpReplayStoreError(
          `could not append QWP store-and-forward segment [frameSequence=${record.frameSequence}]`,
          error,
        );
      }
    }
    segment.size += bytes.byteLength;
    segment.liveRecords++;
    this.records.set(record.frameSequence, {
      path: segment.path,
      size: 0,
      segment,
    });
    this.totalBytes = requiredBytes;
  }

  private waitForCapacity(
    capacityGeneration: number,
    timeoutMs: number,
    full: QwpReplayStoreFullError,
  ): Promise<void> {
    if (this.checkpointFailure) {
      return Promise.reject(this.checkpointFailure);
    }
    if (capacityGeneration !== this.capacityGeneration) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const pending: PendingCapacity = { resolve, reject };
      pending.timer = setTimeout(() => {
        if (!this.capacityWaiters.delete(pending)) return;
        this.totalAppendTimeouts++;
        reject(
          new QwpReplayStoreAppendTimeoutError(
            this.maxBytes,
            full.requiredBytes,
            this.appendDeadlineMs,
          ),
        );
      }, timeoutMs);
      this.capacityWaiters.add(pending);
      if (capacityGeneration !== this.capacityGeneration) {
        this.capacityWaiters.delete(pending);
        clearTimeout(pending.timer);
        resolve();
      }
    });
  }

  private signalCapacity(): void {
    this.capacityGeneration++;
    for (const pending of this.capacityWaiters) {
      this.capacityWaiters.delete(pending);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve();
    }
  }

  private rejectCapacityWaiters(error: Error): void {
    for (const pending of this.capacityWaiters) {
      this.capacityWaiters.delete(pending);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private scheduleCheckpoint(): void {
    if (
      this.durability !== QWP_SF_DURABILITY.PERIODIC ||
      !this.loaded ||
      this.closing ||
      this.closed ||
      this.checkpointTimer
    ) {
      return;
    }
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = undefined;
      if (this.closing || this.closed) return;
      const checkpoint = this.enqueue(() => this.checkpointDirty());
      void checkpoint.then(
        () => this.scheduleCheckpoint(),
        () => this.scheduleCheckpoint(),
      );
    }, this.checkpointIntervalMs);
    this.checkpointTimer.unref?.();
  }

  private async checkpointDirty(): Promise<void> {
    if (
      this.dirtyRecordPaths.size === 0 &&
      !this.dictionaryDirty &&
      !this.acknowledgementDirty &&
      !this.directoryDirty
    ) {
      return;
    }
    try {
      for (const path of this.dirtyRecordPaths) await syncFile(path);
      if (this.dictionaryDirty) {
        await syncFile(join(this.directory, DICTIONARY_FILE));
      }
      if (this.acknowledgementDirty) {
        await syncFile(join(this.directory, ACK_FILE));
      }
      if (this.directoryDirty) await syncDirectory(this.directory);
      this.dirtyRecordPaths.clear();
      this.dictionaryDirty = false;
      this.acknowledgementDirty = false;
      this.directoryDirty = false;
      this.checkpointFailure = undefined;
      this.totalCheckpoints++;
    } catch (cause) {
      const error = new QwpReplayStoreCheckpointError(this.directory, cause);
      this.checkpointFailure = error;
      this.totalCheckpointFailures++;
      this.rejectCapacityWaiters(error);
      throw error;
    }
  }

  private async loadAcknowledgedThrough(): Promise<bigint> {
    const path = join(this.directory, ACK_FILE);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return -1n;
      throw new QwpReplayStoreError(
        "could not read QWP store-and-forward ACK watermark",
        error,
      );
    }
    this.acknowledgedThrough = decodeAcknowledgedThrough(bytes);
    return this.acknowledgedThrough;
  }

  private async persistAcknowledgedThrough(
    frameSequence: bigint,
  ): Promise<void> {
    if (frameSequence <= this.acknowledgedThrough) return;
    const name = `${ACK_FILE}${TEMP_MARKER}${process.pid}-${randomUUID()}`;
    const temporaryPath = join(this.directory, name);
    const finalPath = join(this.directory, ACK_FILE);
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(encodeAcknowledgedThrough(frameSequence));
        if (this.durability === QWP_SF_DURABILITY.APPEND) await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, finalPath);
      if (this.durability === QWP_SF_DURABILITY.APPEND) {
        await syncDirectory(this.directory);
      } else if (this.durability === QWP_SF_DURABILITY.PERIODIC) {
        this.acknowledgementDirty = true;
        this.directoryDirty = true;
      }
      this.acknowledgedThrough = frameSequence;
    } catch (error) {
      await ignoreMissing(unlink(temporaryPath));
      throw new QwpReplayStoreError(
        `could not persist QWP store-and-forward ACK watermark [frameSequence=${frameSequence}]`,
        error,
      );
    }
  }

  private async removeAcknowledgedThrough(): Promise<void> {
    if (this.acknowledgedThrough < 0n) return;
    await ignoreMissing(unlink(join(this.directory, ACK_FILE)));
    this.acknowledgedThrough = -1n;
    this.acknowledgementDirty = false;
    if (this.durability === QWP_SF_DURABILITY.APPEND) {
      await syncDirectory(this.directory);
    } else if (this.durability === QWP_SF_DURABILITY.PERIODIC) {
      this.directoryDirty = true;
    }
  }

  /**
   * Retires the dictionary generation only after every operation has settled
   * and no replay frame remains. Doing this in acknowledgeThrough() would be
   * unsafe: an ACK may arrive after a new dictionary suffix is persisted but
   * before the frame that references it is appended.
   */
  private async retireDrainedDictionary(): Promise<void> {
    if (
      !this.loaded ||
      this.records.size !== 0 ||
      this.dictionaryFileSize === 0
    ) {
      return;
    }
    const path = join(this.directory, DICTIONARY_FILE);
    try {
      await ignoreMissing(unlink(path));
      if (this.durability !== QWP_SF_DURABILITY.MEMORY) {
        await syncDirectory(this.directory);
      }
    } catch (error) {
      throw new QwpReplayStoreError(
        `could not retire fully drained QWP symbol dictionary [file=${path}]`,
        error,
      );
    }
    this.totalBytes -= this.dictionaryFileSize;
    this.dictionaryFileSize = 0;
    this.dictionaryDirty = false;
    this.symbols.length = 0;
    this.symbolValues.clear();
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

  private async acquireDirectoryLock(): Promise<void> {
    const lockPath = join(this.directory, LOCK_DIRECTORY);
    const ownerPath = join(lockPath, LOCK_OWNER_FILE);
    const owner: ReplayStoreLockOwner = {
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      createdAtMs: Date.now(),
    };

    for (;;) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
      } catch (error) {
        if (nodeErrorCode(error) !== "EEXIST") {
          throw new QwpReplayStoreError(
            `could not acquire QWP store-and-forward directory lock [directory=${this.directory}]`,
            error,
          );
        }
        const holder = await readLockOwner(ownerPath);
        if (!holder) {
          throw new QwpReplayStoreLockedError(this.directory);
        }
        if (!isDefinitelyDeadLockOwner(holder)) {
          throw new QwpReplayStoreLockedError(
            this.directory,
            holder.pid,
            holder.hostname,
          );
        }

        // Claim recovery inside the directory before renaming it. This keeps
        // simultaneous starters that observed the same dead PID from both
        // adopting the stale pathname. Re-read the owner after the claim so a
        // process that arrived after another recovery cannot move the new lock.
        const recoveryPath = join(lockPath, LOCK_RECOVERY_FILE);
        try {
          await writeLockOwner(recoveryPath, owner);
        } catch (claimError) {
          const code = nodeErrorCode(claimError);
          if (code === "ENOENT") continue;
          if (code === "EEXIST") {
            throw new QwpReplayStoreLockedError(
              this.directory,
              holder.pid,
              holder.hostname,
            );
          }
          throw new QwpReplayStoreError(
            `could not claim abandoned QWP store-and-forward directory lock [directory=${this.directory}]`,
            claimError,
          );
        }
        const claimedHolder = await readLockOwner(ownerPath);
        if (!claimedHolder || claimedHolder.token !== holder.token) {
          await ignoreMissing(unlink(recoveryPath));
          if (!claimedHolder) continue;
          throw new QwpReplayStoreLockedError(
            this.directory,
            claimedHolder.pid,
            claimedHolder.hostname,
          );
        }

        const abandonedPath = join(
          this.directory,
          `${ABANDONED_LOCK_PREFIX}${randomUUID()}`,
        );
        try {
          await rename(lockPath, abandonedPath);
        } catch (renameError) {
          if (nodeErrorCode(renameError) === "ENOENT") {
            await ignoreMissing(unlink(recoveryPath));
            continue;
          }
          await ignoreMissing(unlink(recoveryPath));
          throw new QwpReplayStoreError(
            `could not recover abandoned QWP store-and-forward directory lock [directory=${this.directory}]`,
            renameError,
          );
        }
        try {
          await rm(abandonedPath, { recursive: true, force: true });
          await syncDirectory(this.directory);
        } catch (cleanupError) {
          throw new QwpReplayStoreError(
            `could not remove abandoned QWP store-and-forward directory lock [directory=${this.directory}]`,
            cleanupError,
          );
        }
        continue;
      }

      try {
        await writeLockOwner(ownerPath, owner);
        await syncDirectory(lockPath);
        await syncDirectory(this.directory);
        this.lockOwner = owner;
        return;
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true }).catch(
          () => undefined,
        );
        throw new QwpReplayStoreError(
          `could not initialize QWP store-and-forward directory lock [directory=${this.directory}]`,
          error,
        );
      }
    }
  }

  private async releaseDirectoryLock(): Promise<void> {
    const owner = this.lockOwner;
    if (!owner) return;
    const lockPath = join(this.directory, LOCK_DIRECTORY);
    const ownerPath = join(lockPath, LOCK_OWNER_FILE);
    const persistedOwner = await readLockOwner(ownerPath);
    if (!persistedOwner || persistedOwner.token !== owner.token) {
      throw new QwpReplayStoreError(
        `refusing to release a QWP store-and-forward directory lock owned by another process [directory=${this.directory}]`,
      );
    }
    try {
      await unlink(ownerPath);
      await rmdir(lockPath);
      await syncDirectory(this.directory);
      this.lockOwner = undefined;
    } catch (error) {
      throw new QwpReplayStoreError(
        `could not release QWP store-and-forward directory lock [directory=${this.directory}]`,
        error,
      );
    }
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
    // Dictionary bytes are generation-monotonic and ACK trimming cannot
    // reclaim them while the store remains open. A fully drained close retires
    // the generation. Loading a valid journal above the target is therefore
    // safe; frame appends retain the bounded liveness floor until then.
  }

  private assertReady(): void {
    this.assertOpen();
    if (!this.loaded) {
      throw new QwpReplayStoreError(
        "QWP store-and-forward journal must be loaded before use",
      );
    }
    if (this.checkpointFailure) throw this.checkpointFailure;
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

interface DecodedSegment {
  readonly records: QwpIngressReplayRecord[];
  readonly validBytes: number;
  readonly tornTail: boolean;
}

function decodeSegment(bytes: Buffer, name: string): DecodedSegment {
  const records: QwpIngressReplayRecord[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset;
    if (remaining < HEADER_SIZE) {
      return { records, validBytes: offset, tornTail: true };
    }
    if (!bytes.subarray(offset, offset + MAGIC.byteLength).equals(MAGIC)) {
      throw corruptRecord(name, `invalid record magic at offset ${offset}`);
    }
    const payloadLength = bytes.readUInt32LE(offset + 16);
    const recordEnd = offset + HEADER_SIZE + payloadLength;
    if (recordEnd > bytes.byteLength) {
      return { records, validBytes: offset, tornTail: true };
    }
    records.push(
      decodeRecord(bytes.subarray(offset, recordEnd), `${name}@${offset}`),
    );
    offset = recordEnd;
  }
  return { records, validBytes: offset, tornTail: false };
}

function encodeAcknowledgedThrough(frameSequence: bigint): Buffer {
  validateFrameSequence(frameSequence);
  const bytes = Buffer.alloc(ACK_STATE_SIZE);
  ACK_MAGIC.copy(bytes, 0);
  bytes.writeUInt8(FORMAT_VERSION, 4);
  bytes.writeBigUInt64LE(frameSequence, 8);
  createHash("sha256").update(bytes.subarray(0, 16)).digest().copy(bytes, 16);
  return bytes;
}

function decodeAcknowledgedThrough(bytes: Buffer): bigint {
  if (bytes.byteLength !== ACK_STATE_SIZE) {
    throw new QwpReplayStoreCorruptionError(
      "corrupt QWP store-and-forward ACK watermark: invalid length",
    );
  }
  if (!bytes.subarray(0, ACK_MAGIC.byteLength).equals(ACK_MAGIC)) {
    throw new QwpReplayStoreCorruptionError(
      "corrupt QWP store-and-forward ACK watermark: invalid magic",
    );
  }
  if (bytes.readUInt8(4) !== FORMAT_VERSION) {
    throw new QwpReplayStoreCorruptionError(
      `corrupt QWP store-and-forward ACK watermark: unsupported version ${bytes.readUInt8(4)}`,
    );
  }
  const expected = bytes.subarray(16);
  const actual = createHash("sha256").update(bytes.subarray(0, 16)).digest();
  if (!actual.equals(expected)) {
    throw new QwpReplayStoreCorruptionError(
      "corrupt QWP store-and-forward ACK watermark: checksum mismatch",
    );
  }
  return bytes.readBigUInt64LE(8);
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

function corruptDictionary(reason: string): QwpReplayStoreCorruptionError {
  return new QwpReplayStoreCorruptionError(
    `corrupt QWP symbol dictionary: ${reason}`,
  );
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

async function truncateSegmentTail(
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

function corruptRecord(
  name: string,
  reason: string,
): QwpReplayStoreCorruptionError {
  return new QwpReplayStoreCorruptionError(
    `corrupt QWP store-and-forward record [file=${name}]: ${reason}`,
  );
}

/** @internal True for slot names reserved for operator-inspected data loss. */
export function isQwpNodeReplayQuarantineSlotName(name: string): boolean {
  const marker = name.lastIndexOf(QUARANTINE_SLOT_INFIX);
  if (marker <= 0) return false;
  return /^\d+$/.test(name.slice(marker + QUARANTINE_SLOT_INFIX.length));
}

/**
 * @internal Preserves a proven-unreplayable slot and frees its stable pathname
 * for a fresh producer. The caller must have closed the replay store first.
 */
export async function quarantineQwpNodeReplayStore(
  directory: string,
  cause: unknown,
): Promise<QwpReplayStoreQuarantinedError> {
  const normalized = directory.trim();
  if (!normalized) {
    throw new QwpReplayStoreError(
      "cannot quarantine an empty QWP store-and-forward directory",
      cause,
    );
  }
  const parent = dirname(normalized);
  const slotName = basename(normalized);
  let quarantineDirectory: string | undefined;
  for (let attempt = 0; attempt < MAX_QUARANTINE_SLOT_ATTEMPTS; attempt++) {
    const candidate = join(
      parent,
      `${slotName}${QUARANTINE_SLOT_INFIX}${attempt}`,
    );
    if (await pathExists(candidate)) continue;
    try {
      await rename(normalized, candidate);
      quarantineDirectory = candidate;
      break;
    } catch (error) {
      if (
        nodeErrorCode(error) === "EEXIST" ||
        nodeErrorCode(error) === "ENOTEMPTY"
      ) {
        continue;
      }
      throw new QwpReplayStoreError(
        `could not quarantine unreplayable QWP store-and-forward slot [directory=${normalized}, target=${candidate}]`,
        error,
      );
    }
  }
  if (!quarantineDirectory) {
    throw new QwpReplayStoreError(
      `could not quarantine unreplayable QWP store-and-forward slot; ${MAX_QUARANTINE_SLOT_ATTEMPTS} quarantine paths already exist [directory=${normalized}]`,
      cause,
    );
  }

  const recoveryError =
    cause instanceof Error ? cause : new Error(String(cause));
  await writeFile(
    join(quarantineDirectory, QUARANTINE_FAILED_SENTINEL),
    `${new Date().toISOString()} ${recoveryError.name}: ${recoveryError.message}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  ).catch(() => undefined);
  await syncDirectory(parent);
  return new QwpReplayStoreQuarantinedError(
    normalized,
    quarantineDirectory,
    recoveryError,
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return false;
    throw error;
  }
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

function segmentFileName(frameSequence: bigint): string {
  return `${frameSequence.toString().padStart(20, "0")}${SEGMENT_SUFFIX}`;
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

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateDurability(value: string): QwpSfDurability {
  if (
    value === QWP_SF_DURABILITY.MEMORY ||
    value === QWP_SF_DURABILITY.PERIODIC ||
    value === QWP_SF_DURABILITY.APPEND
  ) {
    return value;
  }
  throw new RangeError(`unsupported store-and-forward durability '${value}'`);
}

function validateBackpressurePolicy(value: string): QwpSfBackpressurePolicy {
  if (
    value === QWP_SF_BACKPRESSURE_POLICY.ERROR ||
    value === QWP_SF_BACKPRESSURE_POLICY.WAIT
  ) {
    return value;
  }
  throw new RangeError(
    `unsupported store-and-forward backpressurePolicy '${value}'`,
  );
}

function validateTimerDelay(value: number, name: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_TIMER_DELAY_MS
  ) {
    throw new RangeError(
      `${name} must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
    );
  }
  return value;
}

function validatePositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
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

async function readLockOwner(
  ownerPath: string,
): Promise<ReplayStoreLockOwner | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(ownerPath, "utf8"));
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw new QwpReplayStoreError(
      `could not read QWP store-and-forward directory lock [file=${ownerPath}]`,
      error,
    );
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const owner = parsed as Partial<ReplayStoreLockOwner>;
  if (
    owner.version !== 1 ||
    typeof owner.token !== "string" ||
    owner.token.length === 0 ||
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid ?? 0) <= 0 ||
    typeof owner.hostname !== "string" ||
    owner.hostname.length === 0 ||
    !Number.isSafeInteger(owner.createdAtMs) ||
    (owner.createdAtMs ?? 0) < 0
  ) {
    return undefined;
  }
  return owner as ReplayStoreLockOwner;
}

async function writeLockOwner(
  path: string,
  owner: ReplayStoreLockOwner,
): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

function isDefinitelyDeadLockOwner(owner: ReplayStoreLockOwner): boolean {
  if (owner.hostname !== hostname() || owner.pid === process.pid) {
    return false;
  }
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return nodeErrorCode(error) === "ESRCH";
  }
}
