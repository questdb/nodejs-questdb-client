/**
 * Bridges the connection-scoped wire sequence to the log-scoped FSN.
 * Storing a raw seq as an FSN works until the first reconnect and then trims
 * from near the start of the log, discarding unacked data (spec 6.6.1).
 */
export class AckTracker {
  private fsnAtZero = 0;
  private nextWireSeq = 0;
  private ackedFsn = -1;

  /** Call on every successful connect, with the FSN replay resumes at. */
  onConnected(replayStartFsn: number): void {
    this.fsnAtZero = replayStartFsn;
    this.nextWireSeq = 0;
  }

  onFrameSent(): void {
    this.nextWireSeq++;
  }

  /** Returns the new acked FSN, or null when the ACK is not applicable. */
  onAck(wireSeq: number): number | null {
    const highestSent = this.nextWireSeq - 1;
    if (highestSent < 0) return null; // ACK before any send
    const capped = Math.max(0, Math.min(wireSeq, highestSent));
    const fsn = this.fsnAtZero + capped;
    if (fsn > this.ackedFsn) this.ackedFsn = fsn;
    return this.ackedFsn;
  }

  get acked(): number {
    return this.ackedFsn;
  }
}
