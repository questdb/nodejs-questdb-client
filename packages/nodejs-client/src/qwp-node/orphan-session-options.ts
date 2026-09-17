import { safelyInvoke } from "../../../client-core/src/_qwp/_internal/safe-callback";
import type { QwpReconnectEvent } from "../../../client-core/src/_qwp/transport";
import type { QwpIngressSessionOptions } from "../../../client-core/src/_qwp/ingress-session";

/**
 * @internal Derives the session options an adopted orphan slot runs under.
 *
 * Not re-exported by the package root: it is reachable only through
 * `storeAndForward.drainOrphans`, and tests import it by path.
 */
export function orphanIngressSessionOptions(
  options: QwpIngressSessionOptions,
  onReconnectEvent?: (event: QwpReconnectEvent) => void,
): QwpIngressSessionOptions {
  const configuredReconnect =
    options.reconnect === false ? undefined : options.reconnect;
  const configuredOnEvent = configuredReconnect?.onEvent;
  return {
    ...options,
    // No foreground caller remains to retry orphan bytes, so transport
    // outages stay retryable for the drainer's lifetime. Authentication,
    // protocol, and poison-frame failures remain terminal and quarantined.
    reconnect: {
      ...configuredReconnect,
      maxAttempts: 0,
      maxDurationMs: 0,
      onEvent: (event) => {
        // This wrapper is the notification inbox's handler, and the inbox waits
        // on whatever the handler returns before it delivers the next event.
        // That return value is what makes "one notification at a time" cover an
        // `async` observer, so discarding it left the caller's own callback
        // serialized on a foreground session and re-entered on an orphan-drained
        // one -- behaviour depending on the transport rather than on their code.
        // The inbox bound never engaged here either, because a queue that is
        // drained on the same turn never reaches its capacity.
        //
        // Returning it is safe, and is what safelyInvoke() documents itself for:
        // it hands back an already-contained promise that never rejects, so
        // nothing can orphan through the very inbox meant to contain it.
        const observers = [
          safelyInvoke(configuredOnEvent, event),
          safelyInvoke(onReconnectEvent, event),
        ].filter((pending) => pending !== undefined);
        return observers.length > 0 ? Promise.all(observers) : undefined;
      },
    },
    replayStore: undefined,
    backgroundStoreAndForward: undefined,
    initialConnectMode: undefined,
    orphanStoreAndForward: true,
    orphanDurableAckMismatchMaxDurationMs:
      options.orphanDurableAckMismatchMaxDurationMs ??
      configuredReconnect?.maxDurationMs ??
      300_000,
    onResponse: undefined,
    onDurableAck: undefined,
    onProgress: undefined,
    onError: undefined,
  };
}
