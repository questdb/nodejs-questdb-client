export enum HostState {
  HEALTHY = 0,
  UNKNOWN = 1,
  TRANSIENT_REJECT = 2,
  TRANSPORT_ERROR = 3,
  TOPOLOGY_REJECT = 4,
}

/**
 * State-ranked, round-based endpoint selection. The ingest sender is
 * zone-blind, so ranking is state-only (spec 1.2) — do not add zone tiers.
 */
export class HostTracker {
  private readonly states: HostState[];
  private attempted: boolean[];

  constructor(private readonly hostCount: number) {
    if (hostCount <= 0) throw new Error("hostCount must be > 0");
    this.states = new Array(hostCount).fill(HostState.UNKNOWN);
    this.attempted = new Array(hostCount).fill(false);
  }

  record(index: number, state: HostState): void {
    this.states[index] = state;
  }

  private best(attempted: boolean[]): number | null {
    let bestIdx: number | null = null;
    for (let i = 0; i < this.hostCount; i++) {
      if (attempted[i]) continue;
      if (bestIdx === null || this.states[i] < this.states[bestIdx]) bestIdx = i;
    }
    return bestIdx;
  }

  pickNext(): number | null {
    const i = this.best(this.attempted);
    if (i === null) return null;
    this.attempted[i] = true;
    return i;
  }

  isRoundExhausted(): boolean {
    return this.attempted.every(Boolean);
  }

  beginRound(): void {
    this.attempted = new Array(this.hostCount).fill(false);
  }

  /**
   * A walker-local cursor. Background drainers MUST use this: sharing the
   * round lets a drainer steal endpoints from the foreground sweep, which
   * presents as unexplained ALL_ENDPOINTS_UNREACHABLE (spec 1.2).
   */
  newCursor(): { pickNext(): number | null } {
    const local = new Array(this.hostCount).fill(false);
    return {
      pickNext: () => {
        const i = this.best(local);
        if (i === null) return null;
        local[i] = true;
        return i;
      },
    };
  }
}
