/**
 * Upgrade failures the client decided on its own.
 *
 * A store-and-forward sender that has connected once retries every upgrade
 * rejection, so a credential can rotate or a capability can change on the
 * server under a running producer. That reasoning covers a server's answer,
 * not a verdict the client reached without one: an auth provider that declared
 * retrying pointless, a credential that could never be sent, or a server that
 * echoed the credential back. Retrying those asks the provider again, or sends
 * the credential to the server that exposed it, for as long as the sender
 * lives -- and since the loop never gives up, `onError` never hears of it.
 */
import { QwpFailoverError, QwpUpgradeError } from "../transport";

const finalVerdicts = new WeakSet<QwpUpgradeError>();

/** Marks a non-retryable upgrade failure as final under every retry policy. */
export function qwpFinalUpgradeVerdict<E extends QwpUpgradeError>(error: E): E {
  finalVerdicts.add(error);
  return error;
}

/** Whether `error`, or any attempt of a failover sweep, is a final verdict. */
export function hasQwpFinalUpgradeVerdict(error: unknown): boolean {
  if (error instanceof QwpFailoverError) {
    return error.attempts.some((attempt) =>
      hasQwpFinalUpgradeVerdict(attempt.error),
    );
  }
  return error instanceof QwpUpgradeError && finalVerdicts.has(error);
}

const unavailableCredentials = new WeakSet<QwpUpgradeError>();

/**
 * Marks an authentication failure as the client's own: the credential
 * provider could not produce a credential, so no server rejected anything.
 * Connection events report it as an attempt that failed, not as
 * `auth-failed`, which means the server refused the credentials.
 */
export function qwpCredentialUnavailable<E extends QwpUpgradeError>(
  error: E,
): E {
  unavailableCredentials.add(error);
  return error;
}

/** Whether `error` is a credential the provider could not produce. */
export function isQwpCredentialUnavailable(error: unknown): boolean {
  return error instanceof QwpUpgradeError && unavailableCredentials.has(error);
}
