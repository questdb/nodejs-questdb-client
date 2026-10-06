import {
  decodeQwpIngressSymbolDictionaryDelta,
  decodeQwpIngressResponse,
  encodeQwpDurableAckPollFrame,
  encodeQwpIngressFrame,
  QWP_FLAG_DEFER_COMMIT,
  QWP_MAX_ROWS_PER_TABLE,
  QWP_MAX_TABLES_PER_FRAME,
  QWP_STATUS,
  QwpIngressEncodeOptions,
  QwpIngressResponse,
  QwpProtocolError,
  QwpSymbolDictionary,
  QwpTableBuffer,
} from "./_core";
import { measureQwpIngressFrame } from "./_core/ingress";
import {
  QWP_INITIAL_CONNECT_MODE,
  QwpBinaryConnection,
  QwpConnectionCloseInfo,
  QwpConnectionFactory,
  QwpHandshakeMetadata,
  QwpInitialConnectMode,
  QwpIngressReconnectOptions,
  QwpIngressReplayStore,
} from "./transport";
import {
  QWP_DEFAULT_INGRESS_RECONNECT_OPTIONS,
  QwpReconnectingIngressConnection,
  selectsQwpSyncInitialConnect,
  validateQwpInitialConnectMode,
} from "./_internal/reconnecting-ingress-connection";
import { validateQwpIngressReconnectBackoffs } from "./_internal/reconnect-backoff";
import { monotonicNowMs } from "./_internal/monotonic-clock";
import {
  exceedsQwpTimerCeiling,
  QWP_MAX_TIMER_DELAY_MS,
} from "./_internal/timer-bounds";
import { QwpNotificationDispatcher } from "./_internal/notification-dispatcher";
import { QWP_FLAGS_OFFSET } from "./_internal/frame-flags";
import { safelyInvoke } from "./_internal/safe-callback";
import {
  createQwpSenderError,
  defaultQwpSenderErrorHandler,
  QWP_SENDER_ERROR_POLICY,
  type QwpSenderError,
} from "./sender-error";
import { log } from "../logging";

const DEFAULT_CONNECTION_LISTENER_INBOX_CAPACITY = 64;
const DEFAULT_ERROR_INBOX_CAPACITY = 256;
const DEFAULT_PROGRESS_INBOX_CAPACITY = 256;
/** How long close() lets published in-memory frames reach the socket. */
const CLOSE_DRAIN_TIMEOUT_MS = 5_000;

interface PlannedIngressFrames {
  readonly frames: Uint8Array[];
}

function splitUnitCount(tables: readonly QwpTableBuffer[]): number {
  return tables.reduce(
    (total, table) => total + Math.max(1, table.rowCount),
    0,
  );
}

function splitTablesAtUnit(
  tables: readonly QwpTableBuffer[],
  leftUnitCount: number,
): [QwpTableBuffer[], QwpTableBuffer[]] {
  const left: QwpTableBuffer[] = [];
  const right: QwpTableBuffer[] = [];
  let remaining = leftUnitCount;

  for (const table of tables) {
    if (remaining <= 0) {
      right.push(table);
    } else if (table.rowCount === 0) {
      left.push(table);
      remaining--;
    } else if (remaining >= table.rowCount) {
      left.push(table);
      remaining -= table.rowCount;
    } else {
      left.push(table.sliceRows(0, remaining));
      right.push(table.sliceRows(remaining, table.rowCount));
      remaining = 0;
    }
  }
  return [left, right];
}

/**
 * Preflights a logical ingress flush without publishing any frame. Oversized
 * candidates are bisected in table/row order. Accepted candidates advance a
 * delta dictionary transactionally; any terminal failure restores its initial
 * size. Non-final frames defer commit so the final frame closes the group.
 */
/**
 * Splits tables into frames that fit the row, table-count, and byte caps.
 *
 * `maxBatchSizeBytes` is undefined until a server advertises its cap, which is
 * a supported state -- an offline store-and-forward start, or a server that
 * does not answer the browser handshake. Every caller used to skip the planner
 * entirely then and encode one frame directly, which also skipped the row-cap
 * pre-check below: a table over QWP_MAX_ROWS_PER_TABLE raised a plain Error out
 * of encodeQwpIngressFrame() instead of being split, and because closeNow()
 * only discards staging for QwpBatchTooLargeError, every later flush() and
 * close() raised it again on the same unreachable batch. An unknown byte cap is
 * now simply an infinite one, so the row cap is enforced either way.
 */
function planIngressFrames(
  tables: readonly QwpTableBuffer[],
  encodeOptions: QwpIngressEncodeOptions,
  maxBatchSizeBytes: number = Number.POSITIVE_INFINITY,
): PlannedIngressFrames {
  const dictionary = encodeOptions.dictionary;
  const initialDictionarySize = dictionary?.size;
  let confirmedMaxSymbolId = encodeOptions.confirmedMaxSymbolId ?? -1;
  const frames: Uint8Array[] = [];

  const plan = (candidate: readonly QwpTableBuffer[]): void => {
    const dictionarySize = dictionary?.size;
    // Row and frame table-count caps are knowable before encoding. Testing them
    // here makes them splittable like a byte-oversized candidate; letting the
    // encoder discover either one would throw before the bisection below.
    const overRowCap = candidate.some(
      (table) => table.rowCount > QWP_MAX_ROWS_PER_TABLE,
    );
    const overTableCap = candidate.length > QWP_MAX_TABLES_PER_FRAME;
    let frameByteLength = 0;
    if (!overRowCap && !overTableCap) {
      const candidateOptions: QwpIngressEncodeOptions = {
        ...encodeOptions,
        deferCommit: false,
        dictionary,
        confirmedMaxSymbolId: dictionary
          ? confirmedMaxSymbolId
          : encodeOptions.confirmedMaxSymbolId,
      };
      if (Number.isFinite(maxBatchSizeBytes)) {
        // Size first without allocating an output buffer. Encoding the whole
        // oversized candidate before every bisection briefly allocated many
        // multiples of the negotiated cap and could exhaust the process before
        // splitting had a chance to help.
        // A candidate that fits is encoded from the plan that measured it,
        // in this same synchronous section, rather than planned a second time.
        const measured = measureQwpIngressFrame(candidate, candidateOptions);
        frameByteLength = measured.byteLength;
        if (frameByteLength > maxBatchSizeBytes) {
          if (dictionarySize !== undefined)
            dictionary!.truncate(dictionarySize);
        } else {
          const frame = measured.encode();
          frames.push(frame);
          if (dictionary) confirmedMaxSymbolId = dictionary.size - 1;
          return;
        }
      } else {
        const frame = encodeQwpIngressFrame(candidate, candidateOptions);
        frameByteLength = frame.byteLength;
        frames.push(frame);
        if (dictionary) confirmedMaxSymbolId = dictionary.size - 1;
        return;
      }
    }

    const units = splitUnitCount(candidate);
    if (units <= 1) {
      // Only reachable for an oversized single row: splitUnitCount() counts
      // rows, so a table over the row cap always leaves more than one unit.
      throw new QwpBatchTooLargeError(frameByteLength, maxBatchSizeBytes);
    }
    const [left, right] = splitTablesAtUnit(candidate, Math.ceil(units / 2));
    plan(left);
    plan(right);
  };

  try {
    plan(tables);
    const deferAll = encodeOptions.deferCommit ?? false;
    frames.forEach((frame, index) => {
      if (deferAll || index < frames.length - 1) {
        frame[QWP_FLAGS_OFFSET] |= QWP_FLAG_DEFER_COMMIT;
      }
    });
    return { frames };
  } catch (error) {
    if (initialDictionarySize !== undefined) {
      dictionary!.truncate(initialDictionarySize);
    }
    throw error;
  }
}

/**
 * Delivery options of an ingress session: acknowledgement, reconnect and
 * replay, and notifications. Each runtime's ingress options include them.
 */
export interface QwpIngressSessionOptions {
  /**
   * Default timeout for waitForAcknowledged() and QwpSender.flushAndWait():
   * how long a wait may go without the ACK watermark advancing. Defaults to
   * 15 seconds. Capped at 2,147,483,647ms (the host timer ceiling); a larger
   * value throws a `RangeError`.
   */
  ackTimeoutMs?: number;
  /**
   * Reconnection and at-least-once replay policy. Reconnection is
   * enabled by default for factory-created sessions; set false to keep one
   * fixed connection. Browser and non-persistent Node replay is memory-only.
   * When initialConnectMode is not set, the first connect is a single attempt
   * unless reconnectMaxDurationMs, reconnectInitialBackoffMs or
   * reconnectMaxBackoffMs is set, as in the Java client; it then retries for
   * up to reconnectMaxDurationMs (5 minutes by default). An onEvent observer
   * alone does not make it retry. Once connected, the session retries every
   * outage until close() or a terminal error.
   *
   * An ACK lost during disconnect can cause a frame to be replayed after the
   * server accepted it; configure server-side deduplication when duplicates
   * are not acceptable.
   */
  reconnect?: QwpIngressReconnectOptions | false;
  /**
   * Target cap for the built-in memory-only replay queue, including estimated
   * per-frame bookkeeping. Defaults to 128 MiB. A transaction-closing logical
   * batch may temporarily exceed this target by up to one target-sized batch,
   * because the server cannot ACK its deferred prefix before receiving that
   * batch. This applies in browsers and non-persistent Node sessions; custom
   * replay stores enforce their own cap.
   */
  memoryReplayMaxBytes?: number;
  /**
   * Maximum time a memory replay append waits for ACK-driven trimming after
   * reaching memoryReplayMaxBytes. Defaults to 30 seconds.
   */
  memoryReplayAppendDeadlineMs?: number;
  /**
   * Startup policy when no server is reachable; the typed spelling of the
   * `initial_connect_retry` configuration-string key.
   *
   * - `"off"` makes one pass over the endpoints and fails fast.
   * - `"sync"` retries on the caller for up to
   *   `reconnect.reconnectMaxDurationMs`, then fails with
   *   QwpReconnectExhaustedError.
   * - `"async"` returns at once and connects in the background, retrying
   *   until close(). Rows published meanwhile wait in the replay queue --
   *   memory, or the Node store-and-forward journal. An authentication or
   *   capability rejection that every endpoint would repeat ends the session
   *   if it comes before the first successful connection.
   *
   * Defaults to `"off"`, or to `"sync"` when reconnectMaxDurationMs,
   * reconnectInitialBackoffMs or reconnectMaxBackoffMs is set. `"sync"` and
   * `"async"` require reconnection, so they cannot be combined with
   * `reconnect: false`.
   */
  initialConnectMode?: QwpInitialConnectMode;
  /**
   * Optional local ingress frame cap. Browsers cannot read WebSocket upgrade
   * headers, so browser applications should set this to the server's configured
   * QWP cap. When the server also advertises a cap, the smaller value wins.
   * Table batches are split at row boundaries automatically; an individual row
   * that cannot fit is rejected with QwpBatchTooLargeError before it is sent.
   */
  maxBatchSizeBytes?: number;
  /**
   * Enables durable-ACK tracking. While committed table transactions await
   * durable upload, Node transports send WebSocket PING frames and browser
   * transports send table-less QWP poll frames. Zero keeps tracking enabled
   * but disables automatic polling. Factory-created browser sessions require
   * requestDurableAck=true when this option is supplied. Capped at
   * 2,147,483,647ms (the host timer ceiling); a larger value throws a
   * `RangeError`.
   */
  durableAckKeepaliveMs?: number;
  /**
   * Bounded reconnect-listener inbox. Oldest pending events are dropped when
   * full. Defaults to 64, matching the Java client.
   */
  connectionListenerInboxCapacity?: number;
  /**
   * Bounded typed/legacy error inbox. Oldest pending errors are dropped when
   * full. Defaults to 256, matching the Java client.
   */
  errorInboxCapacity?: number;
  /**
   * Java-parity typed server-rejection and data-loss notifications. When
   * omitted, the default handler logs retriable errors at warn and terminal
   * errors or abandoned data at error.
   */
  onSenderError?: (error: QwpSenderError) => void;
  onResponse?: (response: QwpIngressResponse) => void;
  onDurableAck?: (response: QwpIngressResponse) => void;
  /** Monotonic send/accept/durability notifications. Callback errors are ignored. */
  onProgress?: (event: QwpIngressProgressEvent) => void;
  /**
   * Server rejections and terminal session failures. A waitForAcknowledged()
   * that times out is reported only to its caller.
   */
  onError?: (event: QwpIngressErrorEvent) => void;
}

/**
 * @internal Session options only a runtime adapter sets.
 *
 * Neither package root exports this interface, so the published
 * QwpIngressSessionOptions carry none of these handoffs.
 */
export interface QwpIngressSessionInternalOptions
  extends QwpIngressSessionOptions {
  /** Node adapter hook for persistent store-and-forward. */
  replayStore?: QwpIngressReplayStore;
  /**
   * Starts memory or persistent replay without waiting for a server. Implied
   * by initialConnectMode `"async"`.
   */
  backgroundStoreAndForward?: boolean;
  /** Orphan sessions may quarantine persistent catch-up cap gaps. */
  orphanStoreAndForward?: boolean;
  /**
   * Consecutive durable-ACK gap budget retained for orphan SF.
   * Not capped at the host timer ceiling: compared against elapsed time only.
   */
  orphanDurableAckMismatchMaxDurationMs?: number;
  /**
   * Minimum cap-gap dwell before an orphan can be quarantined.
   * Not capped at the host timer ceiling: compared against elapsed time only.
   */
  catchUpCapGapMinEscalationWindowMs?: number;
  /**
   * Counts onSenderError deliveries made before this session existed, so its
   * metrics include them. Node store-and-forward recovery reports abandoned or
   * quarantined journal bytes while the session is still being built, so those
   * deliveries cannot pass through the inbox the session owns.
   */
  priorSenderErrorDeliveries?: () => number;
}

export const QWP_INGRESS_PROGRESS_KIND = {
  PUBLISHED: "published",
  ACKNOWLEDGED: "acknowledged",
  DURABLE_ACKNOWLEDGED: "durable-acknowledged",
} as const;

export type QwpIngressProgressKind =
  (typeof QWP_INGRESS_PROGRESS_KIND)[keyof typeof QWP_INGRESS_PROGRESS_KIND];

/** Immutable point-in-time ingress telemetry, safe in browsers and Node.js. */
export interface QwpIngressMetrics {
  /** Highest client-session sequence allocated, or -1 before the first send. */
  readonly publishedSequence: bigint;
  /** Highest client-session sequence covered by a successful cumulative ACK. */
  readonly acknowledgedSequence: bigint;
  readonly pendingDurableTables: number;
  readonly totalFramesPublished: number;
  readonly totalBytesPublished: number;
  /** Physical sends; includes replay and dictionary catch-up when available. */
  readonly totalFramesSent: number;
  readonly totalBytesSent: number;
  readonly totalFramesReplayed: number;
  readonly totalBytesReplayed: number;
  readonly totalAcks: number;
  readonly totalNacks: number;
  readonly totalDurableAcks: number;
  readonly totalErrors: number;
  readonly totalReconnectAttempts: number;
  readonly totalReconnectsSucceeded: number;
  readonly totalFailovers: number;
  readonly totalReconnectErrors: number;
  readonly deliveredProgressNotifications: number;
  readonly droppedProgressNotifications: number;
  readonly deliveredConnectionNotifications: number;
  readonly droppedConnectionNotifications: number;
  readonly deliveredErrorNotifications: number;
  readonly droppedErrorNotifications: number;
  /** Stable store-and-forward watermark; absent without reconnect/replay. */
  readonly replayPublishedFrameSequence?: bigint;
  /** Trim watermark; in durable-ACK mode it advances only after durability. */
  readonly replayAcknowledgedFrameSequence?: bigint;
  readonly pendingReplayFrames: number;
  readonly pendingReplayBytes: number;
  readonly memoryReplayMaxBytes?: number;
  readonly memoryReplayUsedBytes?: number;
  readonly waitingMemoryReplayAppends: number;
  readonly totalMemoryReplayBackpressureStalls: number;
  readonly totalMemoryReplayAppendTimeouts: number;
  readonly lastError?: Error;
}

export interface QwpIngressProgressEvent {
  readonly kind: QwpIngressProgressKind;
  readonly timestampMs: number;
  readonly sequence?: bigint;
  readonly response?: QwpIngressResponse;
  readonly metrics: QwpIngressMetrics;
}

export interface QwpIngressErrorEvent {
  readonly error: Error;
  readonly terminal: boolean;
  readonly timestampMs: number;
  readonly response?: QwpIngressResponse;
  /** Present for a classified server rejection. */
  readonly senderError?: QwpSenderError;
  readonly metrics: QwpIngressMetrics;
}

interface PendingAcknowledgedSequence {
  readonly targetSequence: bigint;
  /** True once the watermark covers the target, false when the wait expires. */
  resolve: (acknowledged: boolean) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  /** Watermark last seen by this wait; an advance restarts its deadline. */
  lastSeen: bigint;
  /** Monotonic time the watermark was last seen advancing. */
  lastProgressMs: number;
}

export class QwpIngressNackError extends Error {
  constructor(
    readonly response: QwpIngressResponse,
    readonly senderError: QwpSenderError = createQwpSenderError(response),
  ) {
    super(
      response.errorMessage ??
        `QuestDB rejected QWP frame [status=0x${response.status.toString(16)}]`,
    );
    this.name = "QwpIngressNackError";
  }
}

export class QwpIngressSessionClosedError extends Error {
  constructor(readonly closeInfo?: QwpConnectionCloseInfo) {
    super(
      closeInfo
        ? `QWP ingress connection closed [code=${closeInfo.code}, reason=${closeInfo.reason}]`
        : "QWP ingress session is closed",
    );
    this.name = "QwpIngressSessionClosedError";
  }
}

/** A recovered frame was deliberately retired without a server ACK. */
export class QwpIngressAckAbandonedError extends Error {
  constructor(
    readonly targetSequence: bigint,
    readonly fromFsn: bigint,
    readonly toFsn: bigint,
  ) {
    super(
      `QWP frame was abandoned before server acknowledgement [targetSequence=${targetSequence}, abandoned=${fromFsn}..${toFsn}]`,
    );
    this.name = "QwpIngressAckAbandonedError";
  }
}

/**
 * close() discarded frames that had been published to the in-memory replay
 * queue but could not reach the socket before its drain deadline, typically
 * because no server was reachable. The connection is closed regardless.
 *
 * @internal Only QwpIngressSession.close() throws it. QwpSender bounds and
 * reports its own drain with QwpSenderCloseTimeoutError, so neither package
 * exports this class.
 */
export class QwpIngressSessionCloseTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly unsentFrames: number,
  ) {
    super(
      `QWP ingress session close timed out after ${timeoutMs}ms; ${unsentFrames} published frame(s) had not reached the socket and were discarded`,
    );
    this.name = "QwpIngressSessionCloseTimeoutError";
  }
}

export class QwpBatchTooLargeError extends RangeError {
  constructor(
    readonly batchSizeBytes: number,
    readonly maxBatchSizeBytes: number,
  ) {
    super(
      `QWP batch exceeds the negotiated limit [size=${batchSizeBytes}, max=${maxBatchSizeBytes}]`,
    );
    this.name = "QwpBatchTooLargeError";
  }
}

function validateIngressSessionOptions(
  options: QwpIngressSessionInternalOptions,
): void {
  validateQwpIngressReconnectBackoffs(options.reconnect);
  validateQwpInitialConnectMode(options.initialConnectMode);
  // A fixed connection has nothing to retry with and no replay queue to hold
  // rows for a background connect, so either mode would silently run as "off".
  if (
    options.reconnect === false &&
    options.initialConnectMode !== undefined &&
    options.initialConnectMode !== QWP_INITIAL_CONNECT_MODE.OFF
  ) {
    throw new RangeError(
      `initialConnectMode '${options.initialConnectMode}' requires ingress reconnect`,
    );
  }
  const timeout = options.ackTimeoutMs ?? 15_000;
  if (
    !Number.isFinite(timeout) ||
    timeout <= 0 ||
    exceedsQwpTimerCeiling(timeout)
  ) {
    throw new RangeError(
      `ackTimeoutMs must be a positive finite number no greater than ${QWP_MAX_TIMER_DELAY_MS}`,
    );
  }
  const localBatchCap = options.maxBatchSizeBytes;
  if (
    localBatchCap !== undefined &&
    (!Number.isSafeInteger(localBatchCap) || localBatchCap <= 0)
  ) {
    throw new RangeError("maxBatchSizeBytes must be a positive safe integer");
  }
  const memoryReplayMaxBytes = options.memoryReplayMaxBytes;
  if (
    memoryReplayMaxBytes !== undefined &&
    (!Number.isSafeInteger(memoryReplayMaxBytes) || memoryReplayMaxBytes <= 0)
  ) {
    throw new RangeError(
      "memoryReplayMaxBytes must be a positive safe integer",
    );
  }
  const memoryReplayAppendDeadlineMs = options.memoryReplayAppendDeadlineMs;
  if (
    memoryReplayAppendDeadlineMs !== undefined &&
    (!Number.isSafeInteger(memoryReplayAppendDeadlineMs) ||
      memoryReplayAppendDeadlineMs <= 0 ||
      memoryReplayAppendDeadlineMs > 2_147_483_647)
  ) {
    throw new RangeError(
      "memoryReplayAppendDeadlineMs must be a positive safe integer no greater than 2147483647",
    );
  }
  if (
    options.replayStore &&
    (memoryReplayMaxBytes !== undefined ||
      memoryReplayAppendDeadlineMs !== undefined)
  ) {
    throw new RangeError(
      "memory replay capacity options cannot be combined with a custom replayStore",
    );
  }
  const keepalive = options.durableAckKeepaliveMs;
  if (
    keepalive !== undefined &&
    (!Number.isFinite(keepalive) ||
      keepalive < 0 ||
      exceedsQwpTimerCeiling(keepalive))
  ) {
    throw new RangeError(
      `durableAckKeepaliveMs must be a non-negative finite number no greater than ${QWP_MAX_TIMER_DELAY_MS}`,
    );
  }
  const orphanDurableAckBudget = options.orphanDurableAckMismatchMaxDurationMs;
  if (
    orphanDurableAckBudget !== undefined &&
    (!Number.isFinite(orphanDurableAckBudget) || orphanDurableAckBudget < 0)
  ) {
    throw new RangeError(
      "orphanDurableAckMismatchMaxDurationMs must be a non-negative finite number",
    );
  }
  for (const [name, value, minimum] of [
    [
      "connectionListenerInboxCapacity",
      options.connectionListenerInboxCapacity,
      1,
    ],
    ["errorInboxCapacity", options.errorInboxCapacity, 16],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < minimum)
    ) {
      throw new RangeError(`${name} must be an integer of at least ${minimum}`);
    }
  }
}

/**
 * Connection-scoped ingress sequencer.
 *
 * Publications are serialized to preserve the server's zero-based wire
 * sequence. Successful ACKs are cumulative, so the ACK watermark covers every
 * frame through the acknowledged sequence; waitForAcknowledged() observes it.
 *
 * @internal The layer below QwpSender. As in the Java, Rust and Python
 * clients, applications publish through a sender instead, so neither package
 * exports this class or a factory that returns one.
 */
export class QwpIngressSession {
  private readonly durableWatermarks = new Map<string, bigint>();
  private readonly pendingDurableTargets = new Map<string, bigint>();
  private readonly acknowledgedSequenceWaiters =
    new Set<PendingAcknowledgedSequence>();
  private readonly durableFrameTargets = new Map<
    bigint,
    ReadonlyMap<string, bigint>
  >();
  private acknowledgementRejection?: {
    readonly sequence: bigint;
    readonly error: QwpIngressNackError;
  };
  private nextSequence = 0n;
  private highestSentSequence = -1n;
  private sendTail: Promise<void> = Promise.resolve();
  private durablePollTimer?: ReturnType<typeof setTimeout>;
  private readonly localMaxBatchSizeBytes?: number;
  private readonly symbolDictionary = new QwpSymbolDictionary();
  private deltaPublicationBarrier?: Promise<void>;
  private publishedMaxSymbolId = -1;
  private deltaSymbolsPublished = false;
  private acknowledgedSequence = -1n;
  private durableAcknowledgedSequence = -1n;
  private totalFramesPublished = 0;
  private totalBytesPublished = 0;
  private totalFramesSent = 0;
  private totalBytesSent = 0;
  private totalAcks = 0;
  private totalNacks = 0;
  private totalDurableAcks = 0;
  private totalErrors = 0;
  private lastError?: Error;
  private failure?: Error;
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly closeHooks: (() => void | Promise<void>)[] = [];
  private readonly receiveLoop: Promise<void>;
  // The queued thunks hand back whatever safelyInvoke() contained, so an
  // `async` observer's promise reaches the dispatcher and the inbox serializes
  // on it. Typing these `() => void` swallowed that promise at the call
  // boundary, which left both inboxes re-entering a slow observer once per
  // drain turn -- the exact behaviour QwpNotificationDispatcher documents that
  // it prevents.
  private readonly progressDispatcher?: QwpNotificationDispatcher<
    () => PromiseLike<void> | undefined
  >;
  private readonly errorDispatcher?: QwpNotificationDispatcher<
    () => PromiseLike<unknown> | undefined
  >;

  constructor(
    private readonly connection: QwpBinaryConnection,
    private readonly options: QwpIngressSessionInternalOptions = {},
  ) {
    try {
      if (
        options.reconnect &&
        !(connection instanceof QwpReconnectingIngressConnection)
      ) {
        throw new Error(
          "ingress reconnect options require QwpIngressSession.connect(factory, options)",
        );
      }
      if (
        options.initialConnectMode !== undefined &&
        options.initialConnectMode !== QWP_INITIAL_CONNECT_MODE.OFF &&
        !(connection instanceof QwpReconnectingIngressConnection)
      ) {
        throw new Error(
          "an initialConnectMode other than 'off' requires QwpIngressSession.connect(factory, options)",
        );
      }
      if (
        (options.memoryReplayMaxBytes !== undefined ||
          options.memoryReplayAppendDeadlineMs !== undefined) &&
        !(connection instanceof QwpReconnectingIngressConnection)
      ) {
        throw new Error(
          "memory replay capacity options require ingress reconnect",
        );
      }
      validateIngressSessionOptions(options);
    } catch (error) {
      try {
        void connection
          .close(1002, "invalid QWP ingress session options")
          .catch(() => undefined);
      } catch {
        // Preserve the configuration error when transport cleanup also fails.
      }
      throw error;
    }
    this.localMaxBatchSizeBytes = options.maxBatchSizeBytes;
    if (options.onResponse || options.onDurableAck || options.onProgress) {
      this.progressDispatcher = new QwpNotificationDispatcher(
        (callback) => callback(),
        DEFAULT_PROGRESS_INBOX_CAPACITY,
      );
    }
    if (
      options.onError ||
      (options.onSenderError && !connection.managesIngressSenderErrors)
    ) {
      this.errorDispatcher = new QwpNotificationDispatcher(
        (callback) => callback(),
        options.errorInboxCapacity ?? DEFAULT_ERROR_INBOX_CAPACITY,
      );
    }
    for (const entry of connection.ingressSymbolDictionary ?? []) {
      this.symbolDictionary.addRecovered(entry);
    }
    this.publishedMaxSymbolId = this.symbolDictionary.size - 1;
    this.deltaSymbolsPublished = this.symbolDictionary.size > 0;
    if (connection instanceof QwpReconnectingIngressConnection) {
      // Recovered frames advance the transport watermark without forwarding
      // their OK to this session, so the response loop cannot wake waiters.
      connection.setAcknowledgedFrameSequenceListener(() => {
        if (this.acknowledgedSequenceWaiters.size > 0) {
          this.resolveAcknowledgedSequenceWaiters();
        }
      });
    }
    this.receiveLoop = this.consumeMessages();
  }

  static async connect(
    factory: QwpConnectionFactory,
    options: QwpIngressSessionInternalOptions = {},
    /**
     * Cancels a first connect that is still negotiating. The reconnect loop
     * owns its own controller, but the initial attempt bypasses it -- it is
     * either handed in as `initialConnection` or awaited directly below -- so
     * without this a close() during the first connect left the socket and its
     * deadline alive for the full connect/auth timeout.
     */
    signal?: AbortSignal,
  ): Promise<QwpIngressSession> {
    validateIngressSessionOptions(options);
    if (options.replayStore && options.reconnect === false) {
      throw new RangeError("a QWP replayStore requires ingress reconnect");
    }
    // Spread, not `??`: a caller who tunes one field is asking to change that
    // field, not to opt out of every other default. Replacing the object left
    // the connection's per-field fallbacks to supply values that are not the
    // session's policy.
    const reconnectOptions =
      options.reconnect === false
        ? undefined
        : { ...QWP_DEFAULT_INGRESS_RECONNECT_OPTIONS, ...options.reconnect };
    // ASYNC needs the background replay loop, whichever adapter asked for it.
    // Only the Node adapter used to set this internal flag alongside the mode,
    // so a browser session given "async" ran a synchronous startup instead:
    // it blocked the caller and then failed with QwpReconnectExhaustedError.
    const backgroundStoreAndForward =
      options.backgroundStoreAndForward === true ||
      options.initialConnectMode === QWP_INITIAL_CONNECT_MODE.ASYNC;
    // Unset, the connection picks ASYNC for background replay and SYNC
    // otherwise; only a policy that tunes retrying asks for SYNC here.
    const initialConnectMode =
      options.initialConnectMode ??
      (!backgroundStoreAndForward &&
      !selectsQwpSyncInitialConnect(options.reconnect)
        ? QWP_INITIAL_CONNECT_MODE.OFF
        : undefined);
    // Preserve the connector contract that the first browser/Node transport
    // is constructed synchronously. The in-memory replay store initializes
    // asynchronously, but real and test WebSockets may open immediately after
    // their factory returns.
    const initialConnection =
      reconnectOptions &&
      options.reconnect === undefined &&
      !options.replayStore &&
      !backgroundStoreAndForward
        ? factory(signal)
        : undefined;
    const connection = reconnectOptions
      ? await QwpReconnectingIngressConnection.connect(
          factory,
          reconnectOptions,
          options.replayStore,
          options.maxBatchSizeBytes,
          options.memoryReplayMaxBytes,
          options.memoryReplayAppendDeadlineMs,
          backgroundStoreAndForward,
          initialConnectMode,
          options.orphanStoreAndForward,
          options.orphanDurableAckMismatchMaxDurationMs,
          options.catchUpCapGapMinEscalationWindowMs,
          initialConnection,
          options.connectionListenerInboxCapacity ??
            DEFAULT_CONNECTION_LISTENER_INBOX_CAPACITY,
          options.errorInboxCapacity ?? DEFAULT_ERROR_INBOX_CAPACITY,
          options.onSenderError,
          // Without this the signal reached only the eager initialConnection
          // above, which is skipped for exactly the configurations that own a
          // replay store -- so close() could not tear down the one connect
          // that holds a lock.
          signal,
          // The connection keeps its own watermark, so it needs the same
          // answer durableAckTracked gives here: the handshake flag is the
          // server's, and only the caller's request decides whether ordinary
          // OKs or durable progress may advance it.
          options.durableAckKeepaliveMs !== undefined,
        )
      : await factory(signal);
    try {
      return new QwpIngressSession(connection, options);
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  get closed(): Promise<QwpConnectionCloseInfo> {
    return this.connection.closed;
  }

  get handshake(): QwpHandshakeMetadata {
    return this.connection.handshake;
  }

  get maxBatchSizeBytes(): number | undefined {
    const serverBatchCap = this.connection.handshake.maxBatchSizeBytes;
    return this.localMaxBatchSizeBytes === undefined
      ? serverBatchCap
      : serverBatchCap === undefined
        ? this.localMaxBatchSizeBytes
        : Math.min(this.localMaxBatchSizeBytes, serverBatchCap);
  }

  /** Highest stable frame sequence published by this session/transport. */
  get publishedFrameSequence(): bigint {
    // Read through the narrow accessor when the transport has one: this getter
    // runs several times per flush, and the full snapshot is O(backlog).
    return (
      this.connection.getPublishedFrameSequence?.() ??
      this.connection.getIngressMetrics?.().publishedFrameSequence ??
      this.nextSequence - 1n
    );
  }

  /**
   * Whether this session maintains a durable watermark at all.
   *
   * The handshake flag on its own is not enough: durable targets are tracked
   * only when the caller asked for durable progress with
   * durableAckKeepaliveMs. The
   * two conditions have to be read together everywhere, because a session
   * that reports a watermark nothing advances is worse than one that reports
   * the ordinary ACK -- it stalls rather than degrades.
   *
   * Zero is a tracking-on, polling-off setting and stays inside the tracked
   * set; only `undefined` means the caller never asked.
   */
  private get durableAckTracked(): boolean {
    return (
      this.options.durableAckKeepaliveMs !== undefined &&
      this.connection.handshake.durableAckEnabled === true
    );
  }

  /**
   * Highest cumulative ACK watermark. When durable ACK is being tracked this
   * advances only after durability; otherwise it follows ordinary OK ACKs.
   */
  get acknowledgedFrameSequence(): bigint {
    const transport = this.connection.getIngressMetrics?.();
    if (transport) return transport.acknowledgedFrameSequence;
    // Keyed on tracking, not on the handshake flag alone. A server that
    // reports durable-ACK support the caller never asked for -- or a session
    // built directly on a durable-capable connection without
    // durableAckKeepaliveMs -- left this pinned at -1n while the server's
    // cumulative OK had already landed, so waitForAcknowledged() timed out on
    // acknowledged frames and close() failed with QwpSenderCloseTimeoutError
    // and "pending data may be lost" on a fully acknowledged sender.
    return this.durableAckTracked
      ? this.durableAcknowledgedSequence
      : this.acknowledgedSequence;
  }

  get metrics(): QwpIngressMetrics {
    const transport = this.connection.getIngressMetrics?.();
    return Object.freeze({
      publishedSequence: this.nextSequence - 1n,
      acknowledgedSequence: this.acknowledgedSequence,
      pendingDurableTables: this.pendingDurableTargets.size,
      totalFramesPublished: this.totalFramesPublished,
      totalBytesPublished: this.totalBytesPublished,
      totalFramesSent: transport?.totalFramesSent ?? this.totalFramesSent,
      totalBytesSent: transport?.totalBytesSent ?? this.totalBytesSent,
      totalFramesReplayed: transport?.totalFramesReplayed ?? 0,
      totalBytesReplayed: transport?.totalBytesReplayed ?? 0,
      totalAcks: this.totalAcks,
      totalNacks: transport?.totalServerNacks ?? this.totalNacks,
      totalDurableAcks: this.totalDurableAcks,
      totalErrors: this.totalErrors,
      totalReconnectAttempts: transport?.totalReconnectAttempts ?? 0,
      totalReconnectsSucceeded: transport?.totalReconnectsSucceeded ?? 0,
      totalFailovers: transport?.totalFailovers ?? 0,
      totalReconnectErrors: transport?.totalReconnectErrors ?? 0,
      deliveredProgressNotifications:
        this.progressDispatcher?.metrics.delivered ?? 0,
      droppedProgressNotifications:
        this.progressDispatcher?.metrics.dropped ?? 0,
      deliveredConnectionNotifications:
        transport?.deliveredConnectionNotifications ?? 0,
      droppedConnectionNotifications:
        transport?.droppedConnectionNotifications ?? 0,
      deliveredErrorNotifications:
        (transport?.deliveredErrorNotifications ?? 0) +
        (this.errorDispatcher?.metrics.delivered ?? 0) +
        (this.options.priorSenderErrorDeliveries?.() ?? 0),
      droppedErrorNotifications:
        (transport?.droppedErrorNotifications ?? 0) +
        (this.errorDispatcher?.metrics.dropped ?? 0),
      replayPublishedFrameSequence: transport?.publishedFrameSequence,
      replayAcknowledgedFrameSequence: transport?.acknowledgedFrameSequence,
      pendingReplayFrames: transport?.pendingReplayFrames ?? 0,
      pendingReplayBytes: transport?.pendingReplayBytes ?? 0,
      memoryReplayMaxBytes: transport?.memoryReplayMaxBytes,
      memoryReplayUsedBytes: transport?.memoryReplayUsedBytes,
      waitingMemoryReplayAppends: transport?.waitingMemoryReplayAppends ?? 0,
      totalMemoryReplayBackpressureStalls:
        transport?.totalMemoryReplayBackpressureStalls ?? 0,
      totalMemoryReplayAppendTimeouts:
        transport?.totalMemoryReplayAppendTimeouts ?? 0,
      lastError: this.lastError,
    });
  }

  /**
   * Encodes and publishes tables without waiting for their server ACK. This
   * resolves once every frame is published locally: in the journal with Node
   * store-and-forward, in the in-memory replay queue for other reconnecting
   * sessions, or on the WebSocket for a fixed connection. Pass
   * publishedFrameSequence to waitForAcknowledged() to wait for the ACK.
   */
  publishTables(
    tables: readonly QwpTableBuffer[],
    encodeOptions: QwpIngressEncodeOptions = {},
  ): Promise<void> {
    this.throwIfUnavailable();
    let planned: PlannedIngressFrames;
    try {
      planned = planIngressFrames(
        tables,
        encodeOptions,
        this.maxBatchSizeBytes,
      );
    } catch (error) {
      if (error instanceof QwpBatchTooLargeError) return Promise.reject(error);
      throw error;
    }
    return this.publishPlannedFrames(planned.frames);
  }

  /**
   * Publishes tables with the automatic connection-scoped symbol dictionary.
   * After a replay dictionary persistence error, retries use full inline
   * symbols and no longer depend on the failed sidecar.
   */
  async publishTablesDelta(
    tables: readonly QwpTableBuffer[],
    encodeOptions: Pick<
      QwpIngressEncodeOptions,
      "gorilla" | "deferCommit"
    > = {},
  ): Promise<void> {
    this.throwIfUnavailable();
    if (this.connection.ingressDeltaSymbolDictionaryEnabled === false) {
      return this.publishTables(tables, encodeOptions);
    }
    const releaseDeltaPublication = await this.acquireDeltaPublication();
    const previousSize = this.symbolDictionary.size;
    const previousPublishedMaxSymbolId = this.publishedMaxSymbolId;
    const previousDeltaSymbolsPublished = this.deltaSymbolsPublished;
    let successfullyPublishedMaxSymbolId = previousPublishedMaxSymbolId;
    let successfullyPublishedDelta = previousDeltaSymbolsPublished;
    const recordPublishedDelta = (frame: Uint8Array): void => {
      const delta = decodeQwpIngressSymbolDictionaryDelta(frame);
      if (!delta) return;
      successfullyPublishedDelta = true;
      successfullyPublishedMaxSymbolId = Math.max(
        successfullyPublishedMaxSymbolId,
        delta.startId + delta.entries.length - 1,
      );
    };
    try {
      const planned = planIngressFrames(
        tables,
        {
          ...encodeOptions,
          dictionary: this.symbolDictionary,
          confirmedMaxSymbolId: this.publishedMaxSymbolId,
        },
        this.maxBatchSizeBytes,
      );
      this.publishedMaxSymbolId = this.symbolDictionary.size - 1;
      this.deltaSymbolsPublished = true;
      await this.publishPlannedFrames(planned.frames, recordPublishedDelta);
    } catch (error) {
      this.restoreDeltaStateAfterPublishFailure(
        Math.max(previousSize, successfullyPublishedMaxSymbolId + 1),
      );
      this.publishedMaxSymbolId = successfullyPublishedMaxSymbolId;
      this.deltaSymbolsPublished = successfullyPublishedDelta;
      throw error;
    } finally {
      releaseDeltaPublication();
    }
  }

  /**
   * Serializes delta planning: each publication plans against the dictionary
   * state the previous one left, so the next waits until it is released.
   */
  private async acquireDeltaPublication(): Promise<() => void> {
    while (this.deltaPublicationBarrier) {
      await this.deltaPublicationBarrier;
    }
    let resolve!: () => void;
    const barrier = new Promise<void>((done) => {
      resolve = done;
    });
    this.deltaPublicationBarrier = barrier;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.deltaPublicationBarrier === barrier) {
        this.deltaPublicationBarrier = undefined;
      }
      resolve();
    };
  }

  /**
   * Restores the dictionary ID allocator after a failed asynchronous publish.
   *
   * A replay transport persists new dictionary entries before it appends the
   * frame that uses them. If that frame append fails, the persisted dictionary
   * is authoritative even though the frame-publication watermark must roll
   * back. Keeping those IDs prevents a changed retry from assigning a
   * different symbol to an already durable ID. The unchanged published
   * watermark makes the retry include the durable-but-unpublished prefix.
   */
  private restoreDeltaStateAfterPublishFailure(retainedSize: number): void {
    if (!(this.connection instanceof QwpReconnectingIngressConnection)) {
      // A split publication may have transferred an early frame before a
      // later send failed. Those symbol IDs are already connection-visible and
      // the published watermark deliberately retains them; truncating below
      // that watermark makes every subsequent encode fail before it can retry.
      this.symbolDictionary.truncate(retainedSize);
      return;
    }
    const recovered = this.connection.ingressSymbolDictionary;
    this.symbolDictionary.reset();
    for (const entry of recovered) {
      this.symbolDictionary.addRecovered(entry);
    }
  }

  /**
   * Publishes one pre-encoded frame without waiting for its server ACK. Like
   * publishTables(), this resolves once the frame is published locally; pass
   * publishedFrameSequence to waitForAcknowledged() to wait for the ACK, or
   * observe acceptance through the progress callbacks.
   */
  publishFrame(frame: Uint8Array): Promise<void> {
    this.throwIfUnavailable();
    if (
      this.maxBatchSizeBytes !== undefined &&
      frame.byteLength > this.maxBatchSizeBytes
    ) {
      return Promise.reject(
        new QwpBatchTooLargeError(frame.byteLength, this.maxBatchSizeBytes),
      );
    }
    const sequence = this.nextSequence++;
    this.totalFramesPublished++;
    this.totalBytesPublished += frame.byteLength;
    const publishing = this.sendTail.then(async () => {
      this.throwIfUnavailable();
      this.highestSentSequence = sequence;
      await this.connection.send(frame);
    });
    // A local store-capacity failure is backpressure, not a terminal session
    // failure. Keep the publication queue usable so callers can retry after
    // the background drainer frees journal capacity.
    this.sendTail = publishing.catch(() => undefined);
    this.emitProgress(QWP_INGRESS_PROGRESS_KIND.PUBLISHED, sequence);
    void publishing.then(
      () => {
        this.totalFramesSent++;
        this.totalBytesSent += frame.byteLength;
      },
      () => undefined,
    );
    return publishing;
  }

  private publishPlannedFrames(
    frames: readonly Uint8Array[],
    onFramePublished?: (frame: Uint8Array) => void,
  ): Promise<void> {
    let publicationBarrier = this.sendTail;
    if (frames.length > 1 && this.connection.prepareIngressBatch) {
      publicationBarrier = publicationBarrier.then(() =>
        this.connection.prepareIngressBatch!(frames),
      );
    }
    for (const frame of frames) {
      const sequence = this.nextSequence++;
      this.totalFramesPublished++;
      this.totalBytesPublished += frame.byteLength;
      const publishing = publicationBarrier.then(
        async () => {
          this.throwIfUnavailable();
          this.highestSentSequence = sequence;
          await this.connection.send(frame);
        },
        (error: unknown) => {
          // Keep replay ACK translation aligned when the whole-batch preflight,
          // or an earlier frame, prevents this sequence from reaching send().
          this.connection.skipIngressClientSequence?.();
          throw error;
        },
      );
      void publishing.then(
        () => {
          this.totalFramesSent++;
          this.totalBytesSent += frame.byteLength;
        },
        () => undefined,
      );
      this.emitProgress(QWP_INGRESS_PROGRESS_KIND.PUBLISHED, sequence);
      publicationBarrier = onFramePublished
        ? publishing.then(() => onFramePublished(frame))
        : publishing;
    }
    this.sendTail = publicationBarrier.catch(() => undefined);
    return publicationBarrier;
  }

  /**
   * Waits until the cumulative ACK watermark covers `targetSequence`, a frame
   * sequence such as publishedFrameSequence. Resolves true once it does, and
   * false when the watermark makes no progress for `timeoutMs` (ackTimeoutMs
   * by default): the deadline restarts whenever the watermark advances, so a
   * backlog that keeps draining is not cut off. After false the frames stay
   * queued and are still delivered. As in the Java client, a `timeoutMs` of
   * zero or less checks the watermark without waiting. Rejects when the
   * server rejects a covered frame or the session fails; a latched session
   * failure throws even from a check that does not wait. With durable ACK
   * tracking the watermark advances only after durability. A negative target
   * is already satisfied.
   */
  waitForAcknowledged(
    targetSequence: bigint,
    timeoutMs = this.options.ackTimeoutMs ?? 15_000,
  ): Promise<boolean> {
    this.throwIfUnavailable();
    if (typeof targetSequence !== "bigint") {
      return Promise.reject(
        new TypeError("QWP ACK target sequence must be a bigint"),
      );
    }
    if (!Number.isFinite(timeoutMs) || exceedsQwpTimerCeiling(timeoutMs)) {
      return Promise.reject(
        new RangeError(
          `QWP ACK watermark timeout must be finite and no greater than ${QWP_MAX_TIMER_DELAY_MS}`,
        ),
      );
    }
    const rejection = this.acknowledgementFailure(targetSequence);
    if (rejection) return Promise.reject(rejection);
    const acknowledged = this.acknowledgedFrameSequence;
    if (targetSequence < 0n || acknowledged >= targetSequence) {
      return Promise.resolve(true);
    }
    if (timeoutMs <= 0) return Promise.resolve(false);

    return new Promise<boolean>((resolve, reject) => {
      const pending: PendingAcknowledgedSequence = {
        targetSequence,
        resolve,
        reject,
        lastSeen: acknowledged,
        lastProgressMs: monotonicNowMs(),
      };
      // Armed once per deadline rather than on every ACK: when it fires, a
      // wait that saw progress is re-armed for the rest of its window.
      const arm = (delayMs: number): void => {
        pending.timer = setTimeout(() => {
          // Settle first: a wait whose target the watermark already covers,
          // or that a rejection or retirement already decided, must not
          // expire merely because no notification reached it.
          this.resolveAcknowledgedSequenceWaiters();
          if (!this.acknowledgedSequenceWaiters.has(pending)) return;
          const idleMs = monotonicNowMs() - pending.lastProgressMs;
          if (idleMs < timeoutMs) {
            arm(Math.max(1, timeoutMs - idleMs));
            return;
          }
          this.acknowledgedSequenceWaiters.delete(pending);
          // Reported to the caller only. A wait's budget expiring is not a
          // session failure, so it does not reach onError or the logger.
          resolve(false);
        }, delayMs);
      };
      arm(timeoutMs);
      this.acknowledgedSequenceWaiters.add(pending);
      // Close the ACK-before-registration race. JavaScript is single-threaded,
      // but a custom connection can synchronously enqueue a response callback.
      this.resolveAcknowledgedSequenceWaiters();
    });
  }

  /**
   * Prompts the server to publish its latest durable-ingress watermarks.
   * Node transports use a WebSocket PING; browsers send the protocol-level
   * table-less durable-ACK poll frame. Browser completion means the control
   * frame was published; durable progress arrives independently because the
   * server may withhold its cumulative OK while a transaction remains open.
   */
  pollDurableAck(): Promise<void> {
    this.throwIfUnavailable();
    if (!this.connection.handshake.durableAckEnabled) {
      return Promise.reject(
        new Error("durable ACK was not negotiated for this session"),
      );
    }
    return this.connection.ping
      ? this.connection.ping()
      : this.publishBrowserDurableAckPoll();
  }

  /**
   * Publishes a browser control poll. QuestDB can answer it with durable
   * progress while deferring its cumulative OK behind an open transaction, so
   * callers only wait for local publication. A rejection of the poll frame is
   * handled like a rejection of any other frame.
   */
  private publishBrowserDurableAckPoll(): Promise<void> {
    return this.publishFrame(encodeQwpDurableAckPollFrame());
  }

  /** @internal Waits for RAM replay to reach the socket before fast close. */
  waitForPendingSends(): Promise<void> {
    return this.connection instanceof QwpReconnectingIngressConnection
      ? this.connection.waitForPendingSends()
      : Promise.resolve();
  }

  /** @internal Registers runtime-specific cleanup owned by this session. */
  registerCloseHook(hook: () => void | Promise<void>): void {
    if (this.closing) {
      throw new QwpIngressSessionClosedError();
    }
    this.closeHooks.push(hook);
  }

  /**
   * Closes the session and its connection. Frames already published to the
   * in-memory replay queue first get up to 5 seconds to reach the socket. Any
   * that cannot be sent in that time, typically because no server is
   * reachable, are discarded, and close() rejects with
   * QwpIngressSessionCloseTimeoutError once the connection is closed, or with
   * the session's failure when it can no longer send them at all. A
   * store-and-forward journal keeps unsent frames for the next session, so it
   * is not drained. close() does not wait for ACKs: wait for
   * publishedFrameSequence with waitForAcknowledged() first when the frames
   * must be confirmed before closing.
   */
  close(code = 1000, reason = ""): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.closeNow(code, reason, CLOSE_DRAIN_TIMEOUT_MS);
    }
    return this.closePromise;
  }

  /**
   * @internal Closes without draining unsent frames first. QwpSender bounds
   * its own drain, and reports its outcome, before it closes the session.
   */
  closeWithoutDrain(code = 1000, reason = ""): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeNow(code, reason, 0);
    return this.closePromise;
  }

  private async closeNow(
    code: number,
    reason: string,
    drainTimeoutMs: number,
  ): Promise<void> {
    this.closing = true;
    this.clearDurablePoll();
    this.rejectAll(new QwpIngressSessionClosedError());
    // Before the transport closes: closing it discards the in-memory queue.
    const discarded =
      drainTimeoutMs > 0
        ? await this.drainUnsentFrames(drainTimeoutMs)
        : undefined;
    const closeHooks = this.closeHooks.splice(0).map((hook) =>
      Promise.resolve()
        .then(hook)
        .catch(() => undefined),
    );
    let transportClose: Promise<void>;
    try {
      transportClose = this.connection.close(code, reason);
    } catch (error) {
      transportClose = Promise.reject(error);
    }
    const [, closeResult] = await Promise.allSettled([
      this.sendTail,
      transportClose,
      this.receiveLoop,
      ...closeHooks,
    ]);
    await Promise.all([
      this.progressDispatcher?.close(),
      this.errorDispatcher?.close(),
    ]);
    if (discarded) throw discarded;
    if (closeResult.status === "rejected") throw closeResult.reason;
  }

  /**
   * Gives frames already published to the in-memory replay queue up to
   * `timeoutMs` to reach the socket, and returns the error close() reports
   * when some of them could not be sent. Publication used to end at the
   * socket, so a published frame could never be left behind by close(). Now
   * that it ends at the queue, closing straight away discarded whatever the
   * background drainer had not sent yet -- silently, after every publish call
   * had resolved.
   */
  private async drainUnsentFrames(
    timeoutMs: number,
  ): Promise<Error | undefined> {
    const connection = this.connection;
    if (!(connection instanceof QwpReconnectingIngressConnection)) {
      // A fixed connection publishes on the socket itself.
      return undefined;
    }
    let failure: unknown;
    // Frames still on their way into the queue are refused rather than waited
    // for: one blocked on a full queue would otherwise hold close() for its
    // whole append deadline, and its publish call reports the refusal.
    connection.stopPublishing();
    const drained = connection.waitForPendingSends().then(
      () => "drained" as const,
      (error: unknown) => {
        failure = error;
        return "failed" as const;
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), timeoutMs);
    });
    try {
      const outcome = await Promise.race([drained, expired]);
      if (outcome === "drained") return undefined;
      if (outcome === "failed") {
        // The frames are lost because the session can no longer send; its
        // own failure says why better than the transport's echo of it.
        return (
          this.failure ??
          (failure instanceof Error
            ? failure
            : new Error(`QWP ingress failed: ${failure}`))
        );
      }
      const unsent = connection.unsentFrameCount;
      return unsent > 0
        ? new QwpIngressSessionCloseTimeoutError(timeoutMs, unsent)
        : undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async consumeMessages(): Promise<void> {
    try {
      for await (const payload of this.connection.messages) {
        this.handleResponse(decodeQwpIngressResponse(payload));
      }
      if (!this.closing) {
        this.fail(
          new QwpIngressSessionClosedError(await this.connection.closed),
        );
      }
    } catch (error) {
      this.fail(error);
      if (error instanceof QwpProtocolError) {
        // A reconnecting transport's close() awaits the replay store, and a
        // persistent store rethrows a checkpoint, segment-handle or lock
        // release failure. Discarding that rejection would surface it as an
        // unhandled rejection, which terminates the process by default.
        void this.connection
          .close(1002, "invalid QWP response")
          .catch(() => undefined);
      }
    }
  }

  private handleResponse(response: QwpIngressResponse): void {
    this.dispatchProgressCallback(this.options.onResponse, response);
    if (response.status === QWP_STATUS.DURABLE_ACK) {
      this.totalDurableAcks++;
      const advanced = this.applyDurableAck(response);
      this.dispatchProgressCallback(this.options.onDurableAck, response);
      if (advanced) {
        this.emitProgress(
          QWP_INGRESS_PROGRESS_KIND.DURABLE_ACKNOWLEDGED,
          undefined,
          response,
        );
      }
      return;
    }
    if (response.sequence === null) {
      throw new QwpProtocolError("QWP response is missing its wire sequence");
    }
    if (response.sequence > this.highestSentSequence) {
      // A peer can acknowledge only a frame allocated by this session. Trusting
      // a larger cumulative sequence would resolve future ACK barriers and make
      // an unsent or unacknowledged frame appear accepted.
      throw new QwpProtocolError(
        `QWP response sequence is beyond the last frame sent: ${response.sequence} > ${this.highestSentSequence}`,
      );
    }
    if (response.status === QWP_STATUS.OK) {
      this.totalAcks++;
      this.trackDurableFrame(response);
      this.trackDurableTargets(response);
      if (response.sequence > this.acknowledgedSequence) {
        this.acknowledgedSequence = response.sequence;
        this.emitProgress(
          QWP_INGRESS_PROGRESS_KIND.ACKNOWLEDGED,
          response.sequence,
          response,
        );
      }
      this.resolveAcknowledgedSequenceWaiters();
      return;
    }

    this.totalNacks++;
    const fsn = this.connection.getIngressFrameSequence?.(response.sequence);
    const senderError = createQwpSenderError(response, {
      appliedPolicy: this.connection.managesIngressSenderErrors
        ? undefined
        : QWP_SENDER_ERROR_POLICY.TERMINAL,
      fromFsn: fsn ?? response.sequence,
      toFsn: fsn ?? response.sequence,
    });
    const error = new QwpIngressNackError(response, senderError);
    if (
      !this.acknowledgementRejection ||
      response.sequence < this.acknowledgementRejection.sequence
    ) {
      this.acknowledgementRejection = { sequence: response.sequence, error };
    }
    this.rejectAcknowledgedSequenceWaitersThrough(response.sequence, error);
    const dictionaryGap =
      this.deltaSymbolsPublished &&
      response.status === QWP_STATUS.DICTIONARY_GAP;
    const directPipelineBroken =
      this.connection.managesIngressSenderErrors !== true;
    this.recordError(
      error,
      dictionaryGap || directPipelineBroken,
      response,
      senderError,
    );
    if (dictionaryGap || directPipelineBroken) {
      // QuestDB stops processing later frames on a connection after any NACK
      // so its cumulative ACK cannot skip the rejected sequence. Reconnecting
      // transports recycle and replay below their last ACK; a fixed/direct
      // session has no such recovery path and must fail closed immediately.
      this.fail(error, true);
      // See consumeMessages(): a rejecting store close must not escape here.
      void this.connection
        .close(
          1002,
          dictionaryGap
            ? "QWP symbol dictionary gap"
            : "QWP ingress pipeline rejected",
        )
        .catch(() => undefined);
    }
  }

  private dispatchProgressCallback<T>(
    callback: ((event: T) => void) | undefined,
    event: T,
  ): void {
    if (!callback || !this.progressDispatcher) return;
    this.progressDispatcher.offer(() => safelyInvoke(callback, event));
  }

  private emitProgress(
    kind: QwpIngressProgressKind,
    sequence?: bigint,
    response?: QwpIngressResponse,
  ): void {
    // The guard has to come first. `metrics` is an argument, so it was built
    // before dispatchProgressCallback could early-return on a missing
    // observer -- a metrics snapshot per published frame that nobody read.
    const callback = this.options.onProgress;
    if (!callback || !this.progressDispatcher) return;
    this.dispatchProgressCallback(callback, {
      kind,
      timestampMs: Date.now(),
      sequence,
      response,
      metrics: this.metrics,
    });
  }

  private recordError(
    error: unknown,
    terminal: boolean,
    response?: QwpIngressResponse,
    senderError?: QwpSenderError,
  ): Error {
    const observed =
      error instanceof Error
        ? error
        : new Error(`QWP ingress failed: ${error}`);
    this.lastError = observed;
    this.totalErrors++;
    const event: QwpIngressErrorEvent = {
      error: observed,
      terminal,
      timestampMs: Date.now(),
      response,
      senderError,
      metrics: this.metrics,
    };
    // Up to two observers run per notification, so the inbox only serializes
    // correctly if it waits for both. Returning one and dropping the other
    // would leave the second re-entered while the first is still running.
    const notify = (): PromiseLike<unknown> | undefined => {
      const pending: PromiseLike<unknown>[] = [];
      const observe = (observer?: PromiseLike<unknown>): void => {
        if (observer) pending.push(observer);
      };
      observe(safelyInvoke(this.options.onError, event));
      if (senderError && !this.connection.managesIngressSenderErrors) {
        observe(
          safelyInvoke(
            this.options.onSenderError ?? defaultQwpSenderErrorHandler,
            senderError,
          ),
        );
      } else if (!senderError && !this.options.onError) {
        observe(
          safelyInvoke(
            defaultQwpIngressErrorHandler,
            Object.freeze({ terminal, error: observed }),
          ),
        );
      }
      return pending.length > 0 ? Promise.all(pending) : undefined;
    };
    if (this.errorDispatcher) this.errorDispatcher.offer(notify);
    else notify();
    return observed;
  }

  private trackDurableTargets(response: QwpIngressResponse): void {
    if (!this.durableAckTracked) return;
    for (const table of response.tables) {
      const durable = this.durableWatermarks.get(table.name);
      if (durable !== undefined && durable >= table.sequenceTransaction) {
        continue;
      }
      const pending = this.pendingDurableTargets.get(table.name);
      if (pending === undefined || table.sequenceTransaction > pending) {
        this.pendingDurableTargets.set(table.name, table.sequenceTransaction);
      }
    }
    this.scheduleDurablePoll();
  }

  private trackDurableFrame(response: QwpIngressResponse): void {
    if (!this.durableAckTracked) return;
    this.durableFrameTargets.set(
      response.sequence!,
      new Map(
        response.tables.map((table) => [table.name, table.sequenceTransaction]),
      ),
    );
    this.advanceDurableFrameWatermark();
  }

  private applyDurableAck(response: QwpIngressResponse): boolean {
    let advanced = false;
    for (const table of response.tables) {
      const watermark = this.durableWatermarks.get(table.name);
      if (watermark === undefined || table.sequenceTransaction > watermark) {
        this.durableWatermarks.set(table.name, table.sequenceTransaction);
        advanced = true;
      }
      const target = this.pendingDurableTargets.get(table.name);
      if (target !== undefined && table.sequenceTransaction >= target) {
        this.pendingDurableTargets.delete(table.name);
      }
    }

    const frameAdvanced = this.advanceDurableFrameWatermark();
    this.resolveAcknowledgedSequenceWaiters();
    if (this.pendingDurableTargets.size === 0) {
      this.clearDurablePoll();
    } else {
      this.scheduleDurablePoll();
    }
    this.pruneCompletedDurableWatermarks();
    return advanced || frameAdvanced;
  }

  /**
   * A table name can be dropped and recreated with a fresh transaction space.
   * Retain watermarks only while some frame or waiter still needs them; the
   * cumulative durable frame sequence preserves completed-response lookups.
   */
  private pruneCompletedDurableWatermarks(): void {
    for (const table of this.durableWatermarks.keys()) {
      if (this.pendingDurableTargets.has(table)) continue;
      let referenced = false;
      for (const targets of this.durableFrameTargets.values()) {
        if (targets.has(table)) {
          referenced = true;
          break;
        }
      }
      if (!referenced) this.durableWatermarks.delete(table);
    }
  }

  private advanceDurableFrameWatermark(): boolean {
    let advanced = false;
    for (const [sequence, targets] of this.durableFrameTargets) {
      if (!this.areDurableTargetsCovered(targets)) break;
      this.durableFrameTargets.delete(sequence);
      if (sequence > this.durableAcknowledgedSequence) {
        this.durableAcknowledgedSequence = sequence;
        advanced = true;
      }
    }
    return advanced;
  }

  private resolveAcknowledgedSequenceWaiters(): void {
    const acknowledged = this.acknowledgedFrameSequence;
    for (const pending of this.acknowledgedSequenceWaiters) {
      const failure = this.acknowledgementFailure(pending.targetSequence);
      if (failure) {
        this.acknowledgedSequenceWaiters.delete(pending);
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(failure);
        continue;
      }
      if (pending.targetSequence > acknowledged) {
        this.observeWaiterProgress(pending, acknowledged);
        continue;
      }
      this.acknowledgedSequenceWaiters.delete(pending);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(true);
    }
  }

  /** Restarts a wait's no-progress deadline when the watermark has advanced. */
  private observeWaiterProgress(
    pending: PendingAcknowledgedSequence,
    acknowledged: bigint,
  ): void {
    if (acknowledged <= pending.lastSeen) return;
    pending.lastSeen = acknowledged;
    pending.lastProgressMs = monotonicNowMs();
  }

  private acknowledgementFailure(targetSequence: bigint): Error | undefined {
    const abandoned = this.connection
      .getIngressMetrics?.()
      .abandonedFrameRanges?.find(
        (range) =>
          targetSequence >= range.fromFsn && targetSequence <= range.toFsn,
      );
    if (abandoned) {
      return new QwpIngressAckAbandonedError(
        targetSequence,
        abandoned.fromFsn,
        abandoned.toFsn,
      );
    }
    const rejection = this.acknowledgementRejection;
    return rejection && rejection.sequence <= targetSequence
      ? rejection.error
      : undefined;
  }

  private rejectAcknowledgedSequenceWaitersThrough(
    sequence: bigint,
    error: Error,
  ): void {
    for (const pending of this.acknowledgedSequenceWaiters) {
      if (pending.targetSequence < sequence) continue;
      this.acknowledgedSequenceWaiters.delete(pending);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private areDurableTargetsCovered(
    targets: ReadonlyMap<string, bigint>,
  ): boolean {
    for (const [table, target] of targets) {
      const watermark = this.durableWatermarks.get(table);
      if (watermark === undefined || watermark < target) return false;
    }
    return true;
  }

  private scheduleDurablePoll(): void {
    const interval = this.options.durableAckKeepaliveMs;
    // Zero is tracked but never polled, so it is excluded here and nowhere
    // else.
    if (
      interval === 0 ||
      !this.durableAckTracked ||
      this.pendingDurableTargets.size === 0 ||
      this.durablePollTimer
    ) {
      return;
    }
    this.durablePollTimer = setTimeout(() => {
      this.durablePollTimer = undefined;
      if (
        this.closing ||
        this.failure ||
        this.pendingDurableTargets.size === 0
      ) {
        return;
      }
      const poll = this.connection.ping
        ? this.connection.ping()
        : this.publishBrowserDurableAckPoll();
      void poll
        .then(() => this.scheduleDurablePoll())
        .catch((error: unknown) => this.fail(error));
    }, interval);
  }

  private clearDurablePoll(): void {
    if (!this.durablePollTimer) return;
    clearTimeout(this.durablePollTimer);
    this.durablePollTimer = undefined;
  }

  private throwIfUnavailable(): void {
    if (this.failure) throw this.failure;
    if (this.closing) throw new QwpIngressSessionClosedError();
  }

  private fail(error: unknown, alreadyObserved = false): void {
    if (this.failure) return;
    this.clearDurablePoll();
    this.failure = alreadyObserved
      ? error instanceof Error
        ? error
        : new Error(`QWP ingress failed: ${error}`)
      : this.recordError(error, true);
    this.rejectAll(this.failure);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.acknowledgedSequenceWaiters) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.acknowledgedSequenceWaiters.clear();
  }
}

function defaultQwpIngressErrorHandler(event: {
  readonly terminal: boolean;
  readonly error: Error;
}): void {
  log(
    event.terminal ? "error" : "warn",
    `QWP ingress ${event.terminal ? "terminated" : "reported an asynchronous failure"} [message=${event.error.message}]`,
  );
}
