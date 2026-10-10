/**
 * Strips userinfo from an endpoint before it reaches an error message, an
 * event, or a log line.
 *
 * A URL carrying userinfo carries a live credential: `ws` turns
 * `wss://user:pass@host/...` into an `Authorization: Basic` header. Endpoints
 * are interpolated into `QwpFailoverError`'s message and retained on
 * `QwpUpgradeError.url`, which is precisely what a caller's
 * connect-failure logging writes out. The Node entry point rejects userinfo
 * outright, as the connect-string parser already did; this is the second line
 * of defence for endpoints reaching the shared failover machinery from a
 * custom connection factory.
 */
export function redactQwpEndpoint(endpoint: string | URL): string {
  const text = typeof endpoint === "string" ? endpoint : endpoint.href;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    // A malformed absolute URL can still contain live userinfo (for example
    // `wss://user:password@`). URL parsing cannot safely distinguish that from
    // harmless text, so redact the whole authority-shaped value rather than
    // returning the credential verbatim.
    const scheme = /^([a-z][a-z\d+.-]*):\/\//i.exec(text)?.[1];
    return scheme && text.includes("@")
      ? `${scheme}://<redacted>@<invalid-url>`
      : redactLeadingUserinfo(text);
  }
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
    return url.href;
  }
  // An endpoint written without its `ws://` still parses, but with no
  // authority: `admin:quest@db:9000` reads as scheme `admin` and an opaque
  // path that carries the password, so URL parsing finds no userinfo to strip.
  return url.host === "" ? redactLeadingUserinfo(text) : text;
}

/**
 * Redacts what reads as userinfo at the front of an endpoint that has no
 * parsed authority: `user:pass@host` or `//user:pass@host`, up to the last
 * `@`, as an authority's userinfo would be delimited. Relative browser
 * endpoints, which start with a single `/`, carry none and remain useful in
 * diagnostics.
 */
function redactLeadingUserinfo(text: string): string {
  const protocolRelative = text.startsWith("//");
  if (text.startsWith("/") && !protocolRelative) return text;
  const at = text.lastIndexOf("@");
  if (at < 0) return text;
  return `${protocolRelative ? "//" : ""}<redacted>@${text.slice(at + 1)}`;
}

/**
 * Strips endpoint credentials from a notification event before it is handed to
 * a user callback.
 *
 * The endpoint fields on these events were passed through verbatim while
 * `QwpUpgradeError` and `QwpFailoverError` carrying the very same
 * string were redacted. The documented usage of an event sink is to log the
 * whole object, so a credential-bearing endpoint -- which the browser entry
 * point accepts, and which any custom connection factory can supply on either
 * runtime -- reached the console and whatever telemetry pipeline follows it,
 * on a channel with a different retention and access profile from the app's
 * own configuration.
 */
export function redactQwpEndpointFields<
  T extends { endpoint?: string | URL; previousEndpoint?: string | URL },
>(event: T): T {
  const endpoint =
    event.endpoint === undefined
      ? undefined
      : redactQwpEndpoint(event.endpoint);
  const previousEndpoint =
    event.previousEndpoint === undefined
      ? undefined
      : redactQwpEndpoint(event.previousEndpoint);
  if (
    endpoint === event.endpoint &&
    previousEndpoint === event.previousEndpoint
  ) {
    return event;
  }
  const redacted = { ...event };
  if (endpoint !== undefined) redacted.endpoint = endpoint;
  if (previousEndpoint !== undefined)
    redacted.previousEndpoint = previousEndpoint;
  return redacted;
}
