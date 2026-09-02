/**
 * Applies full jitter to an exponential-backoff ceiling. Full jitter keeps the
 * configured maximum a hard upper bound while spreading clients throughout
 * every retry window after a shared outage.
 */
export function jitterReconnectDelayMs(ceilingMs: number): number {
  if (ceilingMs <= 0) return 0;
  return Math.floor(Math.random() * ceilingMs);
}
