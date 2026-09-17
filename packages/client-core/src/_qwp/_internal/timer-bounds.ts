/**
 * Largest delay Node and browser hosts schedule without clamping. Above this a
 * raw `setTimeout`/`setInterval` fires after ~1ms instead, so an over-large
 * option does not merely fail to take effect -- it inverts, and the longest
 * budget a caller can ask for becomes the shortest one they can get.
 *
 * Options that are only compared against an elapsed clock, or that re-clamp
 * inside a rescheduling loop (`reconnect-deadline.ts`), are exempt by
 * construction and must keep accepting any safe integer. QWP.md lists them.
 */
export const QWP_MAX_TIMER_DELAY_MS = 0x7fffffff;

/**
 * Upper-bound half of a millisecond-option check. Each caller keeps its own
 * lower bound and its own message, so `0`-permitting, positive-only and
 * safe-integer spellings stay distinguishable in the error text.
 */
export function exceedsQwpTimerCeiling(value: number): boolean {
  return value > QWP_MAX_TIMER_DELAY_MS;
}
