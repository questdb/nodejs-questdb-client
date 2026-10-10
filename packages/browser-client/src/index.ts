/**
 * Browser WebSocket adapter and browser-safe QWP protocol/session APIs.
 * @packageDocumentation
 */
export * from "../../client-core/src/qwp";

import {
  openQwpWebSocket,
  qwpNonRetryable,
  QwpWebSocketLike,
  validateQwpWebSocketTimeouts,
} from "../../client-core/src/_qwp/_internal/websocket-connection";
import {
  assertUniformQwpEndpointScheme,
  createQwpFailoverConnectionFactory,
} from "../../client-core/src/_qwp/_internal/failover";
import { createQwpEgressFailoverConnectionFactory } from "../../client-core/src/_qwp/_internal/egress-routing";
import { validateQwpMaxBatchRows } from "../../client-core/src/_qwp/_internal/egress-limits";
import {
  exceedsQwpTimerCeiling,
  QWP_MAX_TIMER_DELAY_MS,
} from "../../client-core/src/_qwp/_internal/timer-bounds";
import {
  decodeQwpIngressServerInfo,
  encodeQwpAcceptEncoding,
  isQwpDurableAckWebSocketProtocol,
  QwpEgressCompression,
  QWP_VERSION,
} from "../../client-core/src/_qwp/_core";
import {
  isQwpAuthorizationWebSocketProtocol,
  QWP_AUTHORIZATION_WEBSOCKET_PROTOCOL_PREFIX,
  qwpBrowserWebSocketProtocols,
} from "../../client-core/src/_qwp/_core/durable-ack";
import {
  QwpBinaryConnection,
  QwpConnectionFactory,
  QwpDurableAckUnavailableError,
  QwpEgressRoutingOptions,
  QwpSendClosedError,
  QWP_UPGRADE_ERROR_KIND,
  QwpUpgradeError,
  QwpWebSocketConnectOptions,
} from "../../client-core/src/_qwp/transport";
import {
  QWP_DEFAULT_EGRESS_SERVER_INFO_TIMEOUT_MS,
  QwpEgressSession,
  QwpEgressSessionOptions,
} from "../../client-core/src/_qwp/egress-session";
import {
  QwpIngressSession,
  QwpIngressSessionOptions,
} from "../../client-core/src/_qwp/ingress-session";
import { QwpSender, QwpSenderOptions } from "../../client-core/src/_qwp/sender";
import {
  QwpClient,
  QwpClientPoolOptions,
} from "../../client-core/src/_qwp/client";

export type { QwpWebSocketLike } from "../../client-core/src/_qwp/_internal/websocket-connection";

/**
 * A browser credential: HTTP Basic, or a QuestDB REST token or OIDC access
 * token sent as a Bearer token. `sessionBootstrap` exchanges it over REST for
 * QuestDB's HttpOnly session cookies; `auth` sends it with every QWP WebSocket
 * upgrade instead.
 */
export type QwpBrowserSessionAuthentication =
  | {
      /** HTTP Basic authentication. */
      type: "basic";
      username: string;
      password: string;
    }
  | {
      /** QuestDB REST token or OIDC access token. */
      type: "bearer";
      token: string;
    };

/** Describes the connection attempt a {@link QwpBrowserAuthProvider} serves. */
export interface QwpBrowserAuthContext {
  /**
   * Aborted when the attempt is abandoned, because its `connectTimeoutMs`
   * deadline expired or its session closed. Pass it to a token refresh so the
   * refresh is cancelled together with the attempt.
   */
  readonly signal: AbortSignal;
}

/**
 * Supplies the credential for one QWP WebSocket connection attempt.
 *
 * The client calls it before every initial connect, reconnect, and failover
 * attempt, and keeps nothing it returns. A provider that returns the current
 * OIDC access token, refreshing it when it is about to expire, therefore keeps
 * a long-lived sender or query session authenticated across token expiry.
 * Time spent here counts against `connectTimeoutMs`.
 *
 * A provider that throws fails the attempt with a {@link QwpUpgradeError} of
 * kind `authentication` whose `cause` is the thrown value, without trying the
 * remaining endpoints. Reconnects retry it with backoff unless the thrown value
 * carries `retryable: false`.
 */
export type QwpBrowserAuthProvider = (
  context: QwpBrowserAuthContext,
) =>
  | QwpBrowserSessionAuthentication
  | PromiseLike<QwpBrowserSessionAuthentication>;

export type QwpBrowserFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface QwpBrowserSessionBootstrapOptions {
  /** Exact QuestDB `/exec` HTTP(S) URL used to create the session cookie. */
  url: string | URL;
  authentication: QwpBrowserSessionAuthentication;
  /** Optional Enterprise service account to assume for subsequent QWP use. */
  serviceAccount?: string;
  /** Cancels only the REST bootstrap request. */
  signal?: AbortSignal;
  /** Test or framework hook; defaults to the browser's global fetch. */
  fetch?: QwpBrowserFetch;
}

export interface QwpBrowserSessionBootstrapResult {
  readonly url: string;
  readonly status: number;
  readonly serviceAccount?: string;
}

export type QwpBrowserSessionBootstrapConfig = Omit<
  QwpBrowserSessionBootstrapOptions,
  "url"
> & {
  /** Defaults to `/exec` on the current QWP endpoint's HTTP origin. */
  url?: string | URL;
};

/** An HTTP rejection while creating a browser `qdb_session` cookie. */
export class QwpBrowserSessionBootstrapError extends QwpUpgradeError {
  constructor(
    readonly responseBody: string,
    url: string | URL,
    statusCode: number,
    statusMessage: string,
  ) {
    const authenticationFailure = statusCode === 401 || statusCode === 403;
    const suffix = statusMessage ? ` ${statusMessage}` : "";
    const detail = responseBody ? `: ${responseBody}` : "";
    super(
      `QWP browser session bootstrap rejected with HTTP ${statusCode}${suffix}${detail}`,
      {
        kind: authenticationFailure
          ? QWP_UPGRADE_ERROR_KIND.AUTHENTICATION
          : QWP_UPGRADE_ERROR_KIND.HTTP_REJECTED,
        retryable:
          !authenticationFailure && (statusCode === 429 || statusCode >= 500),
        tryNextEndpoint: !authenticationFailure,
        url,
        statusCode,
        statusMessage,
      },
    );
    this.name = "QwpBrowserSessionBootstrapError";
  }
}

const QWP_BROWSER_BOOTSTRAP_ERROR_BODY_LIMIT = 1_024;

async function readBoundedBootstrapErrorBody(
  response: Response,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const bytes = new Uint8Array(QWP_BROWSER_BOOTSTRAP_ERROR_BODY_LIMIT);
  let length = 0;
  try {
    while (length < bytes.byteLength) {
      const { done, value } = await reader.read();
      if (done) break;
      const copied = Math.min(value.byteLength, bytes.byteLength - length);
      bytes.set(value.subarray(0, copied), length);
      length += copied;
      if (length === bytes.byteLength) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(bytes.subarray(0, length));
}

/**
 * Validates a credential. `label` prefixes errors about one of its fields and
 * `subject` names the whole credential; no error quotes the credential itself.
 */
function validateAuthentication(
  authentication: QwpBrowserSessionAuthentication,
  label = "browser session",
  subject = "browser session authentication",
): void {
  if (typeof authentication !== "object" || authentication === null) {
    throw new TypeError(
      `${subject} must be a { type: "basic" } or { type: "bearer" } object`,
    );
  }
  if (authentication.type === "basic") {
    if (!authentication.username) {
      throw new TypeError(`${label} username cannot be empty`);
    }
    if (authentication.username.includes(":")) {
      throw new TypeError(`${label} username cannot contain ':'`);
    }
    if (/\r|\n/.test(authentication.username + authentication.password)) {
      throw new TypeError(`${label} credentials cannot contain CR or LF`);
    }
    return;
  }
  if (authentication.type === "bearer") {
    if (!authentication.token) {
      throw new TypeError(`${label} bearer token cannot be empty`);
    }
    if (/\r|\n/.test(authentication.token)) {
      throw new TypeError(`${label} bearer token cannot contain CR or LF`);
    }
    return;
  }
  throw new TypeError(
    `unsupported ${subject} type '${String((authentication as { type?: unknown }).type)}'`,
  );
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encodeBase64(
  bytes: Uint8Array,
  alphabet: string,
  padding: string,
): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second: number | undefined = bytes[index + 1];
    const third: number | undefined = bytes[index + 2];
    result += alphabet[first >>> 2];
    result += alphabet[((first & 0x03) << 4) | ((second ?? 0) >>> 4)];
    result +=
      second === undefined
        ? padding
        : alphabet[((second & 0x0f) << 2) | ((third ?? 0) >>> 6)];
    result += third === undefined ? padding : alphabet[third & 0x3f];
  }
  return result;
}

/** Standard padded base64, the encoding HTTP Basic credentials use. */
function encodeBase64Utf8(value: string): string {
  return encodeBase64(new TextEncoder().encode(value), BASE64_ALPHABET, "=");
}

/**
 * Unpadded base64url. Standard base64 emits `+`, `/`, and `=`, none of which
 * may appear in a WebSocket subprotocol, so a browser refuses to offer a
 * credential encoded that way and QuestDB refuses to decode one.
 */
function encodeBase64UrlUtf8(value: string): string {
  return encodeBase64(new TextEncoder().encode(value), BASE64URL_ALPHABET, "");
}

function authorizationHeader(
  authentication: QwpBrowserSessionAuthentication,
  label?: string,
  subject?: string,
): string {
  validateAuthentication(authentication, label, subject);
  return authentication.type === "basic"
    ? `Basic ${encodeBase64Utf8(`${authentication.username}:${authentication.password}`)}`
    : `Bearer ${authentication.token}`;
}

const QWP_BROWSER_AUTH_LABEL = "browser auth";

/**
 * The subprotocol that carries `authentication` through a WebSocket upgrade:
 * its HTTP `Authorization` value, base64url-encoded without padding.
 *
 * QuestDB decodes that value only when it is printable ASCII that neither
 * starts nor ends with a space. A Basic value always is, because the username
 * and password travel inside its own base64. A bearer token is spliced in
 * verbatim, so one with a space, a control character, or a non-ASCII
 * character is refused here, where the error can say why, rather than sent
 * to a 401 the browser never shows.
 */
function browserCredentialProtocol(
  authentication: QwpBrowserSessionAuthentication,
): string {
  const authorization = authorizationHeader(
    authentication,
    QWP_BROWSER_AUTH_LABEL,
    `${QWP_BROWSER_AUTH_LABEL} credential`,
  );
  if (
    authentication.type === "bearer" &&
    !/^[\x21-\x7e]+$/.test(authentication.token)
  ) {
    throw new TypeError(
      `${QWP_BROWSER_AUTH_LABEL} bearer token must contain only visible ASCII characters`,
    );
  }
  return (
    QWP_AUTHORIZATION_WEBSOCKET_PROTOCOL_PREFIX +
    encodeBase64UrlUtf8(authorization)
  );
}

function protocolList(
  protocols: string | readonly string[] | undefined,
): readonly string[] {
  if (protocols === undefined) return [];
  return typeof protocols === "string" ? [protocols] : protocols;
}

/**
 * Rejects an `auth` configuration that could never authenticate.
 *
 * Runs when a public entry point accepts the options, so the mistake surfaces
 * there, and again before every connection attempt, where it is marked
 * non-retryable: no retry can fix an option.
 */
function validateBrowserAuthOptions(options: {
  auth?: QwpBrowserSessionAuthentication | QwpBrowserAuthProvider;
  sessionBootstrap?: QwpBrowserSessionBootstrapConfig;
  protocols?: string | readonly string[];
}): void {
  const { auth } = options;
  if (auth === undefined) return;
  // One or the other decides how the upgrade authenticates. QuestDB ignores
  // the session cookie on an upgrade that offers a credential, so a bootstrap
  // alongside `auth` would only issue cookies nothing uses.
  if (options.sessionBootstrap) {
    throw new TypeError(
      "auth cannot be combined with sessionBootstrap; configure exactly one of them",
    );
  }
  if (typeof auth !== "function") browserCredentialProtocol(auth);
  // A second credential makes QuestDB refuse the whole offer.
  if (
    protocolList(options.protocols).some(isQwpAuthorizationWebSocketProtocol)
  ) {
    throw new TypeError(
      `protocols cannot contain a ${QWP_AUTHORIZATION_WEBSOCKET_PROTOCOL_PREFIX}* credential when auth is set`,
    );
  }
}

/** Resolves `auth` for one connection attempt into its credential subprotocol. */
async function resolveBrowserCredentialProtocol(
  auth: QwpBrowserSessionAuthentication | QwpBrowserAuthProvider,
  endpoint: string | URL,
  signal: AbortSignal,
): Promise<string> {
  if (typeof auth !== "function") return browserCredentialProtocol(auth);
  let authentication: QwpBrowserSessionAuthentication;
  try {
    authentication = await auth({ signal });
  } catch (error) {
    // The credential does not depend on the endpoint, so the next one would
    // fail the same way: stop the sweep and leave the retry to reconnect
    // backoff. A provider that knows retrying cannot help says so the way the
    // rest of the client does, with `retryable: false`.
    throw new QwpUpgradeError("QWP browser auth provider failed", {
      kind: QWP_UPGRADE_ERROR_KIND.AUTHENTICATION,
      retryable:
        (error as { retryable?: unknown } | null | undefined)?.retryable !==
        false,
      tryNextEndpoint: false,
      url: endpoint,
      cause: error,
    });
  }
  try {
    return browserCredentialProtocol(authentication);
  } catch (error) {
    throw new QwpUpgradeError(
      `QWP browser auth provider returned an invalid credential: ${(error as Error).message}`,
      {
        kind: QWP_UPGRADE_ERROR_KIND.AUTHENTICATION,
        retryable: false,
        tryNextEndpoint: false,
        url: endpoint,
        cause: error,
      },
    );
  }
}

/**
 * A server that selects the credential subprotocol has copied the secret into
 * its 101 response, where proxies and response logging can record it. QuestDB
 * never does: it selects `questdb.qwp.v1` or durable ACK. This is therefore a
 * server defect, not a negotiation outcome, and since every node of a cluster
 * normally runs the same build, walking the endpoint list or retrying would
 * only repeat the exposure.
 */
function credentialEchoError(endpoint: string | URL): QwpUpgradeError {
  return new QwpUpgradeError(
    "QWP server selected the browser credential as its WebSocket subprotocol, echoing the credential in its upgrade response; this is a server defect",
    {
      kind: QWP_UPGRADE_ERROR_KIND.CAPABILITY_MISMATCH,
      retryable: false,
      tryNextEndpoint: false,
      url: endpoint,
    },
  );
}

/**
 * The endpoint as text with any userinfo removed, for an error message.
 *
 * A URL carrying userinfo carries a live credential, and these validation
 * errors are thrown on caller-supplied endpoints. Returns a copy, so the URL
 * the caller goes on to use is left alone.
 */
function redactedUrlText(url: URL): string {
  if (!url.username && !url.password) return url.href;
  const safe = new URL(url.href);
  safe.username = "";
  safe.password = "";
  return safe.href;
}

function resolveHttpUrl(value: string | URL): URL {
  const base = globalThis.location?.href;
  const url = value instanceof URL ? new URL(value) : new URL(value, base);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(
      `browser session bootstrap URL must use HTTP or HTTPS: ${redactedUrlText(url)}`,
    );
  }
  return url;
}

function serviceAccountSql(serviceAccount: string | undefined): string {
  if (serviceAccount === undefined) return "select 1";
  if (!serviceAccount.trim()) {
    throw new TypeError("browser session serviceAccount cannot be empty");
  }
  return `assume service account '${serviceAccount.replace(/'/g, "''")}'`;
}

const QWP_BROWSER_HANDSHAKE_PARAM = "qwp_browser_handshake";
const QWP_ACCEPT_ENCODING_PARAM = "qwp_accept_encoding";
const QWP_MAX_BATCH_ROWS_PARAM = "qwp_max_batch_rows";
const QWP_NEGOTIATION_PARAMS = [
  QWP_BROWSER_HANDSHAKE_PARAM,
  QWP_ACCEPT_ENCODING_PARAM,
  QWP_MAX_BATCH_ROWS_PARAM,
] as const;

function defaultBootstrapUrl(endpoint: string | URL): URL {
  const base = globalThis.location?.href;
  const url =
    endpoint instanceof URL ? new URL(endpoint) : new URL(endpoint, base);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(
      `QWP browser URL must use WS or WSS: ${redactedUrlText(url)}`,
    );
  }
  // Relative WebSocket endpoints resolve against an HTTP(S) page before the
  // browser upgrades their scheme. They are already in the protocol needed by
  // the inferred REST bootstrap and must not be rejected as non-WebSocket.
  const suffix = /\/(?:write\/v4|read\/v1)\/?$/;
  url.pathname = suffix.test(url.pathname)
    ? url.pathname.replace(suffix, "/exec")
    : "/exec";
  for (const parameter of QWP_NEGOTIATION_PARAMS) {
    url.searchParams.delete(parameter);
  }
  url.hash = "";
  return url;
}

/**
 * Authenticates over REST and asks QuestDB to issue the HttpOnly cookies a
 * browser needs before opening QWP WebSockets. REST and OIDC tokens both use
 * Bearer authentication. When `serviceAccount` is present the same request
 * also creates Enterprise's `qdbServiceAccount` impersonation cookie.
 */
export async function bootstrapQwpBrowserSession(
  options: QwpBrowserSessionBootstrapOptions,
): Promise<QwpBrowserSessionBootstrapResult> {
  const requestUrl = resolveHttpUrl(options.url);
  requestUrl.searchParams.set(
    "query",
    serviceAccountSql(options.serviceAccount),
  );
  requestUrl.searchParams.set("session", "true");
  requestUrl.hash = "";
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) {
    throw new Error("fetch is not available in this browser runtime");
  }
  const response = await fetcher(requestUrl, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "application/json",
      Authorization: authorizationHeader(options.authentication),
      "Cache-Control": "no-store",
    },
    signal: options.signal,
  });
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return {
      url: requestUrl.toString(),
      status: response.status,
      serviceAccount: options.serviceAccount,
    };
  }
  let responseBody = "";
  try {
    responseBody = await readBoundedBootstrapErrorBody(response);
  } catch (error) {
    responseBody = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, QWP_BROWSER_BOOTSTRAP_ERROR_BODY_LIMIT);
  }
  throw new QwpBrowserSessionBootstrapError(
    responseBody,
    requestUrl,
    response.status,
    response.statusText,
  );
}

export interface QwpBrowserWebSocketOptions extends QwpWebSocketConnectOptions {
  /**
   * Requests durable ingress ACKs through browser-visible WebSocket
   * subprotocol negotiation.
   */
  requestDurableAck?: boolean;
  /**
   * Time allowed for the optional ingress SERVER_INFO message. Defaults to
   * 250ms; zero disables the initial wait while retaining late negotiation.
   * Capped at 2,147,483,647ms (the host timer ceiling); a larger value throws
   * a `RangeError`.
   */
  ingressNegotiationTimeoutMs?: number;
  /**
   * Authenticates over REST before every WebSocket connection attempt so the
   * browser can attach QuestDB's HttpOnly session cookies to the upgrade.
   * Cannot be combined with `auth`.
   */
  sessionBootstrap?: QwpBrowserSessionBootstrapConfig;
  /**
   * Authenticates every WebSocket upgrade with a credential carried in its
   * subprotocol offer instead of a session cookie. This is how a web
   * application served from another origin, which QuestDB lists in
   * `qwp.browser.allowed.origins`, connects. Pass a fixed credential, or a
   * {@link QwpBrowserAuthProvider} the client calls before every connect,
   * reconnect, and failover attempt, for example to supply a refreshed OIDC
   * access token.
   *
   * QuestDB accepts the credential only from a listed origin: a page served
   * from QuestDB's own origin must be listed too, or keep using
   * `sessionBootstrap`. It creates no session for the credential and ignores
   * cookies on the upgrade. Use `wss:`: the credential travels in the opening
   * HTTP request. Cannot be combined with `sessionBootstrap`.
   */
  auth?: QwpBrowserSessionAuthentication | QwpBrowserAuthProvider;
  /** Test or framework hook; defaults to the browser's global WebSocket. */
  webSocketFactory?: (
    url: string | URL,
    protocols?: string | string[],
  ) => QwpWebSocketLike;
}

/** Browser WebSocket options plus protocol-level egress topology routing. */
export interface QwpBrowserEgressOptions
  extends QwpBrowserWebSocketOptions,
    QwpEgressRoutingOptions {
  /**
   * Requests Zstd-compressed result batches through browser-visible URL
   * negotiation. Defaults to raw for compatibility.
   */
  compression?: QwpEgressCompression;
  /**
   * Zstd level hint. Must be between 1 and 22, and only takes effect
   * alongside `compression`; the default `raw` negotiates no compression for
   * a level to travel on.
   */
  compressionLevel?: number;
  /** Requests a server-side RESULT_BATCH row cap. */
  maxBatchRows?: number;
}

/** Shared browser transport and authentication for one QWP cluster. */
export interface QwpBrowserClusterOptions extends QwpWebSocketConnectOptions {
  /**
   * Authenticates before every connection attempt. When `url` is omitted from
   * this bootstrap, its REST endpoint follows the active cluster endpoint.
   * Cannot be combined with `auth`.
   */
  sessionBootstrap?: QwpBrowserSessionBootstrapConfig;
  /**
   * Credential sent with every ingress and egress WebSocket upgrade; see
   * {@link QwpBrowserWebSocketOptions.auth}. A provider is called before every
   * connection attempt of either side. Cannot be combined with
   * `sessionBootstrap`.
   */
  auth?: QwpBrowserSessionAuthentication | QwpBrowserAuthProvider;
  /** Shared test or framework hook; either side may override it. */
  webSocketFactory?: (
    url: string | URL,
    protocols?: string | string[],
  ) => QwpWebSocketLike;
}

/** Ingress-only overrides for a unified browser cluster. */
export type QwpBrowserClientIngressOptions = Partial<
  Pick<
    QwpBrowserWebSocketOptions,
    | "protocols"
    | "connectTimeoutMs"
    | "sendTimeoutMs"
    | "closeTimeoutMs"
    | "requestDurableAck"
    | "ingressNegotiationTimeoutMs"
    | "webSocketFactory"
  >
>;

/** Egress-only overrides for a unified browser cluster. */
export type QwpBrowserClientEgressOptions = Partial<
  Pick<
    QwpBrowserEgressOptions,
    | "protocols"
    | "connectTimeoutMs"
    | "sendTimeoutMs"
    | "closeTimeoutMs"
    | "webSocketFactory"
    | "target"
    | "zone"
    | "compression"
    | "compressionLevel"
    | "maxBatchRows"
  >
>;

interface QwpBrowserClientBaseOptions {
  sender?: QwpSenderOptions;
  ingressSession?: QwpIngressSessionOptions;
  egressSession?: QwpEgressSessionOptions;
  pool?: QwpClientPoolOptions;
}

/**
 * Recommended combined-browser form. One endpoint list and authentication
 * bootstrap are shared while side-specific protocol options remain explicit.
 */
export interface QwpBrowserUnifiedClientOptions
  extends QwpBrowserClientBaseOptions {
  cluster: QwpBrowserClusterOptions;
  ingress?: QwpBrowserClientIngressOptions;
  egress?: QwpBrowserClientEgressOptions;
}

/** Backwards-compatible form with completely independent connection trees. */
export interface QwpBrowserSplitClientOptions
  extends QwpBrowserClientBaseOptions {
  cluster?: never;
  ingress: QwpBrowserWebSocketOptions;
  egress: QwpBrowserEgressOptions;
}

/** Browser configuration for a combined pooled QWP ingress/egress client. */
export type QwpBrowserClientOptions =
  | QwpBrowserUnifiedClientOptions
  | QwpBrowserSplitClientOptions;

interface QwpResolvedBrowserClientOptions extends QwpBrowserClientBaseOptions {
  ingress: QwpBrowserWebSocketOptions;
  egress: QwpBrowserEgressOptions;
}

const DEFAULT_BROWSER_CONNECT_TIMEOUT_MS = 15_000;

function composeBrowserAbortSignals(
  signals: readonly (AbortSignal | undefined)[],
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const listeners: { signal: AbortSignal; listener: () => void }[] = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort();
      break;
    }
    const listener = (): void => controller.abort();
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const entry of listeners) {
        entry.signal.removeEventListener("abort", entry.listener);
      }
    },
  };
}

/**
 * Opens a QWP-capable browser WebSocket.
 *
 * Browsers cannot set Authorization or X-QWP-* upgrade headers. QuestDB accepts
 * browser upgrades when Origin and Host have the same authority, or when the
 * server lists the Origin in `qwp.browser.allowed.origins`. When
 * authentication is enabled, a same-origin app can pass sessionBootstrap or
 * call bootstrapQwpBrowserSession first so the browser can attach
 * qdb_session; an app on a listed origin passes `auth` instead.
 */
export function connectQwpBrowserWebSocket(
  options: QwpBrowserWebSocketOptions,
): Promise<QwpBinaryConnection> {
  validateBrowserAuthOptions(options);
  return createQwpFailoverConnectionFactory(
    options.url,
    options.failoverUrls,
    (endpoint, signal) =>
      connectQwpBrowserRawEndpoint(options, endpoint, signal),
  )();
}

/** Creates a stateful browser endpoint walker suitable for session reconnects. */
export function createQwpBrowserConnectionFactory(
  options: QwpBrowserWebSocketOptions,
): QwpConnectionFactory {
  validateBrowserAuthOptions(options);
  return createQwpFailoverConnectionFactory(
    options.url,
    options.failoverUrls,
    (endpoint, signal) =>
      connectQwpBrowserIngressEndpoint(options, endpoint, signal),
  );
}

async function connectQwpBrowserEndpoint(
  options: QwpBrowserWebSocketOptions,
  endpoint: string | URL,
  requestEndpoint: string | URL,
  requestDurableAck: boolean,
  signal: AbortSignal | undefined,
  completeHandshake: (
    selectedProtocol: string | undefined,
  ) => QwpBinaryConnection["handshake"],
  finishOpening: (
    connection: QwpBinaryConnection,
  ) => Promise<QwpBinaryConnection> = async (connection) => connection,
): Promise<QwpBinaryConnection> {
  validateQwpWebSocketTimeouts(options);
  try {
    validateBrowserAuthOptions(options);
  } catch (error) {
    throw error instanceof Error ? qwpNonRetryable(error) : error;
  }
  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_BROWSER_CONNECT_TIMEOUT_MS;
  const openingAbort = new AbortController();
  let openedConnection: QwpBinaryConnection | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectBoundary!: (error: Error) => void;
  let boundarySettled = false;
  const failBoundary = (error: Error, reason: string): void => {
    if (boundarySettled) return;
    boundarySettled = true;
    rejectBoundary(error);
    openingAbort.abort();
    void openedConnection?.close(1000, reason).catch(() => undefined);
  };
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  const abortOpening = (): void => {
    failBoundary(
      new QwpSendClosedError(),
      "QWP connection closed while connecting",
    );
  };
  if (signal?.aborted) abortOpening();
  else signal?.addEventListener("abort", abortOpening, { once: true });
  if (!boundarySettled) {
    deadlineTimer = setTimeout(() => {
      failBoundary(
        new QwpUpgradeError(
          `QWP WebSocket connection timed out after ${connectTimeoutMs}ms`,
          {
            kind: QWP_UPGRADE_ERROR_KIND.TIMEOUT,
            retryable: true,
            tryNextEndpoint: true,
            url: endpoint,
          },
        ),
        "QWP connection timeout",
      );
    }, connectTimeoutMs);
  }

  const opening = (async (): Promise<QwpBinaryConnection> => {
    let credentialProtocol: string | undefined;
    if (options.auth !== undefined) {
      if (openingAbort.signal.aborted) throw new QwpSendClosedError();
      credentialProtocol = await resolveBrowserCredentialProtocol(
        options.auth,
        endpoint,
        openingAbort.signal,
      );
    } else if (options.sessionBootstrap) {
      const bootstrapAbort = composeBrowserAbortSignals([
        openingAbort.signal,
        options.sessionBootstrap.signal,
      ]);
      try {
        await bootstrapQwpBrowserSession({
          ...options.sessionBootstrap,
          url: options.sessionBootstrap.url ?? defaultBootstrapUrl(endpoint),
          signal: bootstrapAbort.signal,
        });
      } finally {
        bootstrapAbort.dispose();
      }
    }
    if (openingAbort.signal.aborted) throw new QwpSendClosedError();
    const factory =
      options.webSocketFactory ??
      ((url: string | URL, protocols?: string | string[]) => {
        const WebSocketConstructor = (
          globalThis as unknown as {
            WebSocket?: new (
              url: string | URL,
              protocols?: string | string[],
            ) => QwpWebSocketLike;
          }
        ).WebSocket;
        if (!WebSocketConstructor) {
          throw new Error("WebSocket is not available in this browser runtime");
        }
        return new WebSocketConstructor(url, protocols);
      });
    const socket = factory(
      requestEndpoint,
      qwpBrowserWebSocketProtocols(
        options.protocols,
        requestDurableAck,
        credentialProtocol,
      ),
    );
    openedConnection = await openQwpWebSocket(socket, {
      signal: openingAbort.signal,
      url: endpoint,
      connectTimeoutMs,
      sendTimeoutMs: options.sendTimeoutMs,
      closeTimeoutMs: options.closeTimeoutMs,
      completeHandshake: () => {
        // Checked whoever put the credential in the offer, and before the
        // selection is read for anything else.
        if (isQwpAuthorizationWebSocketProtocol(socket.protocol)) {
          throw credentialEchoError(endpoint);
        }
        return completeHandshake(socket.protocol);
      },
      opaqueErrors: true,
    });
    return finishOpening(openedConnection);
  })();

  try {
    const connection = await Promise.race([opening, boundary]);
    boundarySettled = true;
    return connection;
  } finally {
    boundarySettled = true;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    signal?.removeEventListener("abort", abortOpening);
  }
}

function browserNegotiationUrl(
  endpoint: string | URL,
  name: string,
  value: string,
): URL {
  const url =
    endpoint instanceof URL
      ? new URL(endpoint)
      : new URL(endpoint, globalThis.location?.href);
  url.searchParams.set(name, value);
  return url;
}

/**
 * Reads the upgrade's own durable-ACK signal.
 *
 * The subprotocol echo confirms that the server speaks the browser durable-ACK
 * negotiation; it does NOT say the capability is on, because the server echoes
 * whenever the token was offered. A missing echo therefore means the server
 * does not speak the negotiation at all -- unreachable through a real browser,
 * which drops such a handshake before it opens, but reachable through Node and
 * through an injected `webSocketFactory`. The capability itself is decided by
 * the SERVER_INFO frame, so this leaves `durableAckEnabled` unset.
 */
function browserIngressHandshake(
  options: QwpBrowserWebSocketOptions,
  endpoint: string | URL,
  selectedProtocol: string | undefined,
): QwpBinaryConnection["handshake"] {
  if (
    options.requestDurableAck &&
    !isQwpDurableAckWebSocketProtocol(selectedProtocol)
  ) {
    throw new QwpDurableAckUnavailableError(endpoint);
  }
  return { qwpVersion: QWP_VERSION };
}

function connectQwpBrowserRawEndpoint(
  options: QwpBrowserWebSocketOptions,
  endpoint: string | URL,
  signal?: AbortSignal,
): Promise<QwpBinaryConnection> {
  // Durable raw ingress needs both browser-visible negotiation signals: the
  // subprotocol carries the durable-ACK request, while the query parameter asks
  // the server to send the SERVER_INFO capability verdict this path consumes.
  const requestDurableAck = options.requestDurableAck === true;
  // Validated before the socket is constructed, like the sibling endpoint path
  // and validateQwpWebSocketTimeouts: reading it inside the opened-connection
  // callback rejected an unusable option only after a WebSocket had been
  // opened for it.
  const negotiationTimeoutMs = ingressNegotiationTimeoutMs(options);
  const requestEndpoint = requestDurableAck
    ? browserNegotiationUrl(endpoint, QWP_BROWSER_HANDSHAKE_PARAM, "v1")
    : endpoint;
  return connectQwpBrowserEndpoint(
    options,
    endpoint,
    requestEndpoint,
    requestDurableAck,
    signal,
    (selectedProtocol) =>
      browserIngressHandshake(options, endpoint, selectedProtocol),
    requestDurableAck
      ? async (connection) => {
          try {
            return await applyQwpBrowserIngressHandshake(
              connection,
              negotiationTimeoutMs,
              true,
              endpoint,
            );
          } catch (error) {
            await connection
              .close(1002, "invalid QWP ingress SERVER_INFO")
              .catch(() => undefined);
            throw error;
          }
        }
      : undefined,
  );
}

/**
 * Consumes the browser-requested ingress SERVER_INFO frame and folds it into
 * the handshake.
 *
 * When `requestDurableAck` is set the frame is mandatory, because its
 * capability bit is the only durable-ACK verdict a browser can read. Not
 * seeing one within the negotiation window -- including a `timeoutMs` of 0,
 * which asks not to wait at all -- is therefore reported as
 * {@link QwpDurableAckUnavailableError} rather than assumed either way: a
 * server with durable ACK on sends the frame with the 101, so its absence is
 * an answer, not a delay. Callers that want durable ACK must allow the window.
 */
async function applyQwpBrowserIngressHandshake(
  connection: QwpBinaryConnection,
  timeoutMs: number,
  requestDurableAck: boolean,
  endpoint: string | URL,
): Promise<QwpBinaryConnection> {
  const iterator = connection.messages[Symbol.asyncIterator]();
  const pendingFirst = iterator.next();
  // Nothing consumes this until the generator below is first iterated, and on
  // the timeoutMs === 0 path the Promise.race that would have subscribed to it
  // is never built. That window is real -- role and zone checks, replay, then
  // installing the pump -- and a transport error in it rejects this promise
  // with no subscriber, which surfaces as an unhandled rejection. Attaching a
  // handler marks it observed without consuming it: whoever awaits
  // `pendingResult` still receives the same value or rejection.
  void pendingFirst.then(undefined, () => undefined);
  const timeout = Symbol("QWP browser ingress negotiation timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outcome: IteratorResult<Uint8Array> | typeof timeout;
  try {
    outcome =
      timeoutMs === 0
        ? timeout
        : await Promise.race([
            pendingFirst,
            new Promise<typeof timeout>((resolve) => {
              timer = setTimeout(resolve, timeoutMs, timeout);
            }),
          ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const handshake: {
    qwpVersion: number;
    maxBatchSizeBytes?: number;
    contentEncoding?: string;
    negotiatedCompression?: QwpBinaryConnection["handshake"]["negotiatedCompression"];
    durableAckEnabled?: boolean;
    serverRole?: string;
    serverZone?: string;
  } = { ...connection.handshake };
  let firstResult: IteratorResult<Uint8Array> | undefined;
  let pendingResult: Promise<IteratorResult<Uint8Array>> | undefined;
  let serverInfoSeen = false;
  if (outcome === timeout) {
    pendingResult = pendingFirst;
  } else if (!outcome.done) {
    const serverInfo = decodeQwpIngressServerInfo(outcome.value);
    if (serverInfo === undefined) {
      firstResult = outcome;
    } else {
      serverInfoSeen = true;
      handshake.maxBatchSizeBytes = serverInfo.maxBatchSizeBytes;
      handshake.durableAckEnabled = serverInfo.durableAckEnabled;
    }
  }
  if (requestDurableAck && !(serverInfoSeen && handshake.durableAckEnabled)) {
    throw new QwpDurableAckUnavailableError(endpoint);
  }

  const messages: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      let result =
        firstResult ??
        (pendingResult === undefined
          ? await iterator.next()
          : await pendingResult);
      while (!result.done) {
        const serverInfo = decodeQwpIngressServerInfo(result.value);
        if (serverInfo === undefined) {
          yield result.value;
        } else {
          handshake.maxBatchSizeBytes = serverInfo.maxBatchSizeBytes;
          handshake.durableAckEnabled = serverInfo.durableAckEnabled;
        }
        result = await iterator.next();
      }
    },
  };

  return {
    messages,
    handshake,
    closed: connection.closed,
    endpoint: connection.endpoint,
    ingressSymbolDictionary: connection.ingressSymbolDictionary,
    ingressDeltaSymbolDictionaryEnabled:
      connection.ingressDeltaSymbolDictionaryEnabled,
    getIngressMetrics: connection.getIngressMetrics
      ? () => connection.getIngressMetrics!()
      : undefined,
    send: (payload) => connection.send(payload),
    ping: connection.ping ? () => connection.ping!() : undefined,
    close: (code, reason) => connection.close(code, reason),
  };
}

function ingressNegotiationTimeoutMs(
  options: QwpBrowserWebSocketOptions,
): number {
  const timeoutMs = options.ingressNegotiationTimeoutMs ?? 250;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0 ||
    exceedsQwpTimerCeiling(timeoutMs)
  ) {
    // Non-retryable for the same reason validateQwpWebSocketTimeouts marks its
    // rejections: this runs inside the per-attempt connection callback, and
    // retrying cannot fix an option.
    throw qwpNonRetryable(
      new RangeError(
        `ingressNegotiationTimeoutMs must be a non-negative finite number no greater than ${QWP_MAX_TIMER_DELAY_MS}`,
      ),
    );
  }
  return timeoutMs;
}

async function connectQwpBrowserIngressEndpoint(
  options: QwpBrowserWebSocketOptions,
  endpoint: string | URL,
  signal?: AbortSignal,
): Promise<QwpBinaryConnection> {
  const timeoutMs = ingressNegotiationTimeoutMs(options);
  return connectQwpBrowserEndpoint(
    options,
    endpoint,
    browserNegotiationUrl(endpoint, QWP_BROWSER_HANDSHAKE_PARAM, "v1"),
    options.requestDurableAck === true,
    signal,
    (selectedProtocol) =>
      browserIngressHandshake(options, endpoint, selectedProtocol),
    async (connection) => {
      try {
        return await applyQwpBrowserIngressHandshake(
          connection,
          timeoutMs,
          options.requestDurableAck === true,
          endpoint,
        );
      } catch (error) {
        await connection
          .close(1002, "invalid QWP ingress SERVER_INFO")
          .catch(() => undefined);
        throw error;
      }
    },
  );
}

function connectQwpBrowserEgressEndpoint(
  options: QwpBrowserEgressOptions,
  endpoint: string | URL,
  signal?: AbortSignal,
): Promise<QwpBinaryConnection> {
  const compression = options.compression ?? "raw";
  const acceptEncoding = encodeQwpAcceptEncoding(
    compression,
    options.compressionLevel ?? 1,
  );
  const maxBatchRows = validateQwpMaxBatchRows(options.maxBatchRows);
  let requestEndpoint: string | URL = endpoint;
  if (acceptEncoding !== undefined) {
    requestEndpoint = browserNegotiationUrl(
      requestEndpoint,
      QWP_ACCEPT_ENCODING_PARAM,
      acceptEncoding,
    );
  }
  if (maxBatchRows !== undefined) {
    requestEndpoint = browserNegotiationUrl(
      requestEndpoint,
      QWP_MAX_BATCH_ROWS_PARAM,
      String(maxBatchRows),
    );
  }
  // Never durable ACK, which only ingress negotiates: an egress upgrade whose
  // only dialect is durable ACK selects nothing, and a browser fails that.
  return connectQwpBrowserEndpoint(
    options,
    endpoint,
    requestEndpoint,
    false,
    signal,
    () => ({
      qwpVersion: QWP_VERSION,
      negotiatedCompression: { codec: "raw", level: 0 },
    }),
  );
}

/** Opens a browser WebSocket and starts an ingress ACK/NACK session. */
export async function connectQwpBrowserIngress(
  options: QwpBrowserWebSocketOptions,
  sessionOptions: QwpIngressSessionOptions = {},
  /** Cancels a first connect still negotiating; see QwpIngressSession.connect. */
  signal?: AbortSignal,
): Promise<QwpIngressSession> {
  if (
    sessionOptions.durableAckKeepaliveMs !== undefined &&
    options.requestDurableAck !== true
  ) {
    throw new RangeError(
      "durableAckKeepaliveMs requires requestDurableAck=true for browser ingress",
    );
  }
  const effectiveSessionOptions: QwpIngressSessionOptions = {
    ...sessionOptions,
    durableAckKeepaliveMs: options.requestDurableAck
      ? (sessionOptions.durableAckKeepaliveMs ?? 200)
      : sessionOptions.durableAckKeepaliveMs,
  };
  return QwpIngressSession.connect(
    createQwpBrowserConnectionFactory(options),
    effectiveSessionOptions,
    signal,
  );
}

/**
 * Creates a browser-safe fluent QWP sender without opening the WebSocket yet.
 * Call connect(), or let the first flush connect lazily.
 */
export function createQwpBrowserSender(
  options: QwpBrowserWebSocketOptions,
  senderOptions: QwpSenderOptions = {},
  sessionOptions: QwpIngressSessionOptions = {},
): QwpSender {
  if (senderOptions.awaitDurableAck && options.requestDurableAck === false) {
    throw new RangeError(
      "awaitDurableAck cannot be combined with requestDurableAck=false",
    );
  }
  // The sender connects lazily; without this a bad `auth` would surface only
  // from the first connect() or flush().
  validateBrowserAuthOptions(options);
  return new QwpSender(
    (signal) =>
      connectQwpBrowserIngress(
        {
          ...options,
          requestDurableAck:
            options.requestDurableAck ?? senderOptions.awaitDurableAck,
        },
        sessionOptions,
        signal,
      ),
    senderOptions,
  );
}

/** Opens a browser QWP connection and returns a fluent sender. */
export async function connectQwpBrowserSender(
  options: QwpBrowserWebSocketOptions,
  senderOptions: QwpSenderOptions = {},
  sessionOptions: QwpIngressSessionOptions = {},
): Promise<QwpSender> {
  const sender = createQwpBrowserSender(options, senderOptions, sessionOptions);
  await sender.connect();
  return sender;
}

/** Opens a browser WebSocket and waits for the egress SERVER_INFO handshake. */
export async function connectQwpBrowserEgress(
  options: QwpBrowserEgressOptions,
  sessionOptions: QwpEgressSessionOptions = {},
  /** Cancels an opening connection during pooled-client shutdown. */
  signal?: AbortSignal,
): Promise<QwpEgressSession> {
  validateBrowserAuthOptions(options);
  return QwpEgressSession.connect(
    createQwpEgressFailoverConnectionFactory(
      options.url,
      options.failoverUrls,
      (endpoint, signal) =>
        connectQwpBrowserEgressEndpoint(options, endpoint, signal),
      { target: options.target, zone: options.zone },
      sessionOptions.serverInfoTimeoutMs ??
        QWP_DEFAULT_EGRESS_SERVER_INFO_TIMEOUT_MS,
    ),
    // The request this client puts on the wire is also the bound it enforces
    // on the answer; without it a peer's declared row count sizes the decoder
    // scratch on its own.
    {
      ...sessionOptions,
      maxBatchRows: sessionOptions.maxBatchRows ?? options.maxBatchRows,
    },
    signal,
  );
}

const CLUSTER_OWNED_BROWSER_OPTION_NAMES = [
  "url",
  "failoverUrls",
  "sessionBootstrap",
  "auth",
] as const;

function assertNoBrowserClusterOptionConflicts(
  side: "ingress" | "egress",
  options: object | undefined,
): void {
  if (!options) return;
  for (const name of CLUSTER_OWNED_BROWSER_OPTION_NAMES) {
    if (Object.prototype.hasOwnProperty.call(options, name)) {
      throw new TypeError(
        `conflicting browser client configuration: ${side}.${name} must be configured once under cluster.${name}`,
      );
    }
  }
}

function browserClusterEndpoint(
  endpoint: string | URL,
  route: "write/v4" | "read/v1",
): URL {
  const url =
    endpoint instanceof URL
      ? new URL(endpoint)
      : new URL(endpoint, globalThis.location?.href);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError(
      `QWP browser cluster URL must use WS or WSS: ${redactedUrlText(url)}`,
    );
  }
  if (url.hash) {
    throw new TypeError(
      `QWP browser cluster URL cannot contain a fragment: ${redactedUrlText(url)}`,
    );
  }
  const qwpRoute = /\/(?:write\/v4|read\/v1)\/?$/;
  if (qwpRoute.test(url.pathname)) {
    url.pathname = url.pathname.replace(qwpRoute, `/${route}`);
  } else {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${route}`;
  }
  return url;
}

function resolveQwpBrowserClientOptions(
  options: QwpBrowserClientOptions,
): QwpResolvedBrowserClientOptions {
  if ("cluster" in options && options.cluster !== undefined) {
    assertNoBrowserClusterOptionConflicts("ingress", options.ingress);
    assertNoBrowserClusterOptionConflicts("egress", options.egress);
    const { url, failoverUrls, ...shared } = options.cluster;
    const ingress: QwpBrowserWebSocketOptions = {
      ...shared,
      ...options.ingress,
      url: browserClusterEndpoint(url, "write/v4"),
      failoverUrls: failoverUrls?.map((endpoint) =>
        browserClusterEndpoint(endpoint, "write/v4"),
      ),
    };
    const egress: QwpBrowserEgressOptions = {
      ...shared,
      ...options.egress,
      url: browserClusterEndpoint(url, "read/v1"),
      failoverUrls: failoverUrls?.map((endpoint) =>
        browserClusterEndpoint(endpoint, "read/v1"),
      ),
    };
    // browserClusterEndpoint() checks each URL on its own; only comparing them
    // catches a cleartext entry under a `wss` cluster, which a failover sweep
    // would hand this client's session credentials and rows.
    assertUniformQwpEndpointScheme(ingress.url, ingress.failoverUrls);
    assertUniformQwpEndpointScheme(egress.url, egress.failoverUrls);
    // After the merge: a side's own `protocols` override meets the shared
    // `auth` only here.
    validateBrowserAuthOptions(ingress);
    validateBrowserAuthOptions(egress);
    return {
      ingress,
      egress,
      sender: options.sender,
      ingressSession: options.ingressSession,
      egressSession: options.egressSession,
      pool: options.pool,
    };
  }
  if (!options.ingress || !options.egress) {
    throw new TypeError(
      "browser client configuration requires either cluster or both ingress and egress",
    );
  }
  const split = options as QwpBrowserSplitClientOptions;
  validateBrowserAuthOptions(split.ingress);
  validateBrowserAuthOptions(split.egress);
  return {
    ingress: split.ingress,
    egress: split.egress,
    sender: split.sender,
    ingressSession: split.ingressSession,
    egressSession: split.egressSession,
    pool: split.pool,
  };
}

/** Creates a lazy browser QWP client with bounded sender and query pools. */
export function createQwpBrowserClient(
  options: QwpBrowserClientOptions,
): QwpClient {
  const resolved = resolveQwpBrowserClientOptions(options);
  return new QwpClient(
    {
      createSender: async (_slot, signal) => {
        const sender = createQwpBrowserSender(
          resolved.ingress,
          resolved.sender,
          resolved.ingressSession,
        );
        const abortOpening = (): void => {
          void sender.close().catch(() => undefined);
        };
        try {
          if (signal?.aborted) throw new QwpSendClosedError();
          signal?.addEventListener("abort", abortOpening, { once: true });
          await sender.connect();
          if (signal?.aborted) throw new QwpSendClosedError();
          return sender;
        } catch (error) {
          await sender.close().catch(() => undefined);
          throw error;
        } finally {
          signal?.removeEventListener("abort", abortOpening);
        }
      },
      createQuerySession: (_slot, signal) =>
        connectQwpBrowserEgress(
          resolved.egress,
          resolved.egressSession,
          signal,
        ),
    },
    resolved.pool,
  );
}

/** Creates and prewarms a combined browser QWP ingress/egress client. */
export async function connectQwpBrowserClient(
  options: QwpBrowserClientOptions,
): Promise<QwpClient> {
  const client = createQwpBrowserClient(options);
  try {
    await client.connect();
  } catch (error) {
    // The caller never receives this client, so this helper owns its teardown.
    // See connectQwpNodeClient(): a failed prewarm leaves the pool housekeeper
    // and any already-established sessions running with nobody able to stop
    // them. Retrying is still available through createQwpBrowserClient().
    await client.close().catch(() => undefined);
    throw error;
  }
  return client;
}
