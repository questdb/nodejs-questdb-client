import {
  QWP_RECONNECT_EVENT_KIND,
  QWP_UPGRADE_ERROR_KIND,
  QwpReconnectEvent,
  QwpReconnectEventKind,
  QwpReconnectExhaustedError,
  QwpUpgradeError,
} from "../transport";
import type {
  QwpBinaryConnection,
  QwpEndpointFailureObserver,
} from "./binary-connection";
import { isQwpCredentialUnavailable } from "./upgrade-verdict";

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
 * none accepted the connection.
 *
 * A credential failure stops the sweep, because the credential is the same for
 * every endpoint, so neither event follows it. A server rejecting the
 * credentials is reported as `auth-failed`. A credential the client could not
 * produce -- a browser `auth` provider that threw or returned an invalid one --
 * is reported as `endpoint-attempt-failed` instead: no server refused it. Any
 * other verdict that stops the sweep at the endpoint that returned it, such as
 * a server echoing the browser credential, is that endpoint's failure alone:
 * the endpoints after it were never tried, so none of them is unreachable.
 */
export function createSweepFailureReporter(
  emit: (event: Omit<QwpReconnectEvent, "timestampMs">) => void,
  attempt: number,
  previousEndpoint: string | URL | undefined,
  isClosing: () => boolean,
): SweepFailureReporter {
  let lastEndpoint: string | URL | undefined;
  // The failure that stopped the sweep, once reported for its endpoint.
  let reportedStop: unknown;
  return {
    onEndpointFailure: (endpoint, error) => {
      lastEndpoint = endpoint;
      if (isClosing()) return;
      if (stopsSweep(error)) reportedStop = error;
      emit({
        kind: endpointFailureKind(error),
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
      if (stopsSweep(error)) {
        // A factory that walks endpoints has already reported it as it failed;
        // one that does not walk them reports nothing per endpoint.
        if (reportedStop !== error) {
          emit({
            kind: endpointFailureKind(error),
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

/**
 * A failure that ends the sweep at the endpoint that returned it: a credential
 * failure, which every endpoint would repeat, or an upgrade verdict that tells
 * the sweep not to try the next endpoint.
 */
function stopsSweep(error: unknown): error is QwpUpgradeError {
  return (
    isCredentialFailure(error) ||
    (error instanceof QwpUpgradeError && error.tryNextEndpoint === false)
  );
}

/** A credential failure: the server refused it, or none could be produced. */
function isCredentialFailure(error: unknown): error is QwpUpgradeError {
  return (
    error instanceof QwpUpgradeError &&
    error.kind === QWP_UPGRADE_ERROR_KIND.AUTHENTICATION
  );
}

function endpointFailureKind(error: unknown): QwpReconnectEventKind {
  return isCredentialFailure(error) && !isQwpCredentialUnavailable(error)
    ? QWP_RECONNECT_EVENT_KIND.AUTH_FAILED
    : QWP_RECONNECT_EVENT_KIND.ENDPOINT_ATTEMPT_FAILED;
}
