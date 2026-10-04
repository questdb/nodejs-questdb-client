import type {
  QwpIngressEncodeOptions,
  QwpIngressResponse,
  QwpTableBuffer,
} from "../_core";
import type {
  QwpIngressMetrics,
  QwpIngressSendResult,
} from "../ingress-session";

/**
 * The subset of QwpIngressSession used by QwpSender.
 *
 * Internal seam between the high-level sender and its runtime transports
 * (QwpIngressSession for WebSocket ingress, QwpNodeUdpSession for UDP). It is
 * not a public extension point: applications obtain senders from the runtime
 * factories or a pooled client, so this contract can change with them.
 *
 * Only `sendTables`, `waitForDurable`, and `close` are required. The optional
 * members are capabilities the sender uses when present: the `*WithPublication`
 * and `publish*` pairs separate the local publication boundary from the server
 * ACK, `sendTablesDelta`/`publishTablesDelta` carry incremental symbol
 * dictionaries, and `waitForAcknowledged` exposes the ACK watermark. A session
 * that implements only the required members is supported and falls back to
 * `sendTables`.
 *
 * @internal
 */
export interface QwpSenderSession {
  readonly metrics?: QwpIngressMetrics;
  readonly maxBatchSizeBytes?: number;
  readonly publishedFrameSequence?: bigint;
  readonly acknowledgedFrameSequence?: bigint;
  sendTables(
    tables: readonly QwpTableBuffer[],
    options?: QwpIngressEncodeOptions,
  ): Promise<QwpIngressResponse>;
  sendTablesDelta?(
    tables: readonly QwpTableBuffer[],
    options?: Pick<QwpIngressEncodeOptions, "gorilla" | "deferCommit">,
  ): Promise<QwpIngressResponse>;
  sendTablesWithPublication?(
    tables: readonly QwpTableBuffer[],
    options?: QwpIngressEncodeOptions,
  ): QwpIngressSendResult;
  sendTablesDeltaWithPublication?(
    tables: readonly QwpTableBuffer[],
    options?: Pick<QwpIngressEncodeOptions, "gorilla" | "deferCommit">,
  ): QwpIngressSendResult;
  publishTables?(
    tables: readonly QwpTableBuffer[],
    options?: QwpIngressEncodeOptions,
  ): Promise<void>;
  publishTablesDelta?(
    tables: readonly QwpTableBuffer[],
    options?: Pick<QwpIngressEncodeOptions, "gorilla" | "deferCommit">,
  ): Promise<void>;
  waitForAcknowledged?(
    targetSequence: bigint,
    timeoutMs?: number,
  ): Promise<void>;
  /** Optional socket-send boundary for RAM-backed fast close. */
  waitForPendingSends?(): Promise<void>;
  waitForDurable(
    response: QwpIngressResponse,
    timeoutMs?: number,
  ): Promise<void>;
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
