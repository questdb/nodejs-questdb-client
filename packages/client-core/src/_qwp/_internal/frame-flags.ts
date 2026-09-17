/**
 * Header-flag peeks shared by every replay store.
 *
 * A persisted frame is opaque bytes to the journal, but two header flags decide
 * whether it opens, continues or closes a server-side ingress transaction, and
 * a store that ignores them can deadlock: a deferred frame's ACK is withheld
 * until its commit arrives, so trimming can never free the capacity that commit
 * needs. The in-memory and file-backed stores therefore read the same flags the
 * same way, from one place, rather than each re-deriving the offset.
 */
import { QWP_FLAG_DEFER_COMMIT, QWP_FLAG_DURABLE_ACK_POLL } from "../_core";

/** Byte offset of the flags field inside the 12-byte QWP frame header. */
export const QWP_FLAGS_OFFSET = 5;

/** Peeks the deferred-commit flag without decoding or copying the payload. */
export function defersCommit(payload: Uint8Array): boolean {
  return (
    payload.byteLength > QWP_FLAGS_OFFSET &&
    (payload[QWP_FLAGS_OFFSET] & QWP_FLAG_DEFER_COMMIT) !== 0
  );
}

/** Durable-ACK polls do not change the server-side ingress transaction. */
export function isDurableAckPoll(payload: Uint8Array): boolean {
  return (
    payload.byteLength > QWP_FLAGS_OFFSET &&
    (payload[QWP_FLAGS_OFFSET] & QWP_FLAG_DURABLE_ACK_POLL) !== 0
  );
}
