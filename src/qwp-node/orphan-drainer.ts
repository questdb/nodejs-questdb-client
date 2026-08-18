import { readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  QwpConnectionCloseInfo,
  QwpIngressTransportMetrics,
} from "../qwp/transport";
import {
  isQwpNodeReplayQuarantineSlotName,
  QwpReplayStoreLockedError,
} from "./file-replay-store";

const RECORD_SUFFIX = ".qwp";
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_SCAN_INTERVAL_MS = 30_000;
const DEFAULT_PROGRESS_POLL_MS = 50;

/** A terminal orphan-drain failure marker. Remove it to retry the slot. */
export const QWP_ORPHAN_FAILED_SENTINEL = ".qwp.failed";

export const QWP_ORPHAN_DRAIN_EVENT_KIND = {
  DISCOVERED: "discovered",
  STARTED: "started",
  DRAINED: "drained",
  LOCKED: "locked",
  FAILED: "failed",
  SCAN_FAILED: "scan-failed",
} as const;

export type QwpNodeOrphanDrainEventKind =
  (typeof QWP_ORPHAN_DRAIN_EVENT_KIND)[keyof typeof QWP_ORPHAN_DRAIN_EVENT_KIND];

export interface QwpNodeOrphanDrainEvent {
  readonly kind: QwpNodeOrphanDrainEventKind;
  readonly timestampMs: number;
  readonly directory?: string;
  readonly error?: Error;
  readonly metrics: QwpNodeOrphanDrainerMetrics;
}

export interface QwpNodeOrphanDrainerMetrics {
  readonly scans: number;
  readonly discovered: number;
  readonly queued: number;
  readonly active: number;
  readonly drained: number;
  readonly locked: number;
  readonly failed: number;
  readonly scanFailures: number;
  readonly closing: boolean;
  readonly closed: boolean;
}

/** Minimal session surface used by the Node orphan drainer. */
export interface QwpNodeOrphanDrainSession {
  readonly closed: Promise<QwpConnectionCloseInfo>;
  readonly metrics: Pick<
    QwpIngressTransportMetrics,
    "pendingReplayFrames" | "pendingReplayBytes"
  > & {
    readonly lastError?: Error;
  };
  /** Prompts durable-ACK progress when the adopted slot requires it. */
  pollDurableAck?(): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}

export interface QwpNodeOrphanDrainerOptions {
  /** Directory whose child directories are independent replay slots. */
  rootDirectory: string;
  /** Slot names owned by the foreground producer/pool and never adoptable. */
  excludeSlot?: (slotName: string) => boolean;
  /** Creates one independent replay session for an adopted slot. */
  createSession(directory: string): Promise<QwpNodeOrphanDrainSession>;
  /** Maximum slots drained concurrently. Defaults to 4. */
  maxConcurrent?: number;
  /** Rescan cadence; zero performs only the startup scan. Defaults to 30s. */
  scanIntervalMs?: number;
  /** Durable-ACK prompt cadence for adopted sessions. Zero disables it. */
  durableAckPollIntervalMs?: number;
  onEvent?: (event: QwpNodeOrphanDrainEvent) => void;
}

/**
 * Returns child replay slots containing unacknowledged records.
 *
 * The scan is deliberately read-only and does not inspect lock ownership.
 * Adoption obtains the replay store's exclusive lock, closing the race with a
 * live foreground producer or another drainer.
 */
export async function scanQwpNodeOrphanSlots(
  rootDirectory: string,
  excludeSlot?: (slotName: string) => boolean,
): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(rootDirectory, { withFileTypes: true });
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return [];
    throw error;
  }

  const candidates: string[] = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      isQwpNodeReplayQuarantineSlotName(entry.name) ||
      excludeSlot?.(entry.name)
    ) {
      continue;
    }
    const directory = join(rootDirectory, entry.name);
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      // A disappearing or unreadable sibling must not starve later slots in
      // the same group. A future periodic scan can observe it if it recovers.
      continue;
    }
    if (
      children.some(
        (child) => child.isFile() && child.name === QWP_ORPHAN_FAILED_SENTINEL,
      )
    ) {
      continue;
    }
    if (
      children.some(
        (child) => child.isFile() && child.name.endsWith(RECORD_SUFFIX),
      )
    ) {
      candidates.push(directory);
    }
  }
  candidates.sort();
  return candidates;
}

/**
 * Bounded Node-only scanner and background drainer for replay slots left by
 * terminated producer processes. Each adopted slot uses its own connection.
 */
export class QwpNodeOrphanDrainer {
  private readonly rootDirectory: string;
  private readonly excludeSlot?: (slotName: string) => boolean;
  private readonly createSession: (
    directory: string,
  ) => Promise<QwpNodeOrphanDrainSession>;
  private readonly maxConcurrent: number;
  private readonly scanIntervalMs: number;
  private readonly durableAckPollIntervalMs: number;
  private readonly onEvent?: (event: QwpNodeOrphanDrainEvent) => void;
  private readonly known = new Set<string>();
  private readonly queue: string[] = [];
  private readonly active = new Map<string, QwpNodeOrphanDrainSession>();
  private readonly workers = new Set<Promise<void>>();
  private scanTimer?: ReturnType<typeof setTimeout>;
  private scanPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private started = false;
  private closing = false;
  private closed = false;
  private scans = 0;
  private discovered = 0;
  private drained = 0;
  private locked = 0;
  private failed = 0;
  private scanFailures = 0;

  constructor(options: QwpNodeOrphanDrainerOptions) {
    const rootDirectory = options.rootDirectory.trim();
    if (!rootDirectory) {
      throw new RangeError("QWP orphan-drain root directory must not be empty");
    }
    const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError(
        "QWP orphan-drain maxConcurrent must be a positive safe integer",
      );
    }
    const scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    if (!Number.isFinite(scanIntervalMs) || scanIntervalMs < 0) {
      throw new RangeError(
        "QWP orphan-drain scanIntervalMs must be a non-negative finite number",
      );
    }
    const durableAckPollIntervalMs =
      options.durableAckPollIntervalMs ?? DEFAULT_PROGRESS_POLL_MS;
    if (
      !Number.isFinite(durableAckPollIntervalMs) ||
      durableAckPollIntervalMs < 0
    ) {
      throw new RangeError(
        "QWP orphan-drain durableAckPollIntervalMs must be a non-negative finite number",
      );
    }
    this.rootDirectory = rootDirectory;
    this.excludeSlot = options.excludeSlot;
    this.createSession = options.createSession;
    this.maxConcurrent = maxConcurrent;
    this.scanIntervalMs = scanIntervalMs;
    this.durableAckPollIntervalMs = durableAckPollIntervalMs;
    this.onEvent = options.onEvent;
  }

  get metrics(): QwpNodeOrphanDrainerMetrics {
    return Object.freeze({
      scans: this.scans,
      discovered: this.discovered,
      queued: this.queue.length,
      active: this.active.size,
      drained: this.drained,
      locked: this.locked,
      failed: this.failed,
      scanFailures: this.scanFailures,
      closing: this.closing,
      closed: this.closed,
    });
  }

  /** Starts an immediate scan and the optional periodic scanner. */
  start(): void {
    if (this.started || this.closing || this.closed) return;
    this.started = true;
    this.scanPromise = this.scanOnce();
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeNow();
    return this.closePromise;
  }

  private async scanOnce(): Promise<void> {
    if (this.closing) return;
    this.scans++;
    try {
      const candidates = await scanQwpNodeOrphanSlots(
        this.rootDirectory,
        this.excludeSlot,
      );
      for (const directory of candidates) {
        if (this.closing || this.known.has(directory)) continue;
        this.known.add(directory);
        this.queue.push(directory);
        this.discovered++;
        this.emit(QWP_ORPHAN_DRAIN_EVENT_KIND.DISCOVERED, directory);
      }
      this.pump();
    } catch (error) {
      this.scanFailures++;
      this.emit(
        QWP_ORPHAN_DRAIN_EVENT_KIND.SCAN_FAILED,
        undefined,
        toError(error, "QWP orphan-slot scan failed"),
      );
    } finally {
      if (!this.closing && this.scanIntervalMs > 0) {
        this.scanTimer = setTimeout(() => {
          this.scanTimer = undefined;
          this.scanPromise = this.scanOnce();
        }, this.scanIntervalMs);
        this.scanTimer.unref?.();
      }
    }
  }

  private pump(): void {
    while (
      !this.closing &&
      this.workers.size < this.maxConcurrent &&
      this.queue.length > 0
    ) {
      const directory = this.queue.shift()!;
      const worker = this.drainOne(directory).finally(() => {
        this.workers.delete(worker);
        this.known.delete(directory);
        this.pump();
      });
      this.workers.add(worker);
    }
  }

  private async drainOne(directory: string): Promise<void> {
    let session: QwpNodeOrphanDrainSession | undefined;
    try {
      session = await this.createSession(directory);
      if (this.closing) {
        await session.close(1001, "QWP orphan drainer is closing");
        return;
      }
      this.active.set(directory, session);
      this.emit(QWP_ORPHAN_DRAIN_EVENT_KIND.STARTED, directory);
      await this.waitUntilDrained(session);
      if (this.closing) return;
      this.drained++;
      this.emit(QWP_ORPHAN_DRAIN_EVENT_KIND.DRAINED, directory);
    } catch (error) {
      if (this.closing) return;
      if (error instanceof QwpReplayStoreLockedError) {
        this.locked++;
        this.emit(QWP_ORPHAN_DRAIN_EVENT_KIND.LOCKED, directory, error);
        return;
      }
      const failure = toError(error, "QWP orphan drain failed");
      this.failed++;
      await markFailed(directory, failure).catch(() => undefined);
      this.emit(QWP_ORPHAN_DRAIN_EVENT_KIND.FAILED, directory, failure);
    } finally {
      if (session) {
        this.active.delete(directory);
        await session
          .close(1000, "QWP orphan slot drained")
          .catch(() => undefined);
      }
    }
  }

  private async waitUntilDrained(
    session: QwpNodeOrphanDrainSession,
  ): Promise<void> {
    const terminal = session.closed.then(() => "closed" as const);
    let nextDurablePoll =
      this.durableAckPollIntervalMs > 0
        ? Date.now() + this.durableAckPollIntervalMs
        : Number.POSITIVE_INFINITY;
    while (!this.closing) {
      if (session.metrics.pendingReplayFrames === 0) return;
      const outcome = await Promise.race([
        terminal,
        delay(DEFAULT_PROGRESS_POLL_MS).then(() => "poll" as const),
      ]);
      if (outcome === "closed") {
        throw (
          session.metrics.lastError ??
          new Error(
            "QWP orphan drain session closed before its replay slot drained",
          )
        );
      }
      if (
        session.pollDurableAck &&
        this.durableAckPollIntervalMs > 0 &&
        Date.now() >= nextDurablePoll
      ) {
        await session.pollDurableAck();
        nextDurablePoll = Date.now() + this.durableAckPollIntervalMs;
      }
    }
  }

  private async closeNow(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = undefined;
    this.queue.length = 0;
    await this.scanPromise?.catch(() => undefined);
    await Promise.all(
      Array.from(this.active.values(), (session) =>
        session
          .close(1001, "QWP orphan drainer is closing")
          .catch(() => undefined),
      ),
    );
    await Promise.allSettled(Array.from(this.workers));
    this.known.clear();
    this.closed = true;
  }

  private emit(
    kind: QwpNodeOrphanDrainEventKind,
    directory?: string,
    error?: Error,
  ): void {
    try {
      this.onEvent?.({
        kind,
        timestampMs: Date.now(),
        directory,
        error,
        metrics: this.metrics,
      });
    } catch {
      // Observers must not interfere with durable recovery.
    }
  }
}

async function markFailed(directory: string, error: Error): Promise<void> {
  await writeFile(
    join(directory, QWP_ORPHAN_FAILED_SENTINEL),
    `${new Date().toISOString()} ${error.name}: ${error.message}\n`,
    { encoding: "utf8", flag: "w", mode: 0o600 },
  );
}

/** Removes a terminal marker so an operator-approved slot can be retried. */
export async function retryQwpNodeOrphanSlot(directory: string): Promise<void> {
  try {
    await unlink(join(directory, QWP_ORPHAN_FAILED_SENTINEL));
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback, { cause: error });
}

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
