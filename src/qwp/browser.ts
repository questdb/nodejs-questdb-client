/** Browser WebSocket adapter and browser-safe QWP protocol/session APIs. */
export * from "./index";

import {
  openQwpWebSocket,
  QwpWebSocketLike,
  validateQwpWebSocketTimeouts,
} from "./internal/websocket-connection";
import { createQwpFailoverConnectionFactory } from "./internal/failover";
import { createQwpEgressFailoverConnectionFactory } from "./internal/egress-routing";
import {
  addQwpDurableAckWebSocketProtocol,
  isQwpDurableAckWebSocketProtocol,
  QWP_VERSION,
} from "./core";
import {
  QwpBinaryConnection,
  QwpConnectionFactory,
  QwpDurableAckUnavailableError,
  QwpEgressRoutingOptions,
  QWP_UPGRADE_ERROR_KIND,
  QwpUpgradeError,
  QwpWebSocketConnectOptions,
} from "./transport";
import { QwpEgressSession, QwpEgressSessionOptions } from "./egress-session";
import { QwpIngressSession, QwpIngressSessionOptions } from "./ingress-session";
import { QwpSender, QwpSenderOptions } from "./sender";

export type { QwpWebSocketLike } from "./internal/websocket-connection";

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
        retryable: !authenticationFailure && statusCode >= 500,
        tryNextEndpoint: !authenticationFailure,
        url,
        statusCode,
        statusMessage,
      },
    );
    this.name = "QwpBrowserSessionBootstrapError";
  }
}

function validateAuthentication(
  authentication: QwpBrowserSessionAuthentication,
): void {
  if (authentication.type === "basic") {
    if (!authentication.username) {
      throw new TypeError("browser session username cannot be empty");
    }
    if (authentication.username.includes(":")) {
      throw new TypeError("browser session username cannot contain ':'");
    }
    if (/\r|\n/.test(authentication.username + authentication.password)) {
      throw new TypeError(
        "browser session credentials cannot contain CR or LF",
      );
    }
    return;
  }
  if (authentication.type === "bearer") {
    if (!authentication.token) {
      throw new TypeError("browser session bearer token cannot be empty");
    }
    if (/\r|\n/.test(authentication.token)) {
      throw new TypeError(
        "browser session bearer token cannot contain CR or LF",
      );
    }
    return;
  }
  throw new TypeError(
    `unsupported browser session authentication type '${String((authentication as { type?: unknown }).type)}'`,
  );
}

function encodeBase64Utf8(value: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = new TextEncoder().encode(value);
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    result += alphabet[first >>> 2];
    result += alphabet[((first & 0x03) << 4) | ((second ?? 0) >>> 4)];
    result +=
      second === undefined
        ? "="
        : alphabet[((second & 0x0f) << 2) | ((third ?? 0) >>> 6)];
    result += third === undefined ? "=" : alphabet[third & 0x3f];
  }
  return result;
}

function authorizationHeader(
  authentication: QwpBrowserSessionAuthentication,
): string {
  validateAuthentication(authentication);
  return authentication.type === "basic"
    ? `Basic ${encodeBase64Utf8(`${authentication.username}:${authentication.password}`)}`
    : `Bearer ${authentication.token}`;
}

function resolveHttpUrl(value: string | URL): URL {
  const base = globalThis.location?.href;
  const url = value instanceof URL ? new URL(value) : new URL(value, base);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(
      `browser session bootstrap URL must use HTTP or HTTPS: ${url}`,
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

function defaultBootstrapUrl(endpoint: string | URL): URL {
  const base = globalThis.location?.href;
  const url =
    endpoint instanceof URL ? new URL(endpoint) : new URL(endpoint, base);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  else {
    throw new TypeError(`QWP browser URL must use WS or WSS: ${url}`);
  }
  const suffix = /\/(?:write\/v4|read\/v1)\/?$/;
  url.pathname = suffix.test(url.pathname)
    ? url.pathname.replace(suffix, "/exec")
    : "/exec";
  url.search = "";
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
  let responseBody = "";
  try {
    responseBody = await response.text();
  } catch (error) {
    if (response.ok) {
      return {
        url: requestUrl.toString(),
        status: response.status,
        serviceAccount: options.serviceAccount,
      };
    }
    responseBody = error instanceof Error ? error.message : String(error);
  }
  if (!response.ok) {
    throw new QwpBrowserSessionBootstrapError(
      responseBody.slice(0, 1_024),
      requestUrl,
      response.status,
      response.statusText,
    );
  }
  return {
    url: requestUrl.toString(),
    status: response.status,
    serviceAccount: options.serviceAccount,
  };
}

export interface QwpBrowserWebSocketOptions extends QwpWebSocketConnectOptions {
  /**
   * Requests durable ingress ACKs through browser-visible WebSocket
   * subprotocol negotiation.
   */
  requestDurableAck?: boolean;
  /**
   * Authenticates over REST before every WebSocket connection attempt so the
   * browser can attach QuestDB's HttpOnly session cookies to the upgrade.
   */
  sessionBootstrap?: QwpBrowserSessionBootstrapConfig;
  /** Test or framework hook; defaults to the browser's global WebSocket. */
  webSocketFactory?: (
    url: string | URL,
    protocols?: string | string[],
  ) => QwpWebSocketLike;
}

/** Browser WebSocket options plus protocol-level egress topology routing. */
export interface QwpBrowserEgressOptions
  extends QwpBrowserWebSocketOptions,
    QwpEgressRoutingOptions {}

/**
 * Opens a QWP-capable browser WebSocket.
 *
 * Browsers cannot set Authorization or X-QWP-* upgrade headers. QuestDB accepts
 * browser upgrades when Origin and Host have the same authority, so serve the
 * app from the QuestDB origin or route QWP through a same-origin reverse proxy.
 * When authentication is enabled, pass sessionBootstrap or call
 * bootstrapQwpBrowserSession first so the browser can attach qdb_session.
 */
export function connectQwpBrowserWebSocket(
  options: QwpBrowserWebSocketOptions,
): Promise<QwpBinaryConnection> {
  return createQwpBrowserConnectionFactory(options)();
}

/** Creates a stateful browser endpoint walker suitable for session reconnects. */
export function createQwpBrowserConnectionFactory(
  options: QwpBrowserWebSocketOptions,
): QwpConnectionFactory {
  return createQwpFailoverConnectionFactory(
    options.url,
    options.failoverUrls,
    (endpoint) => connectQwpBrowserEndpoint(options, endpoint),
  );
}

async function connectQwpBrowserEndpoint(
  options: QwpBrowserWebSocketOptions,
  endpoint: string | URL,
): Promise<QwpBinaryConnection> {
  validateQwpWebSocketTimeouts(options);
  if (options.sessionBootstrap) {
    await bootstrapQwpBrowserSession({
      ...options.sessionBootstrap,
      url: options.sessionBootstrap.url ?? defaultBootstrapUrl(endpoint),
    });
  }
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
  const protocols = options.requestDurableAck
    ? addQwpDurableAckWebSocketProtocol(options.protocols)
    : options.protocols;
  const socket = factory(endpoint, protocols);
  return openQwpWebSocket(socket, {
    url: endpoint,
    connectTimeoutMs: options.connectTimeoutMs,
    sendTimeoutMs: options.sendTimeoutMs,
    closeTimeoutMs: options.closeTimeoutMs,
    completeHandshake: () => {
      const durableAckEnabled = isQwpDurableAckWebSocketProtocol(
        socket.protocol,
      );
      if (options.requestDurableAck && !durableAckEnabled) {
        throw new QwpDurableAckUnavailableError(endpoint);
      }
      return durableAckEnabled
        ? { qwpVersion: QWP_VERSION, durableAckEnabled: true }
        : { qwpVersion: QWP_VERSION };
    },
    opaqueErrors: true,
  });
}

/** Opens a browser WebSocket and starts an ingress ACK/NACK session. */
export async function connectQwpBrowserIngress(
  options: QwpBrowserWebSocketOptions,
  sessionOptions: QwpIngressSessionOptions = {},
): Promise<QwpIngressSession> {
  const effectiveSessionOptions: QwpIngressSessionOptions = {
    ...sessionOptions,
    durableAckKeepaliveMs: options.requestDurableAck
      ? (sessionOptions.durableAckKeepaliveMs ?? 200)
      : sessionOptions.durableAckKeepaliveMs,
  };
  return QwpIngressSession.connect(
    createQwpBrowserConnectionFactory(options),
    effectiveSessionOptions,
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
  return new QwpSender(
    () =>
      connectQwpBrowserIngress(
        {
          ...options,
          requestDurableAck:
            options.requestDurableAck ?? senderOptions.awaitDurableAck,
        },
        sessionOptions,
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
): Promise<QwpEgressSession> {
  return QwpEgressSession.connect(
    createQwpEgressFailoverConnectionFactory(
      options.url,
      options.failoverUrls,
      (endpoint) => connectQwpBrowserEndpoint(options, endpoint),
      { target: options.target, zone: options.zone },
      sessionOptions.serverInfoTimeoutMs ?? 15_000,
    ),
    sessionOptions,
  );
}
