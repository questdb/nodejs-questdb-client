import { redactQwpEndpoint } from "./redact-endpoint";

/** The QWP route each side of a pooled client connects to. */
export type QwpClusterRoute = "write/v4" | "read/v1";

const QWP_ROUTE_SUFFIX = /\/(?:write\/v4|read\/v1)\/?$/;

/**
 * Derives one side's endpoint from a pooled client's cluster URL.
 *
 * A cluster URL may be an origin, a reverse-proxy base path, or an existing
 * `/write/v4` or `/read/v1` endpoint, and its query parameters are preserved.
 * A relative URL resolves against `base`, which only a browser page has.
 */
export function qwpClusterEndpoint(
  endpoint: string | URL,
  route: QwpClusterRoute,
  label: string,
  base?: string,
): URL {
  let url: URL;
  try {
    url = endpoint instanceof URL ? new URL(endpoint) : new URL(endpoint, base);
  } catch {
    // Node's URL TypeError keeps the rejected input on an enumerable `input`
    // property, and a cluster URL may carry credentials, so the error is
    // replaced rather than rethrown.
    throw new TypeError(
      `${label} is not a valid URL: ${redactQwpEndpoint(endpoint)}`,
    );
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError(
      `${label} must use WS or WSS: ${redactQwpEndpoint(url)}`,
    );
  }
  if (url.hash) {
    throw new TypeError(
      `${label} cannot contain a fragment: ${redactQwpEndpoint(url)}`,
    );
  }
  url.pathname = QWP_ROUTE_SUFFIX.test(url.pathname)
    ? url.pathname.replace(QWP_ROUTE_SUFFIX, `/${route}`)
    : `${url.pathname.replace(/\/+$/, "")}/${route}`;
  return url;
}
