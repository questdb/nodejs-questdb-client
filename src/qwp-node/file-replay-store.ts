import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
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
const LOCK_DIRECTORY = ".qwp.lock";
const LOCK_OWNER_FILE = "owner.json";
const LOCK_RECOVERY_FILE = "recovery.json";
const ABANDONED_LOCK_PREFIX = ".qwp.lock.abandoned-";
// The file-per-frame journal has no fixed segment working set. Preserve two
// default-sized QWP batches instead, mirroring Java's active+spare liveness
// floor when the lifetime-monotonic dictionary consumes the configured cap.
const DEFAULT_LIVE_FRAME_BYTES = 2 * 16 * 1024 * 1024;
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
   * Defaults to 1 GiB. The non-reclaimable symbol dictionary may exceed this
   * target so it cannot permanently consume the journal's live frame budget.
   */
  maxBytes?: number;
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
  private readonly liveFrameBytes: number;
  private readonly durability: QwpSfDurability;
  private readonly checkpointIntervalMs: number;
  private readonly backpressurePolicy: QwpSfBackpressurePolicy;
  private readonly appendDeadlineMs: number;
  private readonly records = new Map<bigint, StoredRecord>();
  private readonly symbols: string[] = [];
  private readonly symbolValues = new Set<string>();
  private readonly dirtyRecordPaths = new Set<string>();
  private readonly capacityWaiters = new Set<PendingCapacity>();
  private operationTail: Promise<void> = Promise.resolve();
  private totalBytes = 0;
  private dictionaryFileSize = 0;
  private dictionaryDirty = false;
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
      totalBytes: this.totalBytes,
      dirtyRecords: this.dirtyRecordPaths.size,
      checkpointPending:
        this.dirtyRecordPaths.size > 0 ||
        this.dictionaryDirty ||
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
        this.dirtyRecordPaths.delete(record.path);
        this.totalBytes -= record.size;
        changed = true;
      }
      if (!changed) return;
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
        this.dirtyRecordPaths.add(finalPath);
        this.directoryDirty = true;
      }
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
      !this.directoryDirty
    ) {
      return;
    }
    try {
      for (const path of this.dirtyRecordPaths) await syncFile(path);
      if (this.dictionaryDirty) {
        await syncFile(join(this.directory, DICTIONARY_FILE));
      }
      if (this.directoryDirty) await syncDirectory(this.directory);
      this.dirtyRecordPaths.clear();
      this.dictionaryDirty = false;
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
    // Dictionary bytes are lifetime-monotonic and ACK trimming cannot reclaim
    // them. Loading a valid journal above the target is therefore safe; frame
    // appends remain backpressured except for the bounded liveness floor.
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
