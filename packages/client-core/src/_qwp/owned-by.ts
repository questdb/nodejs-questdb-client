// The `ownedBy` ingress option: the owner of the tables and columns a sender
// auto-creates. The shared reconnect policy reads the error class, so it lives
// here, but the shared barrel does not export it: only Node.js can read the
// upgrade response that confirms the owner, so only the Node package root
// re-exports it. A line comment, not a doc comment: declaration bundling would
// attach a doc comment here to the first declaration that follows it.
import { QWP_UPGRADE_ERROR_KIND, QwpUpgradeError } from "./transport";
import { sanitizeQwpDisplayText } from "./_internal/display-text";
import { redactQwpEndpoint } from "./_internal/redact-endpoint";

/** Lone surrogates, which have no UTF-8 encoding to send. */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * The server completed the `/write/v4` upgrade without confirming the
 * `ownedBy` owner the client named: it echoed no owner, as a server that
 * predates the option does, or another one. The tables and columns the
 * connection auto-created there would not get that owner, so the connection
 * fails instead of connecting.
 *
 * Like {@link QwpDurableAckUnavailableError}, it comes from a writable
 * endpoint that lacks a capability, which a rolling upgrade clears, and it is
 * handled the same way. It carries no HTTP status, since the server answered
 * 101, and the endpoint sweep goes on to the next endpoint. A blocking startup
 * fails with it, as does a reconnect without background replay. A
 * store-and-forward sender that has connected, or one started with
 * `initialConnectMode: "async"`, keeps retrying it, and an orphan drainer
 * retries it within the capability-gap budget a missing durable ACK also draws
 * on before it quarantines the slot.
 */
export class QwpOwnedByMismatchError extends QwpUpgradeError {
  /**
   * @param url the endpoint that answered 101 without confirming the owner
   * @param ownedBy the owner the client named
   * @param echo the `X-QWP-Owned-By` value the server returned, or undefined
   * when it sent none
   */
  constructor(
    url: string | URL,
    readonly ownedBy: string,
    echo: string | undefined,
  ) {
    // No `readonly url` parameter property, as in
    // QwpDurableAckUnavailableError: it would overwrite the base's redacted
    // value with the raw endpoint.
    super(
      `QWP server did not confirm owned_by, so it cannot set the owner of the tables and columns it auto-creates [url=${redactQwpEndpoint(url)}, owned_by=${sanitizeQwpDisplayText(ownedBy)}, echoed=${
        echo === undefined
          ? "<no X-QWP-Owned-By header>"
          : sanitizeQwpDisplayText(echo)
      }]`,
      {
        kind: QWP_UPGRADE_ERROR_KIND.CAPABILITY_MISMATCH,
        retryable: false,
        tryNextEndpoint: true,
        url,
      },
    );
    this.name = "QwpOwnedByMismatchError";
  }
}

/**
 * @internal Rejects an `ownedBy` value that names no owner, or that cannot be
 * sent, and returns it unchanged; undefined names no owner. `option` names the
 * spelling the caller used: `ownedBy`, or `owned_by` on a connect string.
 *
 * The name is sent as it is, untrimmed: the server looks it up verbatim.
 */
export function validateQwpOwnedBy(
  ownedBy: unknown,
  option = "ownedBy",
): string | undefined {
  if (ownedBy === undefined) return undefined;
  if (typeof ownedBy !== "string") {
    throw new TypeError(`${option} must be a string`);
  }
  if (!ownedBy.trim()) {
    throw new TypeError(`${option} must not be empty or blank`);
  }
  if (LONE_SURROGATE.test(ownedBy)) {
    // It has no UTF-8 encoding: a browser's URL would carry U+FFFD in its
    // place, and the server would look up an owner nobody named.
    throw new TypeError(`${option} must not contain a lone surrogate`);
  }
  return ownedBy;
}

/**
 * @internal Rejects an `ownedBy` owner that the `headers` escape hatch also
 * names, as an `X-QWP-Owned-By` entry in any letter case: depending on which
 * one won, the owner would go unconfirmed or never reach the wire. The same
 * rule as for `authorization` and an `Authorization` header. The header on its
 * own stays the caller's to send, unconfirmed.
 */
export function assertNoQwpOwnedByHeaderConflict(
  ownedBy: string | undefined,
  headers: Readonly<Record<string, string>> | undefined,
): void {
  if (ownedBy === undefined || !headers) return;
  if (
    Object.keys(headers).some((name) => name.toLowerCase() === "x-qwp-owned-by")
  ) {
    throw new Error(
      "an X-QWP-Owned-By header cannot be combined with the 'ownedBy' option; set exactly one of them",
    );
  }
}

/**
 * @internal The `X-QWP-Owned-By` encoding of a validated owner name: its UTF-8
 * bytes, with the RFC 3986 unreserved characters (`A`-`Z`, `a`-`z`, `0`-`9`,
 * `-`, `.`, `_` and `~`) as they are and every other byte as `%XX` with
 * upper-case hex digits.
 *
 * A name outside ASCII so survives proxies intact, and this is the canonical
 * form in which QuestDB echoes the owner it accepted, so the echo can be
 * compared with what was sent byte for byte. `+` stands for itself, not for a
 * space.
 */
export function encodeQwpOwnedBy(ownedBy: string): string {
  // encodeURIComponent() percent-encodes UTF-8 with upper-case hex digits, but
  // leaves five characters outside the unreserved set as they are, and the
  // server's echo encodes them.
  return encodeURIComponent(ownedBy).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
