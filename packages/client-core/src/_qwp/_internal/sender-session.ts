import type { QwpIngressEncodeOptions, QwpTableBuffer } from "../_core";
import type { QwpIngressMetrics } from "../ingress-session";

/**
 * The subset of QwpIngressSession used by QwpSender.
 *
 * Internal seam between the high-level sender and its runtime transports
 * (QwpIngressSession for WebSocket ingress, QwpNodeUdpSession for UDP). It is
 * not a public extension point: applications obtain senders from the runtime
 * factories or a pooled client, so this contract can change with them.
 *
 * A flush publishes through `publishTables` (or `publishTablesDelta`, when the
 * session carries incremental symbol dictionaries) and observes the result
 * through the published and acknowledged frame watermarks.
 *
 * @internal
 */
export interface QwpSenderSession {
  readonly metrics?: QwpIngressMetrics;
  readonly maxBatchSizeBytes?: number;
  /** Highest frame sequence published locally, or -1n before the first. */
  readonly publishedFrameSequence: bigint;
  /** Highest frame sequence covered by the cumulative ACK watermark. */
  readonly acknowledgedFrameSequence: bigint;
  /**
   * The last frame recovered from a replay journal that a server ACK will
   * cover, or -1n. Sessions without a journal leave it undefined.
   */
  readonly recoveredCommitFrameSequence?: bigint;
  publishTables(
    tables: readonly QwpTableBuffer[],
    options?: QwpIngressEncodeOptions,
  ): Promise<void>;
  publishTablesDelta?(
    tables: readonly QwpTableBuffer[],
    options?: Pick<QwpIngressEncodeOptions, "gorilla" | "deferCommit">,
  ): Promise<void>;
  /**
   * Resolves true once the ACK watermark covers `targetSequence`, and false
   * when it makes no progress for `timeoutMs`; zero or less checks without
   * waiting. Rejects with the session's failure once it can no longer advance.
   */
  waitForAck(targetSequence: bigint, timeoutMs?: number): Promise<boolean>;
  /** Optional socket-send boundary for RAM-backed fast close. */
  waitForPendingSends?(): Promise<void>;
  /**
   * Closes without a drain of its own. QwpSender has already applied its
   * bounded drain, and reported the outcome, by the time it closes the
   * session, so waiting again would only stretch close() past its deadline.
   */
  close(code?: number, reason?: string): Promise<void>;
}

/**
 * Opens the sender's session. The signal is aborted by close(), so a connect
 * still negotiating can be torn down instead of outliving the sender by up to
 * its connect/auth deadline. Factories that ignore the parameter remain
 * assignable, matching QwpConnectionFactory.
 *
 * @internal
 */
export type QwpSenderSessionFactory = (
  signal?: AbortSignal,
) => Promise<QwpSenderSession>;
