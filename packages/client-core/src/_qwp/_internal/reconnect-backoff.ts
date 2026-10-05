import type {
  QwpEgressReconnectOptions,
  QwpIngressReconnectOptions,
} from "../transport";
import { QWP_MAX_TIMER_DELAY_MS } from "./timer-bounds";

/**
 * Reconnect-flavoured spelling of the shared host timer ceiling. Both backoff
 * ceilings reach a raw `setTimeout`, so they carry the same bound as every
 * other timer-feeding option.
 */
export const QWP_MAX_RECONNECT_BACKOFF_MS = QWP_MAX_TIMER_DELAY_MS;

/** Validates the backoff ceilings of an ingress `reconnect` option. */
export function validateQwpIngressReconnectBackoffs(
  reconnect: QwpIngressReconnectOptions | false | undefined,
): void {
  if (!reconnect) return;
  validateReconnectBackoffs([
    ["reconnectInitialBackoffMs", reconnect.reconnectInitialBackoffMs],
    ["reconnectMaxBackoffMs", reconnect.reconnectMaxBackoffMs],
  ]);
}

/** Validates the backoff ceilings of an egress `reconnect` option. */
export function validateQwpEgressReconnectBackoffs(
  reconnect: QwpEgressReconnectOptions | false | undefined,
): void {
  if (!reconnect) return;
  validateReconnectBackoffs([
    ["failoverBackoffInitialMs", reconnect.failoverBackoffInitialMs],
    ["failoverBackoffMaxMs", reconnect.failoverBackoffMaxMs],
  ]);
}

/** Ingress and egress spell their backoff options differently. */
function validateReconnectBackoffs(
  backoffs: readonly (readonly [name: string, value: number | undefined])[],
): void {
  for (const [name, value] of backoffs) {
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
