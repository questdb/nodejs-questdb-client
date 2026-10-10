import {
  QWP_RECONNECT_EVENT_KIND,
  QWP_UPGRADE_ERROR_KIND,
  QwpReconnectEvent,
  QwpReconnectExhaustedError,
  QwpUpgradeError,
} from "../transport";
import type {
  QwpBinaryConnection,
  QwpEndpointFailureObserver,
} from "./binary-connection";

/** Reports the failures of one connection sweep on the reconnect events. */
export interface SweepFailureReporter {
  /** Handed to the connection factory, which calls it as each endpoint fails. */
  readonly onEndpointFailure: QwpEndpointFailureObserver;
  /**
   * Reports a sweep that ended in `error`. `opened` is the connection the
   * factory returned when that endpoint failed after opening, before the
   * session could use it.
   */
  sweepFailed(error: unknown, opened: QwpBinaryConnection | undefined): void;
}

/**
 * Raises the events the Java, Rust, Go and Python clients raise for a sweep:
 * one per endpoint as it fails, then a single `all-endpoints-unreachable` once
 * none accepted the connection. An authentication rejection stops the sweep,
 * so it is reported as `auth-failed` instead of either.
 */
export function createSweepFailureReporter(
  emit: (event: Omit<QwpReconnectEvent, "timestampMs">) => void,
  attempt: number,
  previousEndpoint: string | URL | undefined,
  isClosing: () => boolean,
): SweepFailureReporter {
  let lastEndpoint: string | URL | undefined;
  let authenticationReported = false;
  return {
    onEndpointFailure: (endpoint, error) => {
      lastEndpoint = endpoint;
      if (isClosing()) return;
      const authentication = isAuthenticationFailure(error);
      if (authentication) authenticationReported = true;
      emit({
        kind: authentication
          ? QWP_RECONNECT_EVENT_KIND.AUTH_FAILED
          : QWP_RECONNECT_EVENT_KIND.ENDPOINT_ATTEMPT_FAILED,
        attempt,
        endpoint,
        previousEndpoint,
        cause: error,
      });
    },
    sweepFailed: (error, opened) => {
      // A close() is not an endpoint failure, and an expired deadline cut the
      // sweep short instead of finishing it. The caller is told of both.
      if (isClosing() || error instanceof QwpReconnectExhaustedError) return;
      if (opened) {
        // The sweep found an endpoint that accepted the connection, so the
        // failure is that endpoint's and not the whole endpoint set's.
        emit({
          kind: QWP_RECONNECT_EVENT_KIND.ENDPOINT_ATTEMPT_FAILED,
          attempt,
          endpoint: opened.endpoint,
          previousEndpoint,
          cause: error,
        });
        return;
      }
      if (isAuthenticationFailure(error)) {
        // A factory that walks endpoints has already reported it as it failed;
        // one that does not walk them reports nothing per endpoint.
        if (!authenticationReported) {
          emit({
            kind: QWP_RECONNECT_EVENT_KIND.AUTH_FAILED,
            attempt,
            endpoint: error.url ?? lastEndpoint,
            previousEndpoint,
            cause: error,
          });
        }
        return;
      }
      emit({
        kind: QWP_RECONNECT_EVENT_KIND.ALL_ENDPOINTS_UNREACHABLE,
        attempt,
        endpoint: lastEndpoint,
        previousEndpoint,
        cause: error,
      });
    },
  };
}

function isAuthenticationFailure(error: unknown): error is QwpUpgradeError {
  return (
    error instanceof QwpUpgradeError &&
    error.kind === QWP_UPGRADE_ERROR_KIND.AUTHENTICATION
  );
}
