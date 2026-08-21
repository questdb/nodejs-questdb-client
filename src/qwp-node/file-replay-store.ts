import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { QWP_MAX_SYMBOL_DICTIONARY_SIZE } from "../_qwp/_core";
import {
  QwpIngressReplayRecord,
  QwpIngressReplayReference,
  QwpIngressReplayStore,
} from "../_qwp/transport";
import {
  QwpNodeAdvisoryLock,
  QwpNodeAdvisoryLockBusyError,
  QwpNodeAdvisoryLockUnavailableError,
} from "./advisory-lock";
import { qwpSegmentMaintenanceWorker } from "./segment-maintenance-worker";
import { log } from "../logging";

const FORMAT_VERSION = 1;
const MAX_FRAME_SEQUENCE = 0x7fffffffffffffffn;
const SEGMENT_MAGIC = Buffer.from("SF01");
const SEGMENT_PREFIX = "sf-";
const SEGMENT_SUFFIX = ".sfa";
const SEGMENT_HEADER_SIZE = 24;
const FRAME_HEADER_SIZE = 8;
const MANIFEST_REQUIRED_FLAG = 1;
const MANIFEST_MAGIC = Buffer.from("SFM1");
const MANIFEST_FILE = "sf-manifest.bin";
const TEMP_MARKER = ".tmp-";
const ACK_MAGIC = Buffer.from("AKW1");
const ACK_FILE = ".ack-watermark";
const DICTIONARY_MAGIC = Buffer.from("SYD1");
const DICTIONARY_FILE = ".symbol-dict";
const DICTIONARY_HEADER_SIZE = 8;
const DUAL_SLOT_FILE_SIZE = 8 * 1024;
const RECORD_SLOT_SIZE = 4 * 1024;
const METADATA_RECORD_SIZE = 64;
const METADATA_CRC_OFFSET = 60;
const QUARANTINE_SLOT_INFIX = ".unreplayable-";
const QUARANTINE_FAILED_SENTINEL = ".failed";
const MAX_QUARANTINE_SLOT_ATTEMPTS = 64;
// Preserve two default-sized QWP batches, mirroring Java's active+spare
// liveness floor when the current dictionary generation consumes the cap.
const DEFAULT_LIVE_FRAME_BYTES = 2 * 16 * 1024 * 1024;
const DEFAULT_MAX_SEGMENT_BYTES = 4 * 1024 * 1024;
const DEFAULT_CHECKPOINT_INTERVAL_MS = 5_000;
const DEFAULT_APPEND_DEADLINE_MS = 30_000;
const TRIM_BATCH_SIZE = 8;
// Background segment trimming retries on this cadence. A trim failure is
// normally transient -- a briefly full or read-only filesystem, a maintenance
// worker restart -- so it must not become permanent.
const MAINTENANCE_RETRY_DELAY_MS = 1_000;
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
  readonly payloadOffset?: number;
  readonly payloadLength?: number;
  readonly segment?: StoredSegment;
}

interface StoredSegment {
  readonly path: string;
  readonly firstSequence: bigint;
  readonly capacity: number;
  readonly size: number;
  logicalSize: number;
  liveRecords: number;
  frameCount: number;
  manifestFlagPending: boolean;
  handle?: FileHandle;
}

interface HotSpareSegment {
  path: string;
  readonly generation: bigint;
  readonly size: number;
  readonly handle: FileHandle;
}

interface ScannedRecord extends QwpIngressReplayReference {
  readonly payloadOffset: number;
}

interface RecoveredStoredRecord {
  readonly record: ScannedRecord;
  readonly stored: StoredRecord;
}

interface EncodedRecord {
  readonly header: Buffer;
  readonly payload: Uint8Array;
  readonly byteLength: number;
}

interface SegmentScanScratch {
  readonly segmentHeader: Buffer;
  readonly frameHeader: Buffer;
  readonly data: Buffer;
}

interface PendingCapacity {
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Frames discarded while recovering a damaged journal. Emitted instead of
 * failing recovery when the damage sits in the active segment, matching the
 * Java client, which zeroes an active torn tail by policy and reports the
 * residue through a WARN plus MmapSegment.tornTailBytes().
 */
export interface QwpNodeReplayDataLossReport {
  readonly directory: string;
  readonly segmentFile: string;
  /** Bytes after the damaged record that recovery could not reach. */
  readonly discardedBytes: number;
  readonly reason: string;
}

export interface QwpNodeFileReplayStoreOptions {
  /** Exclusive directory used by one ingress session. */
  directory: string;
  /**
   * Target maximum journal size including fixed segment reservations and
   * symbol metadata. Defaults to 1 GiB. The current symbol dictionary may
   * exceed this target so it cannot consume the journal's live frame budget
   * before a drained close retires that dictionary generation.
   */
  maxBytes?: number;
  /**
   * Maximum QWP frame payload and target segment data size. Each fixed segment
   * reserves this value plus one record header and its 24-byte SFA header,
   * so a maximum-sized frame still fits. Defaults to 4 MiB.
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
  /**
   * Reports journal bytes abandoned during recovery. Defaults to logging at
   * error level; recovery still succeeds, so this must never be silent.
   */
  onRecoveryDataLoss?: (report: QwpNodeReplayDataLossReport) => void;
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
  ) {
    const holder = holderPid === undefined ? "unknown" : String(holderPid);
    super(
      `QWP store-and-forward directory is already in use [directory=${directory}, holder=${holder}]`,
    );
    this.name = "QwpReplayStoreLockedError";
  }
}

/**
 * Store-and-forward cannot run because its optional native locking module is
 * missing or has no binding for this platform. There is no lock-free fallback:
 * the lock is what keeps a second process, Node or Java, off the same slot.
 */
export class QwpReplayStoreUnavailableError extends QwpReplayStoreError {
  constructor(
    readonly directory: string,
    cause: unknown,
  ) {
    super(
      "QWP store-and-forward requires the optional native module " +
        `'fs-ext-extra-prebuilt', which could not be loaded [directory=${directory}, ` +
        `platform=${process.platform}-${process.arch}]`,
      cause,
    );
    this.name = "QwpReplayStoreUnavailableError";
  }
}

/**
 * Node store-and-forward journal with configurable local durability.
 *
 * The active fixed-size segment and one hot spare remain open for positional
 * writes. `append` fsyncs each frame, `periodic` batches barriers, and `memory`
 * relies on OS writeback. An ACK persists its cursor before bounded background
 * trimming. A crash between the server ACK and local deletion can cause
 * at-least-once replay. An exclusive, lifetime lock prevents another process
 * from recovering or mutating the same directory.
 */
export class QwpNodeFileReplayStore implements QwpIngressReplayStore {
  private readonly directory: string;
  private readonly maxBytes: number;
  private readonly maxSegmentBytes: number;
  private readonly segmentFileSize: number;
  private readonly liveFrameBytes: number;
  private readonly durability: QwpSfDurability;
  private readonly checkpointIntervalMs: number;
  private readonly backpressurePolicy: QwpSfBackpressurePolicy;
  private readonly appendDeadlineMs: number;
  private readonly onRecoveryDataLoss?: (
    report: QwpNodeReplayDataLossReport,
  ) => void;
  private readonly records = new Map<bigint, StoredRecord>();
  private readonly segments = new Map<string, StoredSegment>();
  private readonly segmentOrder: StoredSegment[] = [];
  private readonly symbols: string[] = [];
  private readonly symbolValues = new Set<string>();
  private readonly dirtyRecordPaths = new Set<string>();
  private readonly capacityWaiters = new Set<PendingCapacity>();
  private readonly pendingTrimSegments: StoredSegment[] = [];
  private operationTail: Promise<void> = Promise.resolve();
  private totalBytes = 0;
  private dictionaryFileSize = 0;
  private dictionaryLoadError?: unknown;
  private acknowledgedThrough = -1n;
  private dictionaryDirty = false;
  private acknowledgementDirty = false;
  private directoryDirty = false;
  private capacityGeneration = 0;
  private checkpointTimer?: ReturnType<typeof setTimeout>;
  private checkpointFailure?: QwpReplayStoreCheckpointError;
  private maintenanceFailure?: QwpReplayStoreError;
  private maintenanceRetryTimer?: ReturnType<typeof setTimeout>;
  private totalCheckpoints = 0;
  private totalCheckpointFailures = 0;
  private totalBackpressureStalls = 0;
  private totalAppendTimeouts = 0;
  private slotLock?: QwpNodeAdvisoryLock;
  private closePromise?: Promise<void>;
  private loaded = false;
  private closing = false;
  private closed = false;
  private activeSegment?: StoredSegment;
  private hotSpare?: HotSpareSegment;
  private hotSpareTask?: Promise<void>;
  private nextSegmentGeneration = 0n;
  private manifestGeneration = 0n;
  private manifestHeadBase?: bigint;
  private manifestActiveBase?: bigint;
  private manifestInvalid = false;
  private ackGeneration = 0n;
  private maintenanceScheduled = false;

  constructor(options: QwpNodeFileReplayStoreOptions) {
    const directory = options.directory.trim();
    if (!directory) {
      throw new RangeError("store-and-forward directory must not be empty");
    }
    const maxBytes = options.maxBytes ?? 1024 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= SEGMENT_HEADER_SIZE) {
      throw new RangeError(
        `store-and-forward maxBytes must be a safe integer greater than ${SEGMENT_HEADER_SIZE}`,
      );
    }
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.maxSegmentBytes = validatePositiveSafeInteger(
      options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES,
      "store-and-forward maxSegmentBytes",
    );
    if (this.maxSegmentBytes > 0xffffffff) {
      throw new RangeError(
        "store-and-forward maxSegmentBytes must fit in uint32",
      );
    }
    this.segmentFileSize =
      SEGMENT_HEADER_SIZE + FRAME_HEADER_SIZE + this.maxSegmentBytes;
    if (!Number.isSafeInteger(this.segmentFileSize)) {
      throw new RangeError(
        "store-and-forward maxSegmentBytes is too large for a fixed segment",
      );
    }
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
    this.onRecoveryDataLoss = options.onRecoveryDataLoss;
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

  async load(): Promise<readonly QwpIngressReplayRecord[]> {
    const references = await this.loadReferences();
    const records: QwpIngressReplayRecord[] = [];
    for (const reference of references) {
      records.push({
        frameSequence: reference.frameSequence,
        payload: await this.readPayload(reference.frameSequence),
      });
    }
    return records;
  }

  loadReferences(): Promise<readonly QwpIngressReplayReference[]> {
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
      const recoveryHandles = new Set<FileHandle>();
      try {
        await this.acquireDirectoryLock();
        const entries = await readdir(this.directory, { withFileTypes: true });
        const segmentNames: string[] = [];
        let removedTemporaryFile = false;
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          if (entry.name.includes(TEMP_MARKER)) {
            await ignoreMissing(unlink(join(this.directory, entry.name)));
            removedTemporaryFile = true;
          } else if (entry.name.endsWith(SEGMENT_SUFFIX)) {
            segmentNames.push(entry.name);
          }
        }
        if (removedTemporaryFile) await syncDirectory(this.directory);
        segmentNames.sort();

        await this.loadManifest();
        const acknowledgedThrough = await this.loadAcknowledgedThrough();
        const recoveredEntries: RecoveredStoredRecord[] = [];
        const recoveredSegments: Array<{
          readonly name: string;
          readonly path: string;
          readonly decoded: DecodedSegment;
          readonly handle: FileHandle;
        }> = [];
        const scanScratch: SegmentScanScratch = {
          segmentHeader: Buffer.allocUnsafe(SEGMENT_HEADER_SIZE),
          frameHeader: Buffer.allocUnsafe(FRAME_HEADER_SIZE),
          data: Buffer.allocUnsafe(64 * 1024),
        };
        for (const name of segmentNames) {
          const path = join(this.directory, name);
          let handle: FileHandle | undefined;
          try {
            handle = await open(path, "r+");
            const decoded = await scanSegment(handle, name, scanScratch);
            const generation = parseSegmentGeneration(name);
            if (generation !== undefined) {
              this.nextSegmentGeneration = maxBigInt(
                this.nextSegmentGeneration,
                generation + 1n,
              );
            }
            recoveredSegments.push({ name, path, decoded, handle });
            recoveryHandles.add(handle);
            handle = undefined;
          } catch (error) {
            await handle?.close().catch(() => undefined);
            if (error instanceof QwpReplayStoreError) throw error;
            throw new QwpReplayStoreError(
              `could not scan QWP store-and-forward segment [file=${name}]`,
              error,
            );
          }
        }
        recoveredSegments.sort((left, right) =>
          compareBigInt(
            left.decoded.firstSequence,
            right.decoded.firstSequence,
          ),
        );
        const selectedActivePath = selectRecoveredActivePath(
          recoveredSegments,
          this.manifestActiveBase,
        );
        const manifestStalePaths = await this.validateRecoveredManifest(
          recoveredSegments,
          selectedActivePath,
        );
        let changedDirectory = false;
        const removalPaths: string[] = [];
        for (let index = 0; index < recoveredSegments.length; index++) {
          const { name, path, decoded, handle } = recoveredSegments[index];
          if (manifestStalePaths.has(path)) {
            await handle.close();
            recoveryHandles.delete(handle);
            removalPaths.push(path);
            changedDirectory = true;
            continue;
          }
          if (decoded.tornTail) {
            if (path !== selectedActivePath) {
              throw corruptRecord(
                name,
                "non-active segment has a torn record tail",
              );
            }
            if (decoded.interiorDamage) {
              // The active segment's residue is abandoned by policy, matching
              // the Java client: past a mid-file tear the frames behind it are
              // unreachable anyway, because replay requires a contiguous
              // sequence and the tear breaks it. Recovery therefore proceeds on
              // the valid prefix, but the loss is always reported -- discarding
              // it silently is what made this dangerous.
              this.reportRecoveryDataLoss({
                directory: this.directory,
                segmentFile: name,
                discardedBytes: Math.max(
                  0,
                  decoded.size - SEGMENT_HEADER_SIZE - decoded.logicalSize,
                ),
                reason:
                  "a damaged record is followed by intact records that replay can no longer reach",
              });
            }
            await repairSegmentTail(
              path,
              SEGMENT_HEADER_SIZE + decoded.logicalSize,
              decoded.size,
              this.directory,
            );
          }
          if (
            decoded.records.length > 0 &&
            decoded.records[0].frameSequence !== decoded.firstSequence
          ) {
            throw corruptRecord(
              name,
              `first record sequence does not match segment base [base=${decoded.firstSequence}, received=${decoded.records[0].frameSequence}]`,
            );
          }
          const liveRecords = decoded.records.filter(
            (record) => record.frameSequence > acknowledgedThrough,
          );
          const retainEmptyActive =
            decoded.records.length === 0 && path === selectedActivePath;
          if (liveRecords.length === 0 && !retainEmptyActive) {
            await handle.close();
            recoveryHandles.delete(handle);
            removalPaths.push(path);
            changedDirectory = true;
            continue;
          }
          const segment: StoredSegment = {
            path,
            firstSequence: decoded.firstSequence,
            capacity: decoded.capacity,
            size: decoded.size,
            logicalSize: decoded.logicalSize,
            liveRecords: liveRecords.length,
            frameCount: decoded.records.length,
            manifestFlagPending: false,
            handle,
          };
          this.segments.set(path, segment);
          this.segmentOrder.push(segment);
          recoveryHandles.delete(handle);
          this.totalBytes += segment.size;
          for (const record of liveRecords) {
            recoveredEntries.push({
              record,
              stored: {
                path,
                size: 0,
                payloadOffset: record.payloadOffset,
                payloadLength: record.payloadLength,
                segment,
              },
            });
          }
          if (path === selectedActivePath) {
            this.activeSegment = segment;
          }
        }
        if (this.segments.size > 0) {
          await this.rewriteManifestForCurrentSegments();
          for (const segment of this.segments.values()) {
            await markSegmentManifestRequired(segment.path);
          }
        } else if (
          removalPaths.length > 0 &&
          this.manifestHeadBase !== undefined
        ) {
          const collapsed =
            acknowledgedThrough >= 0n
              ? acknowledgedThrough + 1n
              : (this.manifestActiveBase ?? this.manifestHeadBase);
          await this.writeManifest(collapsed, collapsed);
        }
        for (const path of removalPaths) await ignoreMissing(unlink(path));
        if (this.segments.size === 0) await this.removeManifest();
        if (changedDirectory) await syncDirectory(this.directory);
        recoveredEntries.sort((left, right) =>
          left.record.frameSequence < right.record.frameSequence
            ? -1
            : left.record.frameSequence > right.record.frameSequence
              ? 1
              : 0,
        );
        let previous = acknowledgedThrough;
        const recovered: QwpIngressReplayReference[] = [];
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
          recovered.push({
            frameSequence: record.frameSequence,
            payloadLength: record.payloadLength,
          });
          previous = record.frameSequence;
        }
        if (recovered.length === 0 && acknowledgedThrough >= 0n) {
          await this.removeAcknowledgedThrough();
        }
        try {
          await this.loadDictionaryFile();
        } catch (error) {
          // Frame recovery decides whether this sidecar is load-bearing. Keep
          // the file untouched until the ordered committed-frame scan either
          // reconstructs it completely or rejects the slot as unreplayable.
          this.symbols.length = 0;
          this.symbolValues.clear();
          this.dictionaryFileSize = 0;
          this.dictionaryLoadError = error;
        }
        this.loaded = true;
        await this.ensureHotSpare(false);
        loadSucceeded = true;
        this.scheduleCheckpoint();
        return recovered;
      } finally {
        if (!loadSucceeded) {
          try {
            await Promise.all([
              this.closeSegmentHandles(),
              ...[...recoveryHandles].map((handle) =>
                handle.close().catch(() => undefined),
              ),
            ]);
          } finally {
            await this.releaseDirectoryLock();
          }
        }
      }
    });
  }

  readPayload(frameSequence: bigint): Promise<Uint8Array> {
    if (this.closing || this.closed) return Promise.reject(this.closedError());
    return this.enqueue(async () => {
      this.assertReady();
      const stored = this.records.get(frameSequence);
      if (
        !stored?.segment ||
        stored.payloadOffset === undefined ||
        stored.payloadLength === undefined
      ) {
        throw new QwpReplayStoreError(
          `QWP store-and-forward frame is not available [frameSequence=${frameSequence}]`,
        );
      }
      let handle = stored.segment.handle;
      if (!handle) {
        handle = await open(stored.segment.path, "r+");
        stored.segment.handle = handle;
      }
      const payload = new Uint8Array(stored.payloadLength);
      await readFully(handle, payload, stored.payloadOffset);
      return payload;
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
        if (this.activeSegment === segment) this.activeSegment = undefined;
        this.pendingTrimSegments.push(segment);
      }
      this.scheduleMaintenance();
    });
  }

  loadSymbolDictionary(): Promise<readonly string[]> {
    if (this.closing || this.closed) return Promise.reject(this.closedError());
    return this.enqueue(async () => {
      this.assertReady();
      if (this.dictionaryLoadError) throw this.dictionaryLoadError;
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
      if (this.dictionaryLoadError) throw this.dictionaryLoadError;
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

  replaceSymbolDictionary(entries: readonly string[]): Promise<void> {
    if (this.closing || this.closed) return Promise.reject(this.closedError());
    return this.enqueue(async () => {
      this.assertReady();
      validateReplacementDictionary(entries);
      const finalPath = join(this.directory, DICTIONARY_FILE);
      const previousSize = this.dictionaryFileSize;
      if (entries.length === 0) {
        try {
          await ignoreMissing(unlink(finalPath));
          if (this.durability === QWP_SF_DURABILITY.APPEND) {
            await syncDirectory(this.directory);
          } else if (this.durability === QWP_SF_DURABILITY.PERIODIC) {
            this.directoryDirty = true;
          }
        } catch (error) {
          throw new QwpReplayStoreError(
            "could not remove unusable QWP symbol dictionary",
            error,
          );
        }
        this.symbols.length = 0;
        this.symbolValues.clear();
        this.totalBytes -= previousSize;
        this.dictionaryFileSize = 0;
        this.dictionaryLoadError = undefined;
        this.dictionaryDirty = false;
        return;
      }

      const replacement = Buffer.concat([
        encodeDictionaryHeader(),
        encodeDictionaryBlock(0, entries),
      ]);
      const temporaryPath = join(
        this.directory,
        `${DICTIONARY_FILE}${TEMP_MARKER}${process.pid}-${randomUUID()}`,
      );
      try {
        const file = await open(temporaryPath, "wx", 0o600);
        try {
          await file.writeFile(replacement);
          if (this.durability === QWP_SF_DURABILITY.APPEND) {
            await file.sync();
          }
        } finally {
          await file.close();
        }
        await ignoreMissing(unlink(finalPath));
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
          "could not replace unusable QWP symbol dictionary",
          error,
        );
      }
      this.symbols.length = 0;
      this.symbols.push(...entries);
      this.symbolValues.clear();
      for (const entry of entries) this.symbolValues.add(entry);
      this.totalBytes = this.totalBytes - previousSize + replacement.byteLength;
      this.dictionaryFileSize = replacement.byteLength;
      this.dictionaryLoadError = undefined;
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = undefined;
    if (this.maintenanceRetryTimer) clearTimeout(this.maintenanceRetryTimer);
    this.maintenanceRetryTimer = undefined;
    this.rejectCapacityWaiters(this.closedError());
    this.closePromise = this.operationTail.then(async () => {
      let failure: unknown;
      try {
        await this.drainPendingMaintenance();
        if (this.durability === QWP_SF_DURABILITY.PERIODIC) {
          await this.checkpointDirty();
        }
        if (this.checkpointFailure) throw this.checkpointFailure;
        await this.retireDrainedDictionary();
      } catch (error) {
        failure = error;
      }
      try {
        await this.hotSpareTask?.catch((error) => {
          failure ??= error;
        });
        await this.discardHotSpare();
        await this.closeSegmentHandles();
      } catch (error) {
        failure ??= error;
      }
      if (!failure && this.loaded && this.records.size === 0) {
        // Java retires the parent-anchored pair once the slot is permanently
        // drained. Keep the local slot lock held throughout this best-effort
        // cleanup so a racing drainer cannot adopt the old directory.
        await QwpNodeAdvisoryLock.removeOrphanLogical(this.directory);
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
    bytes: EncodedRecord,
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
    bytes: EncodedRecord,
  ): Promise<void> {
    this.assertReady();
    validateFrameSequence(record.frameSequence);
    if (this.records.has(record.frameSequence)) {
      throw new QwpReplayStoreError(
        `QWP store-and-forward sequence already exists [frameSequence=${record.frameSequence}]`,
      );
    }
    const lastSequence =
      lastMapKey(this.records) ??
      (this.acknowledgedThrough >= 0n ? this.acknowledgedThrough : undefined);
    if (
      lastSequence !== undefined &&
      record.frameSequence !== lastSequence + 1n
    ) {
      throw new QwpReplayStoreError(
        `QWP store-and-forward sequence must be contiguous [previous=${lastSequence}, received=${record.frameSequence}]`,
      );
    }
    let segment = this.activeSegment;
    if (!segment || segment.logicalSize + bytes.byteLength > segment.capacity) {
      segment = await this.activateHotSpare(record.frameSequence);
    }
    const expectedSequence = segment.firstSequence + BigInt(segment.frameCount);
    if (record.frameSequence !== expectedSequence) {
      throw new QwpReplayStoreError(
        `QWP store-and-forward segment sequence must be contiguous [expected=${expectedSequence}, received=${record.frameSequence}]`,
      );
    }
    const handle = segment.handle;
    if (!handle) {
      throw new QwpReplayStoreError(
        `active QWP store-and-forward segment is not open [file=${segment.path}]`,
      );
    }
    if (segment.manifestFlagPending) {
      try {
        await writeFully(handle, Uint8Array.of(MANIFEST_REQUIRED_FLAG), 5);
        await handle.sync();
        segment.manifestFlagPending = false;
      } catch (error) {
        throw new QwpReplayStoreError(
          `could not stamp the QWP store-and-forward manifest-required flag [file=${segment.path}]`,
          error,
        );
      }
    }
    const writeOffset = SEGMENT_HEADER_SIZE + segment.logicalSize;
    try {
      await writevFully(handle, [bytes.header, bytes.payload], writeOffset);
      if (this.durability === QWP_SF_DURABILITY.APPEND) {
        await handle.datasync();
      } else if (this.durability === QWP_SF_DURABILITY.PERIODIC) {
        this.dirtyRecordPaths.add(segment.path);
      }
    } catch (error) {
      // The fixed file cannot be shortened without losing its reservation.
      // Clear the attempted range so recovery still observes canonical zero
      // padding if the caller retries after a transient write failure.
      await zeroRange(handle, writeOffset, bytes.byteLength).catch(
        () => undefined,
      );
      throw new QwpReplayStoreError(
        `could not append QWP store-and-forward segment [frameSequence=${record.frameSequence}]`,
        error,
      );
    }
    segment.logicalSize += bytes.byteLength;
    segment.liveRecords++;
    segment.frameCount++;
    this.records.set(record.frameSequence, {
      path: segment.path,
      size: 0,
      payloadOffset: writeOffset + FRAME_HEADER_SIZE,
      payloadLength: record.payload.byteLength,
      segment,
    });
    this.scheduleHotSpare();
  }

  private async activateHotSpare(
    firstSequence: bigint,
  ): Promise<StoredSegment> {
    const previous = this.activeSegment;
    if (previous?.handle) {
      if (this.durability === QWP_SF_DURABILITY.PERIODIC) {
        await previous.handle.datasync();
        this.dirtyRecordPaths.delete(previous.path);
      }
    }
    await this.ensureHotSpare(true);
    const spare = this.hotSpare;
    if (!spare) {
      throw new QwpReplayStoreFullError(
        this.maxBytes,
        this.totalBytes + this.segmentFileSize,
      );
    }
    const finalPath = join(this.directory, segmentFileName(spare.generation));
    try {
      // Publish a manifest-optional empty segment first. If the process dies
      // before the manifest update, recovery can safely adopt this file. Once
      // the durable boundary names it, flip the header flag so future recovery
      // must fail closed if the manifest disappears.
      await writeFully(
        spare.handle,
        encodeSegmentHeader(firstSequence, false),
        0,
      );
      await spare.handle.sync();
      await rename(spare.path, finalPath);
      spare.path = finalPath;
      await syncDirectory(this.directory);
      await this.advanceManifestForActivation(firstSequence);
    } catch (error) {
      throw new QwpReplayStoreError(
        `could not activate QWP store-and-forward hot spare [frameSequence=${firstSequence}]`,
        error,
      );
    }
    const segment: StoredSegment = {
      path: finalPath,
      firstSequence,
      capacity: spare.size - SEGMENT_HEADER_SIZE,
      size: spare.size,
      logicalSize: 0,
      liveRecords: 0,
      frameCount: 0,
      manifestFlagPending: true,
      handle: spare.handle,
    };
    this.hotSpare = undefined;
    this.segments.set(segment.path, segment);
    this.segmentOrder.push(segment);
    this.activeSegment = segment;
    try {
      await writeFully(spare.handle, Uint8Array.of(MANIFEST_REQUIRED_FLAG), 5);
      await spare.handle.sync();
      segment.manifestFlagPending = false;
    } catch (error) {
      // The manifest already durably names this segment, so it must remain in
      // the ring. The next append retries only the idempotent flag stamp.
      throw new QwpReplayStoreError(
        `could not stamp the QWP store-and-forward manifest-required flag [file=${segment.path}]`,
        error,
      );
    }
    if (previous && previous.liveRecords === 0) {
      await this.trimSegment(previous);
    }
    return segment;
  }

  private async ensureHotSpare(required: boolean): Promise<void> {
    if (this.hotSpare) return;
    if (this.hotSpareTask) {
      await this.hotSpareTask;
      return;
    }
    if (this.closing || this.closed) return;
    const provisioning = this.provisionHotSpare(required);
    this.hotSpareTask = provisioning;
    try {
      await provisioning;
    } finally {
      if (this.hotSpareTask === provisioning) this.hotSpareTask = undefined;
    }
  }

  private async provisionHotSpare(required: boolean): Promise<void> {
    const requiredBytes = this.totalBytes + this.segmentFileSize;
    const frameBytes = this.totalBytes - this.dictionaryFileSize;
    const preservesLiveness =
      this.dictionaryFileSize > 0 &&
      (frameBytes < this.liveFrameBytes || this.segments.size === 0);
    if (requiredBytes > this.maxBytes && !preservesLiveness) {
      if (required) {
        throw new QwpReplayStoreFullError(this.maxBytes, requiredBytes);
      }
      return;
    }
    const generation = this.nextSegmentGeneration++;
    const name = segmentFileName(generation);
    const temporaryPath = join(
      this.directory,
      `${name}${TEMP_MARKER}${process.pid}-${randomUUID()}`,
    );
    let handle: FileHandle | undefined;
    this.totalBytes = requiredBytes;
    try {
      await qwpSegmentMaintenanceWorker.provision(
        temporaryPath,
        this.segmentFileSize,
        this.durability === QWP_SF_DURABILITY.APPEND,
      );
      handle = await open(temporaryPath, "r+");
      if (this.closing || this.closed) {
        await handle.close();
        handle = undefined;
        await qwpSegmentMaintenanceWorker.unlink(temporaryPath);
        this.totalBytes -= this.segmentFileSize;
        return;
      }
      this.hotSpare = {
        path: temporaryPath,
        generation,
        size: this.segmentFileSize,
        handle,
      };
      handle = undefined;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await qwpSegmentMaintenanceWorker
        .unlink(temporaryPath)
        .catch(() => undefined);
      this.totalBytes -= this.segmentFileSize;
      throw new QwpReplayStoreError(
        `could not provision QWP store-and-forward hot spare [generation=${generation}]`,
        error,
      );
    }
  }

  private scheduleHotSpare(): void {
    if (this.hotSpare || this.closing || this.closed) return;
    queueMicrotask(() => {
      if (this.hotSpare || this.closing || this.closed) return;
      void this.ensureHotSpare(false).catch(() => {
        // Capacity exhaustion is expected: ACK trimming will make a later
        // rotation retry provisioning synchronously. Other failures surface on
        // that required path rather than as an unhandled background rejection.
      });
    });
  }

  private scheduleMaintenance(): void {
    if (
      this.maintenanceScheduled ||
      this.pendingTrimSegments.length === 0 ||
      this.closing ||
      this.closed
    ) {
      return;
    }
    this.maintenanceScheduled = true;
    queueMicrotask(() => {
      if (this.closing || this.closed) {
        this.maintenanceScheduled = false;
        return;
      }
      void this.enqueue(() => this.runMaintenanceBatch()).catch((error) => {
        this.maintenanceScheduled = false;
        this.maintenanceFailure =
          error instanceof QwpReplayStoreError
            ? error
            : new QwpReplayStoreError(
                `QWP store-and-forward background maintenance failed [directory=${this.directory}]`,
                error,
              );
        this.rejectCapacityWaiters(this.maintenanceFailure);
        this.scheduleMaintenanceRetry();
      });
    });
  }

  private async runMaintenanceBatch(): Promise<void> {
    this.maintenanceScheduled = false;
    let trimmed = 0;
    while (trimmed < TRIM_BATCH_SIZE && this.pendingTrimSegments.length > 0) {
      const segment = this.pendingTrimSegments[0];
      await this.trimSegment(segment);
      this.pendingTrimSegments.shift();
      trimmed++;
    }
    if (trimmed > 0) {
      if (this.durability === QWP_SF_DURABILITY.APPEND) {
        await qwpSegmentMaintenanceWorker.syncDirectory(this.directory);
      } else if (this.durability === QWP_SF_DURABILITY.PERIODIC) {
        this.directoryDirty = true;
      }
      this.signalCapacity();
      this.scheduleHotSpare();
    }
    if (this.records.size === 0 && this.pendingTrimSegments.length === 0) {
      await this.removeAcknowledgedThrough();
    }
    if (this.pendingTrimSegments.length > 0) this.scheduleMaintenance();
    // The batch completed, so whatever made the previous one fail is gone.
    // Mirrors checkpointDirty(), which clears checkpointFailure on success.
    this.maintenanceFailure = undefined;
  }

  private scheduleMaintenanceRetry(): void {
    if (
      this.maintenanceRetryTimer ||
      this.closing ||
      this.closed ||
      this.pendingTrimSegments.length === 0
    ) {
      return;
    }
    this.maintenanceRetryTimer = setTimeout(() => {
      this.maintenanceRetryTimer = undefined;
      if (this.closing || this.closed) return;
      this.scheduleMaintenance();
    }, MAINTENANCE_RETRY_DELAY_MS);
    this.maintenanceRetryTimer.unref?.();
  }

  private async drainPendingMaintenance(): Promise<void> {
    this.maintenanceFailure = undefined;
    while (this.pendingTrimSegments.length > 0) {
      await this.runMaintenanceBatch();
    }
    if (this.records.size === 0) await this.removeAcknowledgedThrough();
  }

  private async trimSegment(segment: StoredSegment): Promise<void> {
    try {
      await segment.handle?.close();
      segment.handle = undefined;
      const segmentIndex = this.segmentOrder.indexOf(segment);
      if (segmentIndex < 0) {
        throw new QwpReplayStoreError(
          `QWP store-and-forward segment is absent from the ordered ring [firstSequence=${segment.firstSequence}]`,
        );
      }
      if (this.segmentOrder.length > 1) {
        const head =
          segmentIndex === 0 ? this.segmentOrder[1] : this.segmentOrder[0];
        const active =
          segmentIndex === this.segmentOrder.length - 1
            ? this.segmentOrder[this.segmentOrder.length - 2]
            : this.segmentOrder[this.segmentOrder.length - 1];
        await this.writeManifest(head.firstSequence, active.firstSequence);
      } else {
        const collapsed = segment.firstSequence + BigInt(segment.frameCount);
        await this.writeManifest(collapsed, collapsed);
      }
      await qwpSegmentMaintenanceWorker.unlink(segment.path);
      if (this.segmentOrder.length === 1) await this.removeManifest();
    } catch (error) {
      throw new QwpReplayStoreError(
        `could not trim QWP store-and-forward segment [firstSequence=${segment.firstSequence}]`,
        error,
      );
    }
    this.segments.delete(segment.path);
    this.segmentOrder.splice(this.segmentOrder.indexOf(segment), 1);
    this.dirtyRecordPaths.delete(segment.path);
    this.totalBytes -= segment.size;
    if (this.activeSegment === segment) this.activeSegment = undefined;
  }

  private async closeSegmentHandles(): Promise<void> {
    const handles = new Set<FileHandle>();
    for (const segment of this.segments.values()) {
      if (segment.handle) handles.add(segment.handle);
      segment.handle = undefined;
    }
    if (this.hotSpare) handles.add(this.hotSpare.handle);
    this.hotSpare = undefined;
    let failure: unknown;
    for (const handle of handles) {
      try {
        await handle.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) {
      throw new QwpReplayStoreError(
        `could not close QWP store-and-forward segment handles [directory=${this.directory}]`,
        failure,
      );
    }
  }

  private async discardHotSpare(): Promise<void> {
    const spare = this.hotSpare;
    if (!spare) return;
    this.hotSpare = undefined;
    try {
      await spare.handle.close();
      await qwpSegmentMaintenanceWorker.unlink(spare.path);
      this.totalBytes -= spare.size;
      if (this.durability !== QWP_SF_DURABILITY.MEMORY) {
        await qwpSegmentMaintenanceWorker.syncDirectory(this.directory);
      }
    } catch (error) {
      throw new QwpReplayStoreError(
        `could not discard QWP store-and-forward hot spare [file=${spare.path}]`,
        error,
      );
    }
  }

  private waitForCapacity(
    capacityGeneration: number,
    timeoutMs: number,
    full: QwpReplayStoreFullError,
  ): Promise<void> {
    if (this.checkpointFailure) {
      return Promise.reject(this.checkpointFailure);
    }
    if (this.maintenanceFailure) {
      return Promise.reject(this.maintenanceFailure);
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
      const paths = [...this.dirtyRecordPaths];
      if (this.dictionaryDirty) {
        paths.push(join(this.directory, DICTIONARY_FILE));
      }
      if (this.acknowledgementDirty) {
        paths.push(join(this.directory, ACK_FILE));
      }
      await qwpSegmentMaintenanceWorker.checkpoint(
        paths,
        this.directoryDirty ? this.directory : undefined,
      );
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

  private async loadManifest(): Promise<void> {
    const path = join(this.directory, MANIFEST_FILE);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return;
      throw new QwpReplayStoreError(
        "could not read QWP store-and-forward manifest",
        error,
      );
    }
    if (bytes.byteLength !== DUAL_SLOT_FILE_SIZE) {
      this.manifestInvalid = true;
      return;
    }
    const record = decodeLatestMetadataRecord(bytes, MANIFEST_MAGIC);
    if (!record || record.first < 0n || record.second < record.first) {
      this.manifestInvalid = true;
      return;
    }
    this.manifestGeneration = record.generation;
    this.manifestHeadBase = record.first;
    this.manifestActiveBase = record.second;
  }

  private async validateRecoveredManifest(
    segments: readonly {
      readonly name: string;
      readonly path: string;
      readonly decoded: DecodedSegment;
    }[],
    selectedActivePath: string | undefined,
  ): Promise<Set<string>> {
    const stale = new Set<string>();
    const requiresManifest = segments.some(
      ({ decoded }) => decoded.manifestRequired,
    );
    if (
      this.manifestHeadBase === undefined ||
      this.manifestActiveBase === undefined
    ) {
      if (requiresManifest) {
        throw new QwpReplayStoreCorruptionError(
          `QWP store-and-forward segments require a valid ${MANIFEST_FILE}`,
        );
      }
      if (this.manifestInvalid) {
        await ignoreMissing(unlink(join(this.directory, MANIFEST_FILE)));
        await syncDirectory(this.directory);
        this.manifestInvalid = false;
      }
      for (const { decoded, path } of segments) {
        if (decoded.records.length > 0 || path === selectedActivePath) continue;
        if (decoded.tornTail) {
          throw new QwpReplayStoreCorruptionError(
            `QWP store-and-forward empty extra segment contains a torn tail [file=${path}]`,
          );
        }
        stale.add(path);
      }
      return stale;
    }

    const head = this.manifestHeadBase;
    const active = this.manifestActiveBase;
    if (segments.length === 0) {
      if (head !== active) {
        throw new QwpReplayStoreCorruptionError(
          `QWP store-and-forward manifest references a missing segment chain [headBase=${head}, activeBase=${active}]`,
        );
      }
      await this.removeManifest();
      return stale;
    }

    const committed = segments.filter(({ decoded, path }) => {
      if (decoded.records.length === 0 && path !== selectedActivePath) {
        if (decoded.tornTail) {
          throw new QwpReplayStoreCorruptionError(
            `QWP store-and-forward empty extra segment contains a torn tail [file=${path}]`,
          );
        }
        stale.add(path);
        return false;
      }
      if (decoded.firstSequence < head) {
        const end = decoded.firstSequence + BigInt(decoded.records.length);
        if (end > head) {
          throw new QwpReplayStoreCorruptionError(
            `QWP store-and-forward segment overlaps the manifest head boundary [base=${decoded.firstSequence}, end=${end}, headBase=${head}]`,
          );
        }
        stale.add(path);
        return false;
      }
      if (decoded.firstSequence > active) {
        if (decoded.records.length !== 0) {
          throw new QwpReplayStoreCorruptionError(
            `QWP store-and-forward segment lies beyond the manifest active boundary [file=${decoded.firstSequence}, activeBase=${active}]`,
          );
        }
        stale.add(path);
        return false;
      }
      return true;
    });
    if (
      committed.length === 0 ||
      committed[0].decoded.firstSequence !== head ||
      committed[committed.length - 1].decoded.firstSequence !== active
    ) {
      if (committed.length === 0 && head === active) return stale;
      throw new QwpReplayStoreCorruptionError(
        `QWP store-and-forward manifest boundaries do not match the segment chain [headBase=${head}, activeBase=${active}]`,
      );
    }
    for (let index = 1; index < committed.length; index++) {
      const previous = committed[index - 1].decoded;
      const expected = previous.firstSequence + BigInt(previous.records.length);
      if (committed[index].decoded.firstSequence !== expected) {
        throw new QwpReplayStoreCorruptionError(
          `QWP store-and-forward segment chain has a gap [previousBase=${previous.firstSequence}, expected=${expected}, received=${committed[index].decoded.firstSequence}]`,
        );
      }
    }
    return stale;
  }

  private async advanceManifestForActivation(
    firstSequence: bigint,
  ): Promise<void> {
    const head = this.manifestHeadBase ?? firstSequence;
    await this.writeManifest(head, firstSequence);
  }

  private async rewriteManifestForCurrentSegments(): Promise<void> {
    if (this.segmentOrder.length === 0) {
      await this.removeManifest();
      return;
    }
    await this.writeManifest(
      this.segmentOrder[0].firstSequence,
      this.segmentOrder[this.segmentOrder.length - 1].firstSequence,
    );
  }

  private async writeManifest(
    headBase: bigint,
    activeBase: bigint,
  ): Promise<void> {
    if (this.manifestGeneration > 0n) {
      if (
        this.manifestHeadBase !== undefined &&
        headBase < this.manifestHeadBase
      ) {
        headBase = this.manifestHeadBase;
      }
      if (
        this.manifestActiveBase !== undefined &&
        activeBase < this.manifestActiveBase
      ) {
        activeBase = this.manifestActiveBase;
      }
      if (
        headBase === this.manifestHeadBase &&
        activeBase === this.manifestActiveBase
      ) {
        return;
      }
    }
    if (headBase < 0n || activeBase < headBase) {
      throw new QwpReplayStoreCorruptionError(
        `invalid QWP store-and-forward manifest boundaries [headBase=${headBase}, activeBase=${activeBase}]`,
      );
    }
    const path = join(this.directory, MANIFEST_FILE);
    const nextGeneration = this.manifestGeneration + 1n;
    const file = await openMetadataFile(path);
    try {
      const record = encodeMetadataRecord(
        MANIFEST_MAGIC,
        nextGeneration,
        headBase,
        activeBase,
      );
      await writeFully(
        file,
        record,
        Number((nextGeneration & 1n) * BigInt(RECORD_SLOT_SIZE)),
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await syncDirectory(this.directory);
    this.manifestGeneration = nextGeneration;
    this.manifestHeadBase = headBase;
    this.manifestActiveBase = activeBase;
    this.manifestInvalid = false;
  }

  private async removeManifest(): Promise<void> {
    await ignoreMissing(unlink(join(this.directory, MANIFEST_FILE)));
    await syncDirectory(this.directory);
    this.manifestGeneration = 0n;
    this.manifestHeadBase = undefined;
    this.manifestActiveBase = undefined;
    this.manifestInvalid = false;
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
    if (bytes.byteLength !== DUAL_SLOT_FILE_SIZE) {
      // A wrong-sized file is not valid dual-slot metadata. The watermark is
      // only a duplicate-suppression hint, so resetting it is conservative.
      await replaceFile(
        path,
        Buffer.alloc(DUAL_SLOT_FILE_SIZE),
        this.directory,
      );
      this.ackGeneration = 0n;
      this.acknowledgedThrough = -1n;
      return this.acknowledgedThrough;
    }
    const record = decodeLatestMetadataRecord(bytes, ACK_MAGIC);
    if (!record || record.first < -1n) {
      this.ackGeneration = 0n;
      this.acknowledgedThrough = -1n;
      return this.acknowledgedThrough;
    }
    this.ackGeneration = record.generation;
    this.acknowledgedThrough = record.first;
    return this.acknowledgedThrough;
  }

  private async persistAcknowledgedThrough(
    frameSequence: bigint,
  ): Promise<void> {
    if (frameSequence <= this.acknowledgedThrough) return;
    const finalPath = join(this.directory, ACK_FILE);
    const nextGeneration = this.ackGeneration + 1n;
    const record = encodeMetadataRecord(
      ACK_MAGIC,
      nextGeneration,
      frameSequence,
      0n,
    );
    try {
      const file = await openMetadataFile(finalPath);
      try {
        await writeFully(
          file,
          record,
          Number((nextGeneration & 1n) * BigInt(RECORD_SLOT_SIZE)),
        );
        if (this.durability === QWP_SF_DURABILITY.APPEND) await file.sync();
      } finally {
        await file.close();
      }
      if (this.durability === QWP_SF_DURABILITY.PERIODIC) {
        this.acknowledgementDirty = true;
      }
      this.ackGeneration = nextGeneration;
      this.acknowledgedThrough = frameSequence;
    } catch (error) {
      throw new QwpReplayStoreError(
        `could not persist QWP store-and-forward ACK watermark [frameSequence=${frameSequence}]`,
        error,
      );
    }
  }

  /**
   * Recovery succeeded, so this must not throw: a reporting failure cannot be
   * allowed to brick a slot that is otherwise ready to replay. Without a
   * handler it logs, so abandoned journal bytes are never silent.
   */
  private reportRecoveryDataLoss(report: QwpNodeReplayDataLossReport): void {
    const message =
      `QWP store-and-forward discarded ${report.discardedBytes} journal byte(s) during recovery ` +
      `[directory=${report.directory}, segment=${report.segmentFile}]: ${report.reason}`;
    if (!this.onRecoveryDataLoss) {
      log("error", message);
      return;
    }
    try {
      this.onRecoveryDataLoss(report);
    } catch {
      log("error", message);
    }
  }

  private async removeAcknowledgedThrough(): Promise<void> {
    if (this.acknowledgedThrough < 0n) return;
    await ignoreMissing(unlink(join(this.directory, ACK_FILE)));
    this.acknowledgedThrough = -1n;
    this.ackGeneration = 0n;
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
    let logicalLock: QwpNodeAdvisoryLock | undefined;
    let failure: unknown;
    try {
      // Match Java's lock order. The parent-anchored guard closes the race
      // between orphan adoption and a close -> rename -> recreate transition.
      logicalLock = await QwpNodeAdvisoryLock.acquireLogical(this.directory);
      this.slotLock = await QwpNodeAdvisoryLock.acquire(this.directory);
    } catch (error) {
      if (error instanceof QwpNodeAdvisoryLockBusyError) {
        failure = new QwpReplayStoreLockedError(
          this.directory,
          error.holderPid,
        );
      } else if (error instanceof QwpNodeAdvisoryLockUnavailableError) {
        failure = new QwpReplayStoreUnavailableError(this.directory, error);
      } else {
        failure = new QwpReplayStoreError(
          `could not acquire QWP store-and-forward directory lock [directory=${this.directory}]`,
          error,
        );
      }
    }
    if (logicalLock) {
      try {
        await logicalLock.release();
      } catch (error) {
        failure ??= new QwpReplayStoreError(
          `could not release QWP store-and-forward logical lock [directory=${this.directory}]`,
          error,
        );
      }
    }
    if (failure) throw failure;
  }

  private async releaseDirectoryLock(): Promise<void> {
    const slotLock = this.slotLock;
    if (!slotLock) return;
    try {
      await slotLock.release();
      this.slotLock = undefined;
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
    if (bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) {
      throw corruptDictionary("reserved header bytes are not zero");
    }
    let offset = DICTIONARY_HEADER_SIZE;
    while (offset < bytes.byteLength) {
      const chunk = decodeDictionaryChunk(bytes, offset);
      if (!chunk) {
        await truncateDictionaryTail(path, offset, this.directory);
        break;
      }
      const startId = this.symbols.length;
      if (startId + chunk.entries.length > QWP_MAX_SYMBOL_DICTIONARY_SIZE) {
        throw corruptDictionary(
          `dictionary exceeds maximum size ${QWP_MAX_SYMBOL_DICTIONARY_SIZE}`,
        );
      }
      for (let index = 0; index < chunk.entries.length; index++) {
        const entry = chunk.entries[index];
        if (this.symbolValues.has(entry)) {
          throw corruptDictionary(
            `duplicate value at ID ${startId + index}: '${entry}'`,
          );
        }
        this.symbolValues.add(entry);
        this.symbols.push(entry);
      }
      offset = chunk.end;
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
    if (this.maintenanceFailure) throw this.maintenanceFailure;
  }

  private closedError(): QwpReplayStoreError {
    return new QwpReplayStoreError("QWP store-and-forward journal is closed");
  }
}

function encodeRecord(record: QwpIngressReplayRecord): EncodedRecord {
  validateFrameSequence(record.frameSequence);
  if (record.payload.byteLength > 0xffffffff) {
    throw new QwpReplayStoreError(
      `QWP frame is too large for the store-and-forward format [size=${record.payload.byteLength}]`,
    );
  }
  const header = Buffer.allocUnsafe(FRAME_HEADER_SIZE);
  header.writeUInt32LE(record.payload.byteLength, 4);
  header.writeUInt32LE(crc32cParts([header.subarray(4), record.payload]), 0);
  return {
    header,
    payload: record.payload,
    byteLength: FRAME_HEADER_SIZE + record.payload.byteLength,
  };
}

interface DecodedSegment {
  readonly firstSequence: bigint;
  readonly manifestRequired: boolean;
  readonly capacity: number;
  readonly size: number;
  readonly records: ScannedRecord[];
  /** Bytes occupied by encoded records, excluding the fixed segment header. */
  readonly logicalSize: number;
  readonly tornTail: boolean;
  /**
   * Set when structurally intact data still follows the damaged record, which
   * makes this a hole rather than an unwritten tail. Repairing it would delete
   * records that are still on disk, so recovery quarantines instead.
   */
  readonly interiorDamage?: boolean;
}

function selectRecoveredActivePath(
  segments: readonly {
    readonly name: string;
    readonly path: string;
    readonly decoded: DecodedSegment;
  }[],
  manifestActiveBase: bigint | undefined,
): string | undefined {
  if (manifestActiveBase !== undefined) {
    const candidates = segments.filter(
      ({ decoded }) => decoded.firstSequence === manifestActiveBase,
    );
    const data = candidates.filter(({ decoded }) => decoded.records.length > 0);
    if (data.length > 1) {
      throw new QwpReplayStoreCorruptionError(
        `multiple QWP store-and-forward data segments claim the manifest active base [activeBase=${manifestActiveBase}]`,
      );
    }
    if (data.length === 1) return data[0].path;
    const empty = candidates.filter(({ decoded }) => !decoded.tornTail);
    return (empty.find(({ name }) => name === "sf-initial.sfa") ?? empty[0])
      ?.path;
  }

  const data = segments.filter(({ decoded }) => decoded.records.length > 0);
  if (data.length > 0) return data[data.length - 1].path;
  const empty = segments.filter(({ decoded }) => !decoded.tornTail);
  return (empty.find(({ name }) => name === "sf-initial.sfa") ?? empty[0])
    ?.path;
}

function encodeSegmentHeader(
  firstSequence: bigint,
  manifestRequired: boolean,
): Buffer {
  validateFrameSequence(firstSequence);
  const bytes = Buffer.alloc(SEGMENT_HEADER_SIZE);
  SEGMENT_MAGIC.copy(bytes, 0);
  bytes.writeUInt8(FORMAT_VERSION, 4);
  bytes.writeUInt8(manifestRequired ? MANIFEST_REQUIRED_FLAG : 0, 5);
  bytes.writeUInt16LE(0, 6);
  bytes.writeBigUInt64LE(firstSequence, 8);
  bytes.writeBigUInt64LE(BigInt(Date.now()) * 1_000n, 16);
  return bytes;
}

async function scanSegment(
  handle: FileHandle,
  name: string,
  scratch: SegmentScanScratch,
): Promise<DecodedSegment> {
  const fileSize = (await handle.stat()).size;
  if (fileSize < SEGMENT_HEADER_SIZE) {
    throw corruptRecord(name, "fixed segment is shorter than its header");
  }
  const segmentHeader = scratch.segmentHeader;
  await readFully(handle, segmentHeader, 0);
  if (
    !segmentHeader.subarray(0, SEGMENT_MAGIC.byteLength).equals(SEGMENT_MAGIC)
  ) {
    throw corruptRecord(name, "invalid segment magic");
  }
  if (segmentHeader.readUInt8(4) !== FORMAT_VERSION) {
    throw corruptRecord(
      name,
      `unsupported segment version ${segmentHeader.readUInt8(4)}`,
    );
  }
  const flags = segmentHeader.readUInt8(5);
  if ((flags & ~MANIFEST_REQUIRED_FLAG) !== 0) {
    throw corruptRecord(name, `unsupported segment flags ${flags}`);
  }
  if (segmentHeader.readUInt16LE(6) !== 0) {
    throw corruptRecord(name, "segment reserved field is not zero");
  }
  const firstSequence = segmentHeader.readBigUInt64LE(8);
  validateFrameSequence(firstSequence);
  const capacity = fileSize - SEGMENT_HEADER_SIZE;
  const records: ScannedRecord[] = [];
  const frameHeader = scratch.frameHeader;
  const scanBuffer = scratch.data;
  let offset = SEGMENT_HEADER_SIZE;
  while (offset < fileSize) {
    const remaining = fileSize - offset;
    const headerBytes = Math.min(remaining, FRAME_HEADER_SIZE);
    await readFully(handle, frameHeader.subarray(0, headerBytes), offset);
    const zeroedHeader =
      frameHeader[0] === 0 && isZeroFilled(frameHeader, 0, headerBytes);
    if (zeroedHeader) {
      const paddingToEnd = await isZeroFilledFile(
        handle,
        offset + headerBytes,
        fileSize,
        scanBuffer,
      );
      return {
        firstSequence,
        manifestRequired: (flags & MANIFEST_REQUIRED_FLAG) !== 0,
        capacity,
        size: fileSize,
        records,
        logicalSize: offset - SEGMENT_HEADER_SIZE,
        // Padding to EOF is the ordinary unwritten tail. A zeroed record with
        // live bytes behind it is a lost block -- the shape an unordered
        // page-cache writeback leaves after a host crash -- so the records
        // after it are still intact and must not be truncated away.
        tornTail: !paddingToEnd,
        interiorDamage: !paddingToEnd,
      };
    }
    if (remaining < FRAME_HEADER_SIZE) {
      return {
        firstSequence,
        manifestRequired: (flags & MANIFEST_REQUIRED_FLAG) !== 0,
        capacity,
        size: fileSize,
        records,
        logicalSize: offset - SEGMENT_HEADER_SIZE,
        tornTail: true,
      };
    }
    const payloadLength = frameHeader.readUInt32LE(4);
    const recordEnd = offset + FRAME_HEADER_SIZE + payloadLength;
    if (recordEnd > fileSize) {
      return {
        firstSequence,
        manifestRequired: (flags & MANIFEST_REQUIRED_FLAG) !== 0,
        capacity,
        size: fileSize,
        records,
        logicalSize: offset - SEGMENT_HEADER_SIZE,
        tornTail: true,
      };
    }
    const storedCrc = frameHeader.readUInt32LE(0);
    let crc = crc32cUpdate(0xffffffff, frameHeader.subarray(4));
    let payloadOffset = offset + FRAME_HEADER_SIZE;
    let payloadRemaining = payloadLength;
    while (payloadRemaining > 0) {
      const chunkLength = Math.min(payloadRemaining, scanBuffer.byteLength);
      const chunk = scanBuffer.subarray(0, chunkLength);
      await readFully(handle, chunk, payloadOffset);
      crc = crc32cUpdate(crc, chunk);
      payloadOffset += chunkLength;
      payloadRemaining -= chunkLength;
    }
    const actualCrc = (crc ^ 0xffffffff) >>> 0;
    if (storedCrc !== actualCrc) {
      return {
        firstSequence,
        manifestRequired: (flags & MANIFEST_REQUIRED_FLAG) !== 0,
        capacity,
        size: fileSize,
        records,
        logicalSize: offset - SEGMENT_HEADER_SIZE,
        tornTail: true,
        // A record that still verifies where this one ends means the damage is
        // bit rot in the middle of the journal, not an interrupted append.
        interiorDamage: await hasValidRecordAt(
          handle,
          recordEnd,
          fileSize,
          scratch,
        ),
      };
    }
    const frameSequence = firstSequence + BigInt(records.length);
    validateFrameSequence(frameSequence);
    records.push({
      frameSequence,
      payloadLength,
      payloadOffset: offset + FRAME_HEADER_SIZE,
    });
    offset = recordEnd;
  }
  return {
    firstSequence,
    manifestRequired: (flags & MANIFEST_REQUIRED_FLAG) !== 0,
    capacity,
    size: fileSize,
    records,
    logicalSize: offset - SEGMENT_HEADER_SIZE,
    tornTail: false,
  };
}

function isZeroFilled(
  bytes: Buffer,
  offset: number,
  end = bytes.byteLength,
): boolean {
  for (let index = offset; index < end; index++) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

/**
 * Reports whether a complete, CRC-verified record starts at `offset`. Records
 * are contiguous, so this is the only place the next one can begin: finding it
 * proves the preceding damage has intact data behind it.
 */
async function hasValidRecordAt(
  handle: FileHandle,
  offset: number,
  fileSize: number,
  scratch: SegmentScanScratch,
): Promise<boolean> {
  if (offset + FRAME_HEADER_SIZE > fileSize) return false;
  const frameHeader = scratch.frameHeader;
  await readFully(handle, frameHeader, offset);
  if (frameHeader[0] === 0 && isZeroFilled(frameHeader, 0, FRAME_HEADER_SIZE)) {
    return false;
  }
  const payloadLength = frameHeader.readUInt32LE(4);
  if (offset + FRAME_HEADER_SIZE + payloadLength > fileSize) return false;
  let crc = crc32cUpdate(0xffffffff, frameHeader.subarray(4));
  let payloadOffset = offset + FRAME_HEADER_SIZE;
  let payloadRemaining = payloadLength;
  while (payloadRemaining > 0) {
    const chunkLength = Math.min(payloadRemaining, scratch.data.byteLength);
    const chunk = scratch.data.subarray(0, chunkLength);
    await readFully(handle, chunk, payloadOffset);
    crc = crc32cUpdate(crc, chunk);
    payloadOffset += chunkLength;
    payloadRemaining -= chunkLength;
  }
  return frameHeader.readUInt32LE(0) === (crc ^ 0xffffffff) >>> 0;
}

async function isZeroFilledFile(
  handle: FileHandle,
  start: number,
  end: number,
  scratch: Buffer,
): Promise<boolean> {
  let offset = start;
  while (offset < end) {
    const length = Math.min(end - offset, scratch.byteLength);
    const chunk = scratch.subarray(0, length);
    await readFully(handle, chunk, offset);
    if (!isZeroFilled(chunk, 0, length)) return false;
    offset += length;
  }
  return true;
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
  if (!Number.isSafeInteger(startId) || startId < 0) {
    throw new QwpReplayStoreError(
      `QWP symbol dictionary start ID is outside uint32 range [startId=${startId}]`,
    );
  }
  if (startId + entries.length > QWP_MAX_SYMBOL_DICTIONARY_SIZE) {
    throw new QwpReplayStoreError(
      `QWP symbol dictionary exceeds maximum size ${QWP_MAX_SYMBOL_DICTIONARY_SIZE}`,
    );
  }
  const encoded = entries.map((entry) => {
    if (typeof entry !== "string") {
      throw new QwpReplayStoreError(
        "QWP symbol dictionary values must be strings",
      );
    }
    return Buffer.from(entry, "utf8");
  });
  let entryBytes = 0;
  for (const entry of encoded) {
    entryBytes += unsignedVarintSize(entry.byteLength) + entry.byteLength;
    if (entryBytes > 0xffffffff) {
      throw new QwpReplayStoreError(
        "QWP symbol dictionary block payload is too large",
      );
    }
  }
  const countSize = unsignedVarintSize(entries.length);
  const bytesSize = unsignedVarintSize(entryBytes);
  const block = Buffer.allocUnsafe(countSize + bytesSize + entryBytes + 4);
  let offset = 0;
  offset = writeUnsignedVarint(block, offset, entries.length);
  offset = writeUnsignedVarint(block, offset, entryBytes);
  for (const entry of encoded) {
    offset = writeUnsignedVarint(block, offset, entry.byteLength);
    entry.copy(block, offset);
    offset += entry.byteLength;
  }
  block.writeUInt32LE(crc32c(block.subarray(0, offset)), offset);
  return block;
}

interface DecodedDictionaryChunk {
  readonly entries: readonly string[];
  readonly end: number;
}

function decodeDictionaryChunk(
  bytes: Buffer,
  start: number,
): DecodedDictionaryChunk | undefined {
  const count = readUnsignedVarint(bytes, start, bytes.byteLength);
  if (!count) return undefined;
  const entryBytes = readUnsignedVarint(bytes, count.offset, bytes.byteLength);
  if (!entryBytes) return undefined;
  if (count.value === 0 || entryBytes.value === 0) return undefined;
  const entriesEnd = entryBytes.offset + entryBytes.value;
  const chunkEnd = entriesEnd + 4;
  if (entriesEnd > bytes.byteLength || chunkEnd > bytes.byteLength) {
    return undefined;
  }
  const storedCrc = bytes.readUInt32LE(entriesEnd);
  const actualCrc = crc32c(bytes.subarray(start, entriesEnd));
  if (storedCrc !== actualCrc) return undefined;

  const entries: string[] = [];
  let offset = entryBytes.offset;
  for (let index = 0; index < count.value; index++) {
    const length = readUnsignedVarint(bytes, offset, entriesEnd);
    if (!length || length.offset + length.value > entriesEnd) {
      throw corruptDictionary(
        `invalid entry ${index} in chunk at offset ${start}`,
      );
    }
    try {
      entries.push(
        UTF8_DECODER.decode(
          bytes.subarray(length.offset, length.offset + length.value),
        ),
      );
    } catch (error) {
      throw corruptDictionary(
        `entry ${index} in chunk at offset ${start} is not valid UTF-8: ${String(error)}`,
      );
    }
    offset = length.offset + length.value;
  }
  if (offset !== entriesEnd) {
    throw corruptDictionary(
      `chunk at offset ${start} has ${entriesEnd - offset} unclaimed entry bytes`,
    );
  }
  return { entries, end: chunkEnd };
}

interface DecodedVarint {
  readonly value: number;
  readonly offset: number;
}

function readUnsignedVarint(
  bytes: Buffer,
  offset: number,
  limit: number,
): DecodedVarint | undefined {
  let value = 0;
  let multiplier = 1;
  for (let index = 0; index < 5; index++) {
    if (offset >= limit) return undefined;
    const byte = bytes[offset++];
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      if (value > 0xffffffff) return undefined;
      return { value, offset };
    }
    multiplier *= 128;
  }
  return undefined;
}

function unsignedVarintSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new QwpReplayStoreError(
      `value is outside the SFA uint32 varint range [value=${value}]`,
    );
  }
  let size = 1;
  while (value >= 128) {
    value = Math.floor(value / 128);
    size++;
  }
  return size;
}

function writeUnsignedVarint(
  bytes: Buffer,
  offset: number,
  value: number,
): number {
  unsignedVarintSize(value);
  while (value >= 128) {
    bytes[offset++] = value % 128 | 0x80;
    value = Math.floor(value / 128);
  }
  bytes[offset++] = value;
  return offset;
}

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0x82f63b78 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32c(bytes: Uint8Array): number {
  return (crc32cUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}

function crc32cParts(parts: readonly Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const part of parts) crc = crc32cUpdate(crc, part);
  return (crc ^ 0xffffffff) >>> 0;
}

function crc32cUpdate(initial: number, bytes: Uint8Array): number {
  let crc = initial;
  for (const byte of bytes) {
    crc = CRC32C_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return crc;
}

function validateReplacementDictionary(entries: readonly string[]): void {
  if (entries.length > QWP_MAX_SYMBOL_DICTIONARY_SIZE) {
    throw new QwpReplayStoreError(
      `QWP symbol dictionary exceeds maximum size ${QWP_MAX_SYMBOL_DICTIONARY_SIZE}`,
    );
  }
  const values = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "string") {
      throw new QwpReplayStoreError(
        "QWP symbol dictionary values must be strings",
      );
    }
    if (values.has(entry)) {
      throw new QwpReplayStoreError(
        `QWP symbol dictionary contains a duplicate value: '${entry}'`,
      );
    }
    values.add(entry);
  }
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

async function repairSegmentTail(
  path: string,
  logicalEnd: number,
  fixedSize: number,
  directory: string,
): Promise<void> {
  const file = await open(path, "r+");
  try {
    await file.truncate(logicalEnd);
    await file.truncate(fixedSize);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(directory);
}

async function markSegmentManifestRequired(path: string): Promise<void> {
  const file = await open(path, "r+");
  try {
    const flag = Buffer.alloc(1);
    const { bytesRead } = await file.read(flag, 0, 1, 5);
    if (bytesRead !== 1) {
      throw new QwpReplayStoreCorruptionError(
        `could not read QWP store-and-forward segment flags [file=${path}]`,
      );
    }
    if ((flag[0] & MANIFEST_REQUIRED_FLAG) === 0) {
      flag[0] |= MANIFEST_REQUIRED_FLAG;
      await writeFully(file, flag, 5);
      await file.sync();
    }
  } finally {
    await file.close();
  }
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
  let logicalLock: QwpNodeAdvisoryLock;
  try {
    logicalLock = await QwpNodeAdvisoryLock.acquireLogical(normalized);
  } catch (error) {
    if (error instanceof QwpNodeAdvisoryLockBusyError) {
      throw new QwpReplayStoreLockedError(normalized, error.holderPid);
    }
    if (error instanceof QwpNodeAdvisoryLockUnavailableError) {
      throw new QwpReplayStoreUnavailableError(normalized, error);
    }
    throw new QwpReplayStoreError(
      `could not acquire QWP store-and-forward logical lock for quarantine [directory=${normalized}]`,
      error,
    );
  }
  let result: QwpReplayStoreQuarantinedError | undefined;
  let failure: unknown;
  try {
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
    result = new QwpReplayStoreQuarantinedError(
      normalized,
      quarantineDirectory,
      recoveryError,
    );
  } catch (error) {
    failure = error;
  }
  try {
    await logicalLock.release();
  } catch (error) {
    failure ??= new QwpReplayStoreError(
      `could not release QWP store-and-forward logical lock after quarantine [directory=${normalized}]`,
      error,
    );
  }
  if (failure) throw failure;
  return result!;
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

function segmentFileName(generation: bigint): string {
  if (generation < 0n || generation > MAX_FRAME_SEQUENCE) {
    throw new QwpReplayStoreError(
      `QWP store-and-forward segment generation is outside int64 range [generation=${generation}]`,
    );
  }
  return `${SEGMENT_PREFIX}${generation.toString(16).padStart(16, "0")}${SEGMENT_SUFFIX}`;
}

function parseSegmentGeneration(name: string): bigint | undefined {
  const match = /^sf-([0-9a-fA-F]{16})\.sfa$/.exec(name);
  if (!match) return undefined;
  const generation = BigInt(`0x${match[1]}`);
  if (generation > MAX_FRAME_SEQUENCE) {
    throw new QwpReplayStoreCorruptionError(
      `QWP store-and-forward segment generation is outside int64 range [file=${name}]`,
    );
  }
  return generation;
}

interface MetadataRecord {
  readonly generation: bigint;
  readonly first: bigint;
  readonly second: bigint;
}

function encodeMetadataRecord(
  magic: Buffer,
  generation: bigint,
  first: bigint,
  second: bigint,
): Buffer {
  if (magic.byteLength !== 4) {
    throw new QwpReplayStoreError("SFA metadata magic must be four bytes");
  }
  if (generation <= 0n || generation > MAX_FRAME_SEQUENCE) {
    throw new QwpReplayStoreError(
      `SFA metadata generation is outside positive int64 range [generation=${generation}]`,
    );
  }
  if (
    first < -0x8000000000000000n ||
    first > MAX_FRAME_SEQUENCE ||
    second < -0x8000000000000000n ||
    second > MAX_FRAME_SEQUENCE
  ) {
    throw new QwpReplayStoreError("SFA metadata value is outside int64 range");
  }
  const record = Buffer.alloc(METADATA_RECORD_SIZE);
  magic.copy(record, 0);
  record.writeUInt32LE(FORMAT_VERSION, 4);
  record.writeBigInt64LE(generation, 8);
  record.writeBigInt64LE(first, 16);
  record.writeBigInt64LE(second, 24);
  record.writeUInt32LE(crc32c(record.subarray(0, METADATA_CRC_OFFSET)), 60);
  return record;
}

function decodeLatestMetadataRecord(
  bytes: Buffer,
  magic: Buffer,
): MetadataRecord | undefined {
  const first = decodeMetadataRecord(bytes, 0, magic);
  const second = decodeMetadataRecord(bytes, RECORD_SLOT_SIZE, magic);
  if (!first) return second;
  if (!second) return first;
  return first.generation >= second.generation ? first : second;
}

function decodeMetadataRecord(
  bytes: Buffer,
  offset: number,
  magic: Buffer,
): MetadataRecord | undefined {
  if (offset + METADATA_RECORD_SIZE > bytes.byteLength) return undefined;
  const record = bytes.subarray(offset, offset + METADATA_RECORD_SIZE);
  if (!record.subarray(0, 4).equals(magic)) return undefined;
  if (record.readUInt32LE(4) !== FORMAT_VERSION) return undefined;
  const storedCrc = record.readUInt32LE(METADATA_CRC_OFFSET);
  if (storedCrc !== crc32c(record.subarray(0, METADATA_CRC_OFFSET))) {
    return undefined;
  }
  const generation = record.readBigInt64LE(8);
  if (generation <= 0n) return undefined;
  return {
    generation,
    first: record.readBigInt64LE(16),
    second: record.readBigInt64LE(24),
  };
}

async function openMetadataFile(path: string): Promise<FileHandle> {
  let file: FileHandle;
  let created = false;
  try {
    file = await open(path, "r+");
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
    try {
      file = await open(path, "wx+", 0o600);
      created = true;
    } catch (createError) {
      if (nodeErrorCode(createError) !== "EEXIST") throw createError;
      file = await open(path, "r+");
    }
  }
  try {
    const metadata = await file.stat();
    if (metadata.size !== DUAL_SLOT_FILE_SIZE) {
      await file.truncate(0);
      await writeFully(file, Buffer.alloc(DUAL_SLOT_FILE_SIZE), 0);
      await file.sync();
      created = true;
    }
    if (created) await syncDirectory(dirname(path));
    return file;
  } catch (error) {
    await file.close().catch(() => undefined);
    throw error;
  }
}

async function replaceFile(
  path: string,
  bytes: Buffer,
  directory: string,
): Promise<void> {
  const temporaryPath = `${path}${TEMP_MARKER}${process.pid}-${randomUUID()}`;
  let file: FileHandle | undefined;
  try {
    file = await open(temporaryPath, "wx", 0o600);
    await writeFully(file, bytes, 0);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, path);
    await syncDirectory(directory);
  } catch (error) {
    await file?.close().catch(() => undefined);
    await ignoreMissing(unlink(temporaryPath));
    throw error;
  }
}

function lastMapKey<Value>(values: Map<bigint, Value>): bigint | undefined {
  let last: bigint | undefined;
  for (const key of values.keys()) last = key;
  return last;
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

async function writeFully(
  handle: FileHandle,
  bytes: Uint8Array,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      position + offset,
    );
    if (bytesWritten === 0) {
      throw new QwpReplayStoreError("fixed segment write made no progress");
    }
    offset += bytesWritten;
  }
}

async function writevFully(
  handle: FileHandle,
  buffers: readonly Uint8Array[],
  position: number,
): Promise<void> {
  let pending = buffers.map((buffer) =>
    Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  );
  let writePosition = position;
  while (pending.length > 0) {
    const { bytesWritten } = await handle.writev(pending, writePosition);
    if (bytesWritten === 0) {
      throw new QwpReplayStoreError("fixed segment write made no progress");
    }
    writePosition += bytesWritten;
    let consumed = bytesWritten;
    let firstPending = 0;
    while (
      firstPending < pending.length &&
      consumed >= pending[firstPending].byteLength
    ) {
      consumed -= pending[firstPending].byteLength;
      firstPending++;
    }
    pending = pending.slice(firstPending);
    if (consumed > 0) pending[0] = pending[0].subarray(consumed);
  }
}

async function readFully(
  handle: FileHandle,
  bytes: Uint8Array,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      bytes.byteLength - offset,
      position + offset,
    );
    if (bytesRead === 0) {
      throw new QwpReplayStoreError("fixed segment read ended unexpectedly");
    }
    offset += bytesRead;
  }
}

async function zeroRange(
  handle: FileHandle,
  position: number,
  length: number,
): Promise<void> {
  const zeroes = Buffer.alloc(Math.min(length, 64 * 1024));
  let remaining = length;
  let offset = position;
  while (remaining > 0) {
    const chunk = zeroes.subarray(0, Math.min(remaining, zeroes.byteLength));
    await writeFully(handle, chunk, offset);
    offset += chunk.byteLength;
    remaining -= chunk.byteLength;
  }
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
