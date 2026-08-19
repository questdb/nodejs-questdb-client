/** Browser WebSocket adapter and browser-safe QWP protocol/session APIs. */
export * from "./index";

import {
  openQwpWebSocket,
  QwpWebSocketLike,
  validateQwpWebSocketTimeouts,
} from "./internal/websocket-connection";
import { createQwpFailoverConnectionFactory } from "./internal/failover";
import { createQwpEgressFailoverConnectionFactory } from "./internal/egress-routing";
import { validateQwpMaxBatchRows } from "./internal/egress-limits";
import {
  addQwpDurableAckWebSocketProtocol,
  decodeQwpIngressServerInfo,
  encodeQwpAcceptEncoding,
  isQwpDurableAckWebSocketProtocol,
  QwpEgressCompression,
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
import {
  QWP_DEFAULT_EGRESS_SERVER_INFO_TIMEOUT_MS,
  QwpEgressSession,
  QwpEgressSessionOptions,
} from "./egress-session";
import { QwpIngressSession, QwpIngressSessionOptions } from "./ingress-session";
import { QwpSender, QwpSenderOptions } from "./sender";
import { QwpClient, QwpClientPoolOptions } from "./client";

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
   * Time allowed for the optional ingress SERVER_INFO message. Defaults to
   * 250ms; zero disables the initial wait while retaining late negotiation.
   */
  ingressNegotiationTimeoutMs?: number;
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
    QwpEgressRoutingOptions {
  /**
   * Requests Zstd-compressed result batches through browser-visible URL
   * negotiation. Defaults to raw for compatibility.
   */
  compression?: QwpEgressCompression;
  /** Zstd level hint. Must be between 1 and 22. */
  compressionLevel?: number;
  /** Requests a server-side RESULT_BATCH row cap. */
  maxBatchRows?: number;
}

/** Shared browser transport and authentication for one QWP cluster. */
export interface QwpBrowserClusterOptions extends QwpWebSocketConnectOptions {
  /**
   * Authenticates before every connection attempt. When `url` is omitted from
   * this bootstrap, its REST endpoint follows the active cluster endpoint.
   */
  sessionBootstrap?: QwpBrowserSessionBootstrapConfig;
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
  return createQwpFailoverConnectionFactory(
    options.url,
    options.failoverUrls,
    (endpoint) => connectQwpBrowserRawEndpoint(options, endpoint),
  )();
}

/** Creates a stateful browser endpoint walker suitable for session reconnects. */
export function createQwpBrowserConnectionFactory(
  options: QwpBrowserWebSocketOptions,
): QwpConnectionFactory {
  return createQwpFailoverConnectionFactory(
    options.url,
    options.failoverUrls,
    (endpoint) => connectQwpBrowserIngressEndpoint(options, endpoint),
  );
}

async function connectQwpBrowserEndpoint(
  options: QwpBrowserWebSocketOptions,
  endpoint: string | URL,
  requestEndpoint: string | URL,
  protocols: string | string[] | undefined,
  completeHandshake: (
    selectedProtocol: string | undefined,
  ) => QwpBinaryConnection["handshake"],
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
  const socket = factory(requestEndpoint, protocols);
  return openQwpWebSocket(socket, {
    url: endpoint,
    connectTimeoutMs: options.connectTimeoutMs,
    sendTimeoutMs: options.sendTimeoutMs,
    closeTimeoutMs: options.closeTimeoutMs,
    completeHandshake: () => completeHandshake(socket.protocol),
    opaqueErrors: true,
  });
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

function connectQwpBrowserRawEndpoint(
  options: QwpBrowserWebSocketOptions,
  endpoint: string | URL,
): Promise<QwpBinaryConnection> {
  const protocols = options.requestDurableAck
    ? addQwpDurableAckWebSocketProtocol(options.protocols)
    : options.protocols;
  return connectQwpBrowserEndpoint(
    options,
    endpoint,
    endpoint,
    protocols,
    (selectedProtocol) => {
      const durableAckEnabled =
        isQwpDurableAckWebSocketProtocol(selectedProtocol);
      if (options.requestDurableAck && !durableAckEnabled) {
        throw new QwpDurableAckUnavailableError(endpoint);
      }
      return durableAckEnabled
        ? { qwpVersion: QWP_VERSION, durableAckEnabled: true }
        : { qwpVersion: QWP_VERSION };
    },
  );
}

async function applyQwpBrowserIngressHandshake(
  connection: QwpBinaryConnection,
  timeoutMs: number,
): Promise<QwpBinaryConnection> {
  const iterator = connection.messages[Symbol.asyncIterator]();
  const pendingFirst = iterator.next();
  const timeout = Symbol("QWP browser ingress negotiation timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome =
    timeoutMs === 0
      ? timeout
      : await Promise.race([
          pendingFirst,
          new Promise<typeof timeout>((resolve) => {
            timer = setTimeout(resolve, timeoutMs, timeout);
          }),
        ]);
  if (timer !== undefined) clearTimeout(timer);

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
  if (outcome === timeout) {
    pendingResult = pendingFirst;
  } else if (!outcome.done) {
    const maxBatchSizeBytes = decodeQwpIngressServerInfo(outcome.value);
    if (maxBatchSizeBytes === undefined) firstResult = outcome;
    else handshake.maxBatchSizeBytes = maxBatchSizeBytes;
  }

  const messages: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      let result =
        firstResult ??
        (pendingResult === undefined
          ? await iterator.next()
          : await pendingResult);
      while (!result.done) {
        const maxBatchSizeBytes = decodeQwpIngressServerInfo(result.value);
        if (maxBatchSizeBytes === undefined) yield result.value;
        else handshake.maxBatchSizeBytes = maxBatchSizeBytes;
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

async function connectQwpBrowserIngressEndpoint(
  options: QwpBrowserWebSocketOptions,
  endpoint: string | URL,
): Promise<QwpBinaryConnection> {
  const timeoutMs = options.ingressNegotiationTimeoutMs ?? 250;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(
      "ingressNegotiationTimeoutMs must be a non-negative finite number",
    );
  }
  const connection = await connectQwpBrowserEndpoint(
    options,
    endpoint,
    browserNegotiationUrl(endpoint, "qwp_browser_handshake", "v1"),
    options.requestDurableAck
      ? addQwpDurableAckWebSocketProtocol(options.protocols)
      : options.protocols,
    (selectedProtocol) => {
      const durableAckEnabled =
        isQwpDurableAckWebSocketProtocol(selectedProtocol);
      if (options.requestDurableAck && !durableAckEnabled) {
        throw new QwpDurableAckUnavailableError(endpoint);
      }
      return durableAckEnabled
        ? { qwpVersion: QWP_VERSION, durableAckEnabled: true }
        : { qwpVersion: QWP_VERSION };
    },
  );
  try {
    return await applyQwpBrowserIngressHandshake(connection, timeoutMs);
  } catch (error) {
    await connection
      .close(1002, "invalid QWP ingress SERVER_INFO")
      .catch(() => undefined);
    throw error;
  }
}

function connectQwpBrowserEgressEndpoint(
  options: QwpBrowserEgressOptions,
  endpoint: string | URL,
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
      "qwp_accept_encoding",
      acceptEncoding,
    );
  }
  if (maxBatchRows !== undefined) {
    requestEndpoint = browserNegotiationUrl(
      requestEndpoint,
      "qwp_max_batch_rows",
      String(maxBatchRows),
    );
  }
  return connectQwpBrowserEndpoint(
    options,
    endpoint,
    requestEndpoint,
    options.protocols,
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
      (endpoint) => connectQwpBrowserEgressEndpoint(options, endpoint),
      { target: options.target, zone: options.zone },
      sessionOptions.serverInfoTimeoutMs ??
        QWP_DEFAULT_EGRESS_SERVER_INFO_TIMEOUT_MS,
    ),
    sessionOptions,
  );
}

const CLUSTER_OWNED_BROWSER_OPTION_NAMES = [
  "url",
  "failoverUrls",
  "sessionBootstrap",
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
    throw new TypeError(`QWP browser cluster URL must use WS or WSS: ${url}`);
  }
  if (url.hash) {
    throw new TypeError(
      `QWP browser cluster URL cannot contain a fragment: ${url}`,
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
      createSender: async () => {
        const sender = createQwpBrowserSender(
          resolved.ingress,
          resolved.sender,
          resolved.ingressSession,
        );
        try {
          await sender.connect();
          return sender;
        } catch (error) {
          await sender.close().catch(() => undefined);
          throw error;
        }
      },
      createQuerySession: () =>
        connectQwpBrowserEgress(resolved.egress, resolved.egressSession),
    },
    resolved.pool,
  );
}

/** Creates and prewarms a combined browser QWP ingress/egress client. */
export async function connectQwpBrowserClient(
  options: QwpBrowserClientOptions,
): Promise<QwpClient> {
  const client = createQwpBrowserClient(options);
  await client.connect();
  return client;
}
