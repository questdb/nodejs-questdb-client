import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { qwpNonRetryable } from "../../../client-core/src/_qwp/_internal/websocket-connection";

/** @internal Validates a Node WebSocket upgrade agent against its endpoint. */
export function validateQwpWebSocketAgent(
  agent: unknown,
  secure: boolean,
): HttpAgent | undefined {
  if (agent === undefined) return undefined;
  if (secure) {
    if (agent instanceof HttpsAgent) return agent;
  } else if (agent instanceof HttpAgent && !(agent instanceof HttpsAgent)) {
    return agent;
  }
  const scheme = secure ? "wss" : "ws";
  const expected = secure
    ? "a Node.js https.Agent"
    : "a plain Node.js http.Agent";
  throw qwpNonRetryable(
    new TypeError(`QWP ${scheme} WebSocket agent must be ${expected}`),
  );
}
