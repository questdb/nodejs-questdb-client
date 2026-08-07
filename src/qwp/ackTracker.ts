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

  /** Returns the new acked FSN, or null when the ACK is not applicable. */
  onAck(wireSeq: number): number | null {
    // An ACK for a catch-up frame (lowest seqs) must never trim a ring frame.
    if (wireSeq < this.catchUpFrames) return null;
    const ringIndex = wireSeq - this.catchUpFrames;
    const highestRingIndex = this.nextWireSeq - 1 - this.catchUpFrames;
    if (highestRingIndex < 0) return null; // ACK before any ring send
    const capped = Math.max(0, Math.min(ringIndex, highestRingIndex));
    const fsn = this.fsnAtZero + capped;
    if (fsn > this.ackedFsn) this.ackedFsn = fsn;
    return this.ackedFsn;
  }

  get acked(): number {
    return this.ackedFsn;
  }
}
