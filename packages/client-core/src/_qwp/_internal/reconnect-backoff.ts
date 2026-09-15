import type { QwpReconnectOptions } from "../transport";
import { QWP_MAX_TIMER_DELAY_MS } from "./timer-bounds";

/**
 * Reconnect-flavoured spelling of the shared host timer ceiling. Both backoff
 * ceilings reach a raw `setTimeout`, so they carry the same bound as every
 * other timer-feeding option.
 */
export const QWP_MAX_RECONNECT_BACKOFF_MS = QWP_MAX_TIMER_DELAY_MS;

export function validateQwpReconnectBackoffs(
  reconnect: QwpReconnectOptions | false | undefined,
): void {
  if (!reconnect) return;
  for (const [name, value] of [
    ["initialBackoffMs", reconnect.initialBackoffMs],
    ["maxBackoffMs", reconnect.maxBackoffMs],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(
        `reconnect ${name} must be a non-negative finite number`,
      );
    }
    if (value > QWP_MAX_RECONNECT_BACKOFF_MS) {
      throw new RangeError(
        `reconnect ${name} must be no greater than ${QWP_MAX_RECONNECT_BACKOFF_MS}`,
      );
    }
  }
}

/**
 * Applies full jitter to an exponential-backoff ceiling. Full jitter keeps the
 * configured maximum a hard upper bound while spreading clients throughout
 * every retry window after a shared outage.
 */
export function jitterReconnectDelayMs(ceilingMs: number): number {
  if (ceilingMs <= 0) return 0;
  return Math.floor(Math.random() * ceilingMs);
}
