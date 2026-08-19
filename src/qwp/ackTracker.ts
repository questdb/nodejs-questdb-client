/**
 * Bridges the connection-scoped wire sequence to the log-scoped FSN.
 * Storing a raw seq as an FSN works until the first reconnect and then trims
 * from near the start of the log, discarding unacked data (spec 6.6.1).
 */
export class AckTracker {
  private fsnAtZero = 0;
  private nextWireSeq = 0;
  /** Number of wire frames at the head of this connection that are dictionary
   *  catch-up frames rather than ring frames. The server assigns these the
   *  lowest wire seqs, so a populated dictionary shifts every ring frame's seq
   *  up by this count (spec 6.6.1, handoff B1b). */
  private catchUpFrames = 0;
  private ackedFsn = -1;

  /** Call on every successful connect, with the FSN replay resumes at, and the
   *  number of dictionary catch-up frames that will precede the ring frames. */
  onConnected(replayStartFsn: number, catchUpFrames = 0): void {
    this.fsnAtZero = replayStartFsn;
    this.catchUpFrames = catchUpFrames;
    this.nextWireSeq = catchUpFrames;
  }

  /** One ws-> ring frame OR catch-up frame sent on the current connection. */
  onFrameSent(): void {
    this.nextWireSeq++;
  }

  /** Returns the new cumulative acked FSN, or null when the ACK is not applicable. */
  onAck(wireSeq: number): number | null {
    const fsn = this.fsnForAck(wireSeq);
    if (fsn === null) return null;
    if (fsn > this.ackedFsn) this.ackedFsn = fsn;
    return this.ackedFsn;
  }

  /**
   * Maps an OK's wire sequence to the exact ring FSN it names, with the same
   * catch-up exclusion and highest-sent clamp as {@link onAck}, but without
   * advancing cumulative state. Durable-ACK mode needs the exact FSN so it can
   * retain that frame until its table transactions are durable.
   */
  fsnForAck(wireSeq: number): number | null {
    // An ACK for a catch-up frame (lowest seqs) must never trim a ring frame.
    if (wireSeq < this.catchUpFrames) return null;
    const ringIndex = wireSeq - this.catchUpFrames;
    const highestRingIndex = this.nextWireSeq - 1 - this.catchUpFrames;
    if (highestRingIndex < 0) return null; // ACK before any ring send
    const capped = Math.max(0, Math.min(ringIndex, highestRingIndex));
    return this.fsnAtZero + capped;
  }

  /**
   * The FSN a given wire sequence refers to, for mapping a NACK's rejected
   * frame back to the log (spec 7.4 poison strikes). Unlike onAck this does not
   * clamp to the highest sent frame or advance ack state — a rejection names the
   * exact bytes it rejected.
   */
  fsnFor(wireSeq: number): number | null {
    if (wireSeq < this.catchUpFrames) return null;
    return this.fsnAtZero + (wireSeq - this.catchUpFrames);
  }

  get acked(): number {
    return this.ackedFsn;
  }
}
