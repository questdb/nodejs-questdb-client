import { QwpReconnectExhaustedError } from "../transport";
import { monotonicNowMs } from "./monotonic-clock";

const MAX_TIMER_DELAY_MS = 0x7fffffff;

/** Runs one reconnect operation inside the outage-wide deadline. */
export async function awaitReconnectDeadline<T>(
  operation: Promise<T>,
  deadlineMs: number | undefined,
  attempts: number,
  onTimeout: () => void,
  onLateValue?: (value: T) => void,
): Promise<T> {
  if (deadlineMs === undefined) return operation;

  let timedOut = false;
  const observeLateValue = (): void => {
    void operation.then(
      (value) => {
        if (!timedOut) return;
        try {
          onLateValue?.(value);
        } catch {
          // This value has already been disowned; cleanup is best-effort.
        }
      },
      () => undefined,
    );
  };
  const exhausted = (): QwpReconnectExhaustedError =>
    new QwpReconnectExhaustedError(
      attempts,
      new Error("QWP reconnect deadline elapsed"),
    );
  // The caller derives deadlineMs from the monotonic clock, so this must
  // read the same one or the two time bases are incomparable.
  const remainingMs = deadlineMs - monotonicNowMs();
  if (remainingMs <= 0) {
    timedOut = true;
    observeLateValue();
    try {
      onTimeout();
    } catch {
      // Preserve the reconnect-exhaustion result if cleanup races.
    }
    throw exhausted();
  }

  observeLateValue();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    const schedule = (): void => {
      const delayMs = deadlineMs - monotonicNowMs();
      if (delayMs > 0) {
        timer = setTimeout(schedule, Math.min(delayMs, MAX_TIMER_DELAY_MS));
        return;
      }
      timedOut = true;
      // Settle the deadline first. Cleanup can synchronously settle the
      // operation (an AbortSignal listener commonly does), and letting that
      // reaction win would turn an expired budget into one more retry.
      reject(exhausted());
      try {
        onTimeout();
      } catch {
        // Preserve the reconnect-exhaustion result if cleanup races.
      }
    };
    timer = setTimeout(schedule, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
