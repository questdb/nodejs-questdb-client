/**
 * Containment for user-supplied observability callbacks.
 *
 * Notification callbacks (reconnect events, sender errors, recovery reports)
 * run purely for their side effects and must never interfere with protocol
 * progress. A synchronous throw is easy to contain with try/catch, but an
 * `async` callback returns a promise: if it rejects, the rejection escapes the
 * surrounding try/catch and Node treats it as an unhandled rejection, which
 * terminates the host process by default (Node >= 15). This helper contains
 * both failure modes so a broken callback can never crash the client's host or
 * stall protocol work.
 */

/**
 * Invokes an observability callback without letting a synchronous throw or a
 * rejected promise (from an `async` callback) escape. On either failure the
 * optional {@link onFailure} handler runs; it is itself guarded so it can never
 * re-escape the containment it backs.
 */
export function safelyInvoke<T>(
  callback: ((event: T) => unknown) | undefined,
  event: T,
  onFailure?: (error: unknown) => void,
): void {
  if (!callback) return;
  try {
    const result = callback(event);
    if (isPromiseLike(result)) {
      void result.then(undefined, (error) => reportFailure(onFailure, error));
    }
  } catch (error) {
    reportFailure(onFailure, error);
  }
}

function reportFailure(
  onFailure: ((error: unknown) => void) | undefined,
  error: unknown,
): void {
  if (!onFailure) return;
  try {
    onFailure(error);
  } catch {
    // A failing fallback must not re-escape the containment it backs.
  }
}

/**
 * Minimal Promises/A+ thenable test. A genuine thenable only guarantees a
 * `then` method, so `then(undefined, onRejected)` — not `catch` — is the
 * portable way to attach a rejection handler.
 */
export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}
