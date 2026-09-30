/**
 * Browser-visible WebSocket subprotocol used to request and confirm durable
 * ingress acknowledgements. Browsers cannot set or inspect X-QWP-* headers.
 */
export const QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL = "questdb.qwp.durable-ack.v1";

/**
 * @internal Browser-visible QWP dialect. QuestDB selects it on both `/write/v4`
 * and `/read/v1` when a browser offers it, except that ingress selects durable
 * ACK instead when that was offered too.
 */
export const QWP_V1_WEBSOCKET_PROTOCOL = "questdb.qwp.v1";

/**
 * @internal Prefix of the subprotocol that carries a browser credential. The
 * rest of the token is the unpadded base64url encoding of an HTTP
 * `Authorization` value: `=`, `+`, and `/` are not HTTP token characters, and a
 * subprotocol must be a token.
 */
export const QWP_AUTHORIZATION_WEBSOCKET_PROTOCOL_PREFIX =
  "questdb.qwp.authorization.";

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

/** @internal True for a subprotocol token that carries a browser credential. */
export function isQwpAuthorizationWebSocketProtocol(
  protocol: string | undefined,
): boolean {
  return (
    protocol !== undefined &&
    protocol.startsWith(QWP_AUTHORIZATION_WEBSOCKET_PROTOCOL_PREFIX)
  );
}

/**
 * @internal Builds the subprotocol offer of a browser upgrade without mutating
 * the caller's list.
 *
 * Without a credential this is the offer browsers have always made: the
 * caller's protocols, plus durable ACK when requested. A credential cannot be
 * offered on its own. QuestDB accepts it only on an upgrade whose 101 response
 * will select a QWP dialect, and never selects the credential itself, so an
 * offer without one is refused -- and a browser fails every handshake whose
 * response selects none of its offers anyway. The dialect is durable ACK when
 * requested, which ingress selects in preference, and otherwise
 * `questdb.qwp.v1`, the only one egress selects.
 */
export function qwpBrowserWebSocketProtocols(
  protocols: string | readonly string[] | undefined,
  requestDurableAck: boolean,
  credentialProtocol?: string,
): string | string[] | undefined {
  if (credentialProtocol === undefined) {
    if (requestDurableAck) return addQwpDurableAckWebSocketProtocol(protocols);
    return typeof protocols === "object" ? [...protocols] : protocols;
  }
  const dialect = requestDurableAck
    ? QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL
    : QWP_V1_WEBSOCKET_PROTOCOL;
  const offer =
    protocols === undefined
      ? []
      : typeof protocols === "string"
        ? [protocols]
        : [...protocols];
  if (!offer.includes(dialect)) offer.push(dialect);
  offer.push(credentialProtocol);
  return offer;
}
