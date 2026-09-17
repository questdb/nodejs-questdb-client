/**
 * Elapsed-time source for durations the protocol measures itself: reconnect
 * budgets, escalation dwell windows, and append deadlines.
 *
 * These are all "how long has this been going on", never "when did it happen",
 * so they must not move when the system clock does. An NTP correction, a VM or
 * container resume, or a manual clock change would otherwise satisfy a dwell
 * window nothing had actually waited out -- collapsing the guard that keeps a
 * transient burst of rejections from being escalated into a terminal verdict --
 * or expire a budget that had barely started.
 *
 * Wall-clock time is still the right source for anything compared against a
 * value that lives outside this process, such as a filesystem mtime, and for
 * the timestamps reported to applications.
 */
export function monotonicNowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
