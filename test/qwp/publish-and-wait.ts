import type { QwpTableBuffer } from "../../packages/client-core/src/qwp";
import type { QwpIngressSession } from "../../packages/client-core/src/_qwp/ingress-session";

/**
 * Publishes one frame, then waits for the ACK watermark to cover the published
 * frame sequence and resolves with that sequence. This is the documented
 * replacement for the per-frame ACK promise the session no longer offers.
 *
 * The target is read once the frame is published. A replay transport assigns
 * frame sequences as frames enter its queue, so the target is exactly this
 * frame. A fixed connection allocates sequences when publishFrame() is
 * called, so with several publications in flight the target is the latest of
 * them.
 */
export function publishAndWait(
  session: QwpIngressSession,
  frame: Uint8Array,
  timeoutMs?: number,
): Promise<bigint> {
  return session
    .publishFrame(frame)
    .then(() => waitForPublished(session, timeoutMs));
}

/**
 * Waits for the ACK watermark to cover everything published so far and
 * resolves with that frame sequence. A latched session failure rejects here
 * rather than throwing synchronously, as waitForAcknowledged() itself does,
 * and so does a wait that times out: a test expecting an ACK should fail
 * loudly rather than carry on with a sequence nothing acknowledged.
 */
export async function waitForPublished(
  session: QwpIngressSession,
  timeoutMs?: number,
): Promise<bigint> {
  const sequence = session.publishedFrameSequence;
  if (!(await session.waitForAcknowledged(sequence, timeoutMs))) {
    throw new Error(
      `the QWP ACK watermark did not reach frame ${sequence} in time`,
    );
  }
  return sequence;
}

/**
 * publishAndWait() for a batch of tables published with the session's
 * automatic delta symbol dictionary.
 */
export function publishTablesDeltaAndWait(
  session: QwpIngressSession,
  tables: readonly QwpTableBuffer[],
  timeoutMs?: number,
): Promise<bigint> {
  return session
    .publishTablesDelta(tables)
    .then(() => waitForPublished(session, timeoutMs));
}
