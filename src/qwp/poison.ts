/**
 * Escalation requires a strike count AND a wall-clock dwell (spec 7.4).
 * A count alone false-positives a brief outage into a producer-fatal terminal,
 * because with pacing four strikes can accrue in well under a second.
 */
export class PoisonDetector {
  private suspectFsn = -1;
  private strikes = 0;
  private firstStrikeAt = 0;

  constructor(
    private readonly maxStrikes: number,
    private readonly minWindowMillis: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Returns true when the frame should escalate to PROTOCOL_VIOLATION. */
  strike(fsn: number): boolean {
    if (fsn !== this.suspectFsn) {
      this.suspectFsn = fsn;
      this.strikes = 0;
      this.firstStrikeAt = this.now();
    }
    this.strikes++;
    const dwell = this.now() - this.firstStrikeAt;
    return this.strikes >= this.maxStrikes && dwell >= this.minWindowMillis;
  }

  /** Only acceptance AT OR BEYOND the suspect clears it. */
  accept(ackedFsn: number): void {
    if (this.suspectFsn >= 0 && ackedFsn >= this.suspectFsn) {
      this.suspectFsn = -1;
      this.strikes = 0;
    }
  }
}
