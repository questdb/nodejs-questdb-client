/**
 * Browser-visible WebSocket subprotocol used to request and confirm durable
 * ingress acknowledgements. Browsers cannot set or inspect X-QWP-* headers.
 */
export const QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL = "questdb.qwp.durable-ack.v1";

/** Adds the durable-ACK capability token without mutating user options. */
export function addQwpDurableAckWebSocketProtocol(
  protocols: string | readonly string[] | undefined,
): string | string[] {
  if (protocols === undefined) return QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL;
  if (typeof protocols === "string") {
    return protocols === QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL
      ? protocols
      : [protocols, QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL];
  }
  return protocols.includes(QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL)
    ? [...protocols]
    : [...protocols, QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL];
}

/** True when the server selected the browser durable-ACK subprotocol. */
export function isQwpDurableAckWebSocketProtocol(
  protocol: string | undefined,
): boolean {
  return protocol === QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL;
}
