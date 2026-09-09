import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { qwpNonRetryable } from "../../../client-core/src/_qwp/_internal/websocket-connection";

/**
 * @internal Validates a Node WebSocket upgrade agent against its endpoint.
 *
 * `wss` is deliberately not shape-checked here. What matters is whether the
 * agent yields a socket for the endpoint's scheme, and `instanceof
 * https.Agent` answers a different question: a tunnelling agent -- the shape
 * `https-proxy-agent`, `socks-proxy-agent` and `proxy-agent` all build on --
 * extends `http.Agent` rather than `https.Agent` and still produces a TLS
 * connection to the origin. Testing the class therefore refused every
 * proxy-only deployment, while `ws` given that same agent completes the
 * upgrade.
 *
 * Node already applies the real check. `https.request` compares the agent's
 * own `protocol` with the URL's and raises `ERR_INVALID_PROTOCOL`, which
 * rejects a bare `http.Agent` on `wss` -- including a plain subclass -- while
 * admitting a tunnelling agent, whose `protocol` resolves against the caller.
 * `connectQwpNodeEndpoint` marks that error non-retryable, so a permanently
 * incompatible agent still fails fast instead of spinning the reconnect loop.
 *
 * The `ws` branch stays: an `https.Agent` there is a configuration mistake
 * worth naming in the client's own vocabulary, and rejecting it keeps a
 * non-agent value such as an `undici.Agent` from reaching `ws` at all.
 */
export function validateQwpWebSocketAgent(
  agent: unknown,
  secure: boolean,
): HttpAgent | undefined {
  if (agent === undefined) return undefined;
  if (secure) return agent as HttpAgent;
  if (agent instanceof HttpAgent && !(agent instanceof HttpsAgent)) {
    return agent;
  }
  throw qwpNonRetryable(
    new TypeError("QWP ws WebSocket agent must be a plain Node.js http.Agent"),
  );
}
