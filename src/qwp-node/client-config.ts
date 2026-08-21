import { readFileSync } from "node:fs";
import { Agent as HttpsAgent } from "node:https";
import type {
  QwpNodeClientConfigOptions,
  QwpNodeClientOptions,
  QwpNodeEgressOptions,
  QwpNodeIngressOptions,
  QwpNodeStoreAndForwardOptions,
} from "../qwp/node";
import type { QwpClientPoolOptions } from "../_qwp/client";
import type { QwpEgressSessionOptions } from "../_qwp/egress-session";
import type { QwpIngressSessionOptions } from "../_qwp/ingress-session";
import type { QwpSenderOptions } from "../_qwp/sender";
import type { QwpReconnectOptions, QwpTarget } from "../_qwp/transport";

const DEFAULT_QWP_PORT = 9000;
const MAX_BATCH_ROWS = 1_048_576;
const DEFAULT_CLOSE_FLUSH_TIMEOUT_MS = 5_000;
const DEFAULT_SF_MAX_SEGMENT_BYTES = 4 * 1024 * 1024;
const DEFAULT_SF_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_SF_APPEND_DEADLINE_MS = 30_000;

/**
 * Legacy ILP keys that are not part of the QWP vocabulary. They are rejected
 * like any other unknown key, with the same relocation hint the Java client
 * gives, so a connect string behaves identically across QuestDB clients.
 */
const RELOCATED_HINTS = new Map([
  ["retry_timeout", "(use reconnect_max_duration_millis on ws/wss)"],
  [
    "protocol_version",
    "(QWP negotiates the protocol version during the WebSocket upgrade)",
  ],
  ["init_buf_size", "(applies to legacy http/tcp/udp transports only)"],
  ["max_buf_size", "(applies to legacy http/tcp/udp transports only)"],
  ["request_timeout", "(applies to legacy http/tcp/udp transports only)"],
  [
    "request_min_throughput",
    "(applies to legacy http/tcp/udp transports only)",
  ],
  ["max_datagram_size", "(applies to legacy http/tcp/udp transports only)"],
  ["multicast_ttl", "(applies to legacy http/tcp/udp transports only)"],
]);

/**
 * @internal Every key a ws/wss connect string may carry, shared with the other
 * QuestDB clients. Exported so the QWP.md reference can be tested against it.
 */
export const QWP_SUPPORTED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "addr",
  "username",
  "password",
  "user",
  "pass",
  "token",
  "tls_verify",
  "tls_roots",
  "tls_roots_password",
  "auth_timeout_ms",
  "connect_timeout",
  "auto_flush",
  "auto_flush_bytes",
  "auto_flush_interval",
  "auto_flush_rows",
  "close_flush_timeout_millis",
  "drain_orphans",
  "durable_ack_keepalive_interval_millis",
  "initial_connect_retry",
  "max_background_drainers",
  "max_frame_rejections",
  "poison_min_escalation_window_millis",
  "catch_up_cap_gap_min_escalation_window_millis",
  "reconnect_initial_backoff_millis",
  "reconnect_max_backoff_millis",
  "reconnect_max_duration_millis",
  "request_durable_ack",
  "sf_append_deadline_millis",
  "sf_dir",
  "sf_durability",
  "sf_max_total_bytes",
  "sf_sync_interval_millis",
  "transaction",
  "target",
  "failover",
  "failover_max_attempts",
  "failover_backoff_initial_ms",
  "failover_backoff_max_ms",
  "failover_max_duration_ms",
  "max_batch_rows",
  "initial_credit",
  "buffer_pool_size",
  "compression",
  "compression_level",
  "client_id",
  "zone",
  "sender_pool_min",
  "sender_pool_max",
  "query_pool_min",
  "query_pool_max",
  "acquire_timeout_ms",
  "query_close_timeout_ms",
  "idle_timeout_ms",
  "max_lifetime_ms",
  "housekeeper_interval_ms",
  "lazy_connect",
  "connection_listener_inbox_capacity",
  "error_inbox_capacity",
  "max_name_len",
  "sender_id",
  "sf_max_segment_bytes",
  // Reserved by the shared QWP configuration vocabulary. They are accepted
  // as intentional no-ops until the TypeScript client exposes these policies.
  "on_internal_error",
  "on_parse_error",
  "on_schema_error",
  "on_security_error",
  "on_server_error",
  "on_write_error",
]);

interface ParsedConfig {
  readonly schema: "ws" | "wss";
  readonly values: ReadonlyMap<string, readonly string[]>;
}

/** Parses one ws/wss cluster string into the combined Node facade options. */
export function resolveQwpNodeClientConfig(
  configurationString: string,
  extraOptions: QwpNodeClientConfigOptions = {},
): QwpNodeClientOptions {
  const parsed = parseConfigurationString(configurationString);
  const value = (key: string): string | undefined =>
    parsed.values.get(key)?.[0];
  const endpoints = parseEndpoints(parsed);
  const lazyConnect =
    optionalBoolean(value("lazy_connect"), "lazy_connect") ?? false;
  const initialConnectMode = resolveInitialConnectMode(
    parsed.values,
    lazyConnect,
  );

  validateAuthentication(parsed.values);
  validateTls(parsed);

  const authorization = createAuthorization(parsed.values);
  const configuredAgent = createTlsAgent(parsed);

  const common = {
    ...extraOptions.webSocket,
    connectTimeoutMs:
      extraOptions.webSocket?.connectTimeoutMs ??
      optionalPositiveInteger(value("connect_timeout"), "connect_timeout"),
    authTimeoutMs:
      extraOptions.webSocket?.authTimeoutMs ??
      optionalPositiveInteger(value("auth_timeout_ms"), "auth_timeout_ms"),
    clientId: extraOptions.webSocket?.clientId ?? value("client_id"),
    authorization: extraOptions.webSocket?.authorization ?? authorization,
    agent: extraOptions.webSocket?.agent ?? configuredAgent,
  };

  const ingressReconnect = parseIngressReconnect(parsed.values);
  const egressReconnect = parseEgressReconnect(parsed.values);
  const configuredStoreAndForward = parseStoreAndForward(
    parsed.values,
    extraOptions.storeAndForward?.directory,
    initialConnectMode,
  );
  const storeAndForward = extraOptions.storeAndForward
    ? { ...configuredStoreAndForward, ...extraOptions.storeAndForward }
    : configuredStoreAndForward;
  validateStoreAndForwardDependencies(parsed.values, storeAndForward);

  const sender: QwpSenderOptions = {
    autoFlush: optionalBoolean(value("auto_flush"), "auto_flush"),
    autoFlushRows: optionalInteger(
      value("auto_flush_rows"),
      "auto_flush_rows",
      0,
    ),
    autoFlushBytes: optionalSize(
      value("auto_flush_bytes"),
      "auto_flush_bytes",
      0,
      true,
    ),
    autoFlushIntervalMs: optionalInteger(
      value("auto_flush_interval"),
      "auto_flush_interval",
      0,
    ),
    closeFlushTimeoutMs:
      optionalInteger(
        value("close_flush_timeout_millis"),
        "close_flush_timeout_millis",
        0,
      ) ?? DEFAULT_CLOSE_FLUSH_TIMEOUT_MS,
    maxNameLength:
      optionalInteger(value("max_name_len"), "max_name_len", 16) ?? 127,
    transactional: optionalBoolean(value("transaction"), "transaction"),
    ...extraOptions.sender,
  };

  const ingressSession: QwpIngressSessionOptions = {
    reconnect: ingressReconnect,
    initialConnectMode,
    memoryReplayMaxBytes: storeAndForward
      ? undefined
      : optionalSize(value("sf_max_total_bytes"), "sf_max_total_bytes", 1),
    memoryReplayAppendDeadlineMs: storeAndForward
      ? undefined
      : optionalPositiveInteger(
          value("sf_append_deadline_millis"),
          "sf_append_deadline_millis",
        ),
    maxBatchSizeBytes: optionalSize(
      value("sf_max_segment_bytes"),
      "sf_max_segment_bytes",
      1,
    ),
    connectionListenerInboxCapacity: optionalInteger(
      value("connection_listener_inbox_capacity"),
      "connection_listener_inbox_capacity",
      1,
    ),
    errorInboxCapacity: optionalInteger(
      value("error_inbox_capacity"),
      "error_inbox_capacity",
      16,
    ),
    durableAckKeepaliveMs: optionalInteger(
      value("durable_ack_keepalive_interval_millis"),
      "durable_ack_keepalive_interval_millis",
      0,
    ),
    ...extraOptions.ingressSession,
  };
  const egressSession: QwpEgressSessionOptions = {
    reconnect: egressReconnect,
    initialCredit: optionalInteger(
      value("initial_credit"),
      "initial_credit",
      0,
    ),
    bufferPoolSize: optionalInteger(
      value("buffer_pool_size"),
      "buffer_pool_size",
      1,
    ),
    cancelDrainTimeoutMs: optionalInteger(
      value("query_close_timeout_ms"),
      "query_close_timeout_ms",
      0,
    ),
    ...extraOptions.egressSession,
  };

  const pool: QwpClientPoolOptions = {
    senderPoolMin: optionalInteger(
      value("sender_pool_min"),
      "sender_pool_min",
      0,
    ),
    senderPoolMax: optionalInteger(
      value("sender_pool_max"),
      "sender_pool_max",
      1,
    ),
    queryPoolMin: optionalInteger(value("query_pool_min"), "query_pool_min", 0),
    queryPoolMax: optionalInteger(value("query_pool_max"), "query_pool_max", 1),
    acquireTimeoutMs: optionalInteger(
      value("acquire_timeout_ms"),
      "acquire_timeout_ms",
      0,
    ),
    idleTimeoutMs: optionalInteger(
      value("idle_timeout_ms"),
      "idle_timeout_ms",
      0,
    ),
    maxLifetimeMs: optionalInteger(
      value("max_lifetime_ms"),
      "max_lifetime_ms",
      0,
    ),
    housekeepingIntervalMs: optionalInteger(
      value("housekeeper_interval_ms"),
      "housekeeper_interval_ms",
      100,
    ),
    ...extraOptions.pool,
  };
  validatePool(pool);

  const ingress: QwpNodeIngressOptions = {
    ...common,
    url: withPath(endpoints[0], "/write/v4"),
    failoverUrls: endpoints
      .slice(1)
      .map((endpoint) => withPath(endpoint, "/write/v4")),
    requestDurableAck:
      extraOptions.webSocket?.requestDurableAck ??
      optionalBoolean(value("request_durable_ack"), "request_durable_ack"),
    storeAndForward,
    senderId: validateSenderId(value("sender_id") ?? "default"),
  };
  const egress: QwpNodeEgressOptions = {
    ...common,
    url: withPath(endpoints[0], "/read/v1"),
    failoverUrls: endpoints
      .slice(1)
      .map((endpoint) => withPath(endpoint, "/read/v1")),
    target: optionalEnum(value("target"), "target", [
      "any",
      "primary",
      "replica",
    ] as const) as QwpTarget | undefined,
    zone: value("zone"),
    compression: optionalEnum(value("compression"), "compression", [
      "raw",
      "zstd",
      "auto",
    ] as const),
    compressionLevel: optionalInteger(
      value("compression_level"),
      "compression_level",
      1,
      22,
    ),
    maxBatchRows: optionalInteger(
      value("max_batch_rows"),
      "max_batch_rows",
      1,
      MAX_BATCH_ROWS,
    ),
    ...extraOptions.egress,
  };

  return {
    ingress,
    egress,
    sender,
    ingressSession,
    egressSession,
    pool,
    lazyConnect,
  };
}

function parseConfigurationString(configurationString: string): ParsedConfig {
  if (!configurationString) {
    throw new Error("QWP cluster configuration string is missing or empty");
  }
  const separator = configurationString.indexOf("::");
  if (separator < 0) {
    throw new Error(
      "Missing schema, QWP cluster configuration format: 'ws::addr=host:port;key=value'",
    );
  }
  const schema = configurationString.slice(0, separator);
  if (schema !== "ws" && schema !== "wss") {
    throw new Error(
      `QWP cluster configuration must use the ws or wss schema; got: '${schema}'`,
    );
  }

  const values = new Map<string, string[]>();
  for (const setting of splitSettings(configurationString, separator + 2)) {
    const equals = setting.indexOf("=");
    if (equals < 0) throw new Error(`Missing '=' sign in '${setting}'`);
    const rawKey = setting.slice(0, equals);
    const rawValue = setting.slice(equals + 1);
    validateConfigText(rawKey, rawValue);
    if (!QWP_SUPPORTED_CONFIG_KEYS.has(rawKey)) {
      const hint = RELOCATED_HINTS.get(rawKey);
      throw new Error(
        `unknown configuration key: ${rawKey}${hint ? ` ${hint}` : ""}`,
      );
    }
    const key =
      rawKey === "user" ? "username" : rawKey === "pass" ? "password" : rawKey;
    const existing = values.get(key);
    if (existing && key !== "addr") {
      throw new Error(`Duplicate QWP cluster configuration key: '${key}'`);
    }
    if (existing) existing.push(rawValue);
    else values.set(key, [rawValue]);
  }
  if (!values.has("addr")) {
    throw new Error("Invalid QWP cluster configuration: 'addr' is required");
  }
  return { schema, values };
}

function splitSettings(config: string, start: number): string[] {
  const settings: string[] = [];
  let setting = "";
  for (let i = start; i < config.length; i++) {
    const character = config[i];
    if (character !== ";") {
      setting += character;
      continue;
    }
    if (config[i + 1] === ";") {
      setting += ";";
      i++;
      continue;
    }
    if (setting) settings.push(setting);
    setting = "";
  }
  if (setting) settings.push(setting);
  return settings;
}

function validateConfigText(key: string, value: string): void {
  if (!key) throw new Error("QWP cluster configuration key must not be empty");
  if (!/^[a-z][a-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid QWP cluster configuration key: '${key}'`);
  }
  if (!value) {
    throw new Error(
      `Invalid QWP cluster configuration, value is not set for '${key}'`,
    );
  }
  for (let i = 0; i < value.length; i++) {
    const codePoint = value.codePointAt(i)!;
    if (codePoint < 0x20 || (codePoint > 0x7e && codePoint < 0xa0)) {
      throw new Error(
        `Invalid QWP cluster configuration, control characters are not allowed in '${key}'`,
      );
    }
  }
}

function parseEndpoints(parsed: ParsedConfig): URL[] {
  const endpoints: URL[] = [];
  for (const addressList of parsed.values.get("addr") ?? []) {
    for (const address of addressList.split(",")) {
      if (!address || address.trim() !== address) {
        throw new Error(`Invalid QWP cluster address entry: '${address}'`);
      }
      const authority = addressHasPort(address)
        ? address
        : `${address}:${DEFAULT_QWP_PORT}`;
      let endpoint: URL;
      try {
        endpoint = new URL(`${parsed.schema}://${authority}`);
      } catch {
        throw new Error(`Invalid QWP cluster address: '${address}'`);
      }
      if (
        !endpoint.hostname ||
        endpoint.username ||
        endpoint.password ||
        endpoint.pathname !== "/" ||
        endpoint.search ||
        endpoint.hash
      ) {
        throw new Error(`Invalid QWP cluster address: '${address}'`);
      }
      endpoints.push(endpoint);
    }
  }
  return endpoints;
}

function addressHasPort(address: string): boolean {
  if (address.startsWith("[")) {
    const closingBracket = address.indexOf("]");
    if (closingBracket < 0) {
      throw new Error(`Invalid QWP cluster address: '${address}'`);
    }
    if (closingBracket === address.length - 1) return false;
    if (address[closingBracket + 1] !== ":") {
      throw new Error(`Invalid QWP cluster address: '${address}'`);
    }
    validateAddressPort(address, address.slice(closingBracket + 2));
    return true;
  }
  const colons = address.match(/:/g)?.length ?? 0;
  if (colons > 1) {
    throw new Error(
      `Invalid QWP cluster address: '${address}'; IPv6 addresses must be enclosed in brackets`,
    );
  }
  if (colons === 0) return false;
  validateAddressPort(address, address.slice(address.indexOf(":") + 1));
  return true;
}

function validateAddressPort(address: string, port: string): void {
  if (!/^\d+$/.test(port)) {
    throw new Error(`Invalid QWP cluster address: '${address}'`);
  }
  const parsed = Number(port);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new RangeError(
      `Invalid QWP cluster address port: '${port}'; expected 1 through 65535`,
    );
  }
}

function withPath(endpoint: URL, path: string): URL {
  const result = new URL(endpoint);
  result.pathname = path;
  return result;
}

function validateAuthentication(
  values: ReadonlyMap<string, readonly string[]>,
): void {
  const username = values.get("username")?.[0];
  const password = values.get("password")?.[0];
  const token = values.get("token")?.[0];
  if ((username === undefined) !== (password === undefined)) {
    throw new Error(
      "QWP Basic authentication requires both 'username' and 'password'",
    );
  }
  if (token !== undefined && username !== undefined) {
    throw new Error(
      "QWP 'token' authentication cannot be combined with 'username'/'password'",
    );
  }
}

function createAuthorization(
  values: ReadonlyMap<string, readonly string[]>,
): string | undefined {
  const token = values.get("token")?.[0];
  if (token !== undefined) return `Bearer ${token}`;
  const username = values.get("username")?.[0];
  const password = values.get("password")?.[0];
  return username === undefined
    ? undefined
    : `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function validateTls(parsed: ParsedConfig): void {
  const tlsVerify = parsed.values.get("tls_verify")?.[0];
  const tlsRoots = parsed.values.get("tls_roots")?.[0];
  const tlsRootsPassword = parsed.values.get("tls_roots_password")?.[0];
  if (tlsVerify !== undefined) {
    optionalEnum(tlsVerify, "tls_verify", ["on", "unsafe_off"] as const);
  }
  if (
    parsed.schema === "ws" &&
    (tlsVerify !== undefined ||
      tlsRoots !== undefined ||
      tlsRootsPassword !== undefined)
  ) {
    throw new Error(
      "tls_verify, tls_roots, and tls_roots_password are only supported by the wss schema",
    );
  }
  if (tlsRootsPassword !== undefined && tlsRoots === undefined) {
    throw new Error("tls_roots_password requires tls_roots");
  }
  if (tlsRoots !== undefined && tlsVerify === "unsafe_off") {
    throw new Error(
      "tls_roots cannot be combined with tls_verify=unsafe_off; remove tls_verify to use custom roots, or remove tls_roots to disable certificate validation",
    );
  }
}

function createTlsAgent(parsed: ParsedConfig): HttpsAgent | undefined {
  const tlsVerify = parsed.values.get("tls_verify")?.[0];
  const tlsRoots = parsed.values.get("tls_roots")?.[0];
  const tlsRootsPassword = parsed.values.get("tls_roots_password")?.[0];
  if (tlsVerify === undefined && tlsRoots === undefined) return undefined;
  const roots = tlsRoots ? readFileSync(tlsRoots) : undefined;
  return new HttpsAgent({
    ca: tlsRootsPassword === undefined ? roots : undefined,
    pfx: tlsRootsPassword === undefined ? undefined : roots,
    passphrase: tlsRootsPassword,
    rejectUnauthorized: tlsVerify !== "unsafe_off",
  });
}

function parseIngressReconnect(
  values: ReadonlyMap<string, readonly string[]>,
): QwpReconnectOptions | undefined {
  const reconnect: QwpReconnectOptions = {
    initialBackoffMs: optionalPositiveInteger(
      values.get("reconnect_initial_backoff_millis")?.[0],
      "reconnect_initial_backoff_millis",
    ),
    maxBackoffMs: optionalPositiveInteger(
      values.get("reconnect_max_backoff_millis")?.[0],
      "reconnect_max_backoff_millis",
    ),
    maxDurationMs: optionalPositiveInteger(
      values.get("reconnect_max_duration_millis")?.[0],
      "reconnect_max_duration_millis",
    ),
    maxFrameRejections: optionalInteger(
      values.get("max_frame_rejections")?.[0],
      "max_frame_rejections",
      1,
    ),
    poisonMinEscalationWindowMs: optionalInteger(
      values.get("poison_min_escalation_window_millis")?.[0],
      "poison_min_escalation_window_millis",
      0,
    ),
  };
  return hasDefinedValue(reconnect) ? reconnect : undefined;
}

function parseEgressReconnect(
  values: ReadonlyMap<string, readonly string[]>,
): QwpReconnectOptions | false | undefined {
  const failover = optionalBoolean(values.get("failover")?.[0], "failover");
  const reconnect: QwpReconnectOptions = {
    maxAttempts: optionalInteger(
      values.get("failover_max_attempts")?.[0],
      "failover_max_attempts",
      1,
    ),
    initialBackoffMs: optionalInteger(
      values.get("failover_backoff_initial_ms")?.[0],
      "failover_backoff_initial_ms",
      0,
    ),
    maxBackoffMs: optionalInteger(
      values.get("failover_backoff_max_ms")?.[0],
      "failover_backoff_max_ms",
      0,
    ),
    maxDurationMs: optionalInteger(
      values.get("failover_max_duration_ms")?.[0],
      "failover_max_duration_ms",
      0,
    ),
  };
  validateReconnectBounds(reconnect, "QWP egress failover");
  if (failover === false) return false;
  // The Java facade defaults egress failover to on for cluster strings.
  return failover === true || hasDefinedValue(reconnect)
    ? reconnect
    : undefined;
}

function parseStoreAndForward(
  values: ReadonlyMap<string, readonly string[]>,
  fallbackDirectory?: string,
  initialConnectMode?: "off" | "sync" | "async",
): QwpNodeStoreAndForwardOptions | undefined {
  const directory = values.get("sf_dir")?.[0] ?? fallbackDirectory;
  if (!directory) return undefined;
  const durability = optionalEnum(
    values.get("sf_durability")?.[0],
    "sf_durability",
    ["memory", "periodic", "append"] as const,
  );
  return {
    directory,
    maxBytes:
      optionalSize(
        values.get("sf_max_total_bytes")?.[0],
        "sf_max_total_bytes",
        1,
      ) ?? DEFAULT_SF_MAX_TOTAL_BYTES,
    maxSegmentBytes:
      optionalSize(
        values.get("sf_max_segment_bytes")?.[0],
        "sf_max_segment_bytes",
        1,
      ) ?? DEFAULT_SF_MAX_SEGMENT_BYTES,
    durability: durability ?? "memory",
    checkpointIntervalMs: optionalInteger(
      values.get("sf_sync_interval_millis")?.[0],
      "sf_sync_interval_millis",
      0,
    ),
    backpressurePolicy: "wait",
    appendDeadlineMs:
      optionalPositiveInteger(
        values.get("sf_append_deadline_millis")?.[0],
        "sf_append_deadline_millis",
      ) ?? DEFAULT_SF_APPEND_DEADLINE_MS,
    initialConnectMode,
    catchUpCapGapMinEscalationWindowMs: optionalInteger(
      values.get("catch_up_cap_gap_min_escalation_window_millis")?.[0],
      "catch_up_cap_gap_min_escalation_window_millis",
      0,
    ),
    drainOrphans: optionalBoolean(
      values.get("drain_orphans")?.[0],
      "drain_orphans",
      true,
    ),
    maxBackgroundDrainers: optionalInteger(
      values.get("max_background_drainers")?.[0],
      "max_background_drainers",
      1,
    ),
  };
}

function validateStoreAndForwardDependencies(
  values: ReadonlyMap<string, readonly string[]>,
  storeAndForward: QwpNodeStoreAndForwardOptions | undefined,
): void {
  const sfOnlyKeys = [
    "catch_up_cap_gap_min_escalation_window_millis",
    "drain_orphans",
    "max_background_drainers",
    "sf_durability",
    "sf_sync_interval_millis",
  ];
  const configured = sfOnlyKeys.find((key) => values.has(key));
  if (configured && !storeAndForward) {
    throw new Error(`QWP '${configured}' requires an sf_dir`);
  }
  if (
    storeAndForward?.checkpointIntervalMs !== undefined &&
    storeAndForward.durability !== "periodic"
  ) {
    throw new Error(
      "QWP sf_sync_interval_millis requires sf_durability=periodic",
    );
  }
  validateReconnectBounds(
    parseIngressReconnect(values),
    "QWP ingress reconnect",
  );
  validateReconnectBounds(parseEgressReconnect(values), "QWP egress failover");
}

function resolveInitialConnectMode(
  values: ReadonlyMap<string, readonly string[]>,
  lazyConnect: boolean,
): "off" | "sync" | "async" {
  const explicit = optionalInitialConnectMode(
    values.get("initial_connect_retry")?.[0],
  );
  if (explicit !== undefined) return explicit;
  if (lazyConnect) return "async";
  return values.has("reconnect_initial_backoff_millis") ||
    values.has("reconnect_max_backoff_millis") ||
    values.has("reconnect_max_duration_millis")
    ? "sync"
    : "off";
}

function validateSenderId(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(
      "sender_id must contain only letters, digits, underscores, and hyphens",
    );
  }
  return value;
}

function validateReconnectBounds(
  reconnect: QwpReconnectOptions | false | undefined,
  name: string,
): void {
  if (!reconnect) return;
  const initialBackoffMs = reconnect.initialBackoffMs ?? 100;
  const maxBackoffMs = reconnect.maxBackoffMs ?? 5_000;
  if (maxBackoffMs < initialBackoffMs) {
    throw new RangeError(
      `${name} maximum backoff must be greater than or equal to its initial backoff`,
    );
  }
}

function validatePool(pool: QwpClientPoolOptions): void {
  const senderPoolMin = pool.senderPoolMin ?? 1;
  const senderPoolMax = pool.senderPoolMax ?? 4;
  const queryPoolMin = pool.queryPoolMin ?? 1;
  const queryPoolMax = pool.queryPoolMax ?? 4;
  validatePoolBounds(senderPoolMin, senderPoolMax, "sender");
  validatePoolBounds(queryPoolMin, queryPoolMax, "query");
  for (const [name, value] of [
    ["acquireTimeoutMs", pool.acquireTimeoutMs],
    ["idleTimeoutMs", pool.idleTimeoutMs],
    ["maxLifetimeMs", pool.maxLifetimeMs],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new RangeError(`${name} must be a non-negative number`);
    }
  }
  if (
    pool.housekeepingIntervalMs !== undefined &&
    (!Number.isFinite(pool.housekeepingIntervalMs) ||
      pool.housekeepingIntervalMs < 100)
  ) {
    throw new RangeError("housekeepingIntervalMs must be at least 100");
  }
}

function validatePoolBounds(
  minimum: number,
  maximum: number,
  resource: string,
): void {
  if (!Number.isSafeInteger(minimum) || minimum < 0) {
    throw new RangeError(`${resource}PoolMin must be a non-negative integer`);
  }
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new RangeError(`${resource}PoolMax must be a positive integer`);
  }
  if (minimum > maximum) {
    throw new RangeError(`${resource}PoolMin cannot exceed ${resource}PoolMax`);
  }
}

function optionalInitialConnectMode(
  value: string | undefined,
): "off" | "sync" | "async" | undefined {
  if (value === undefined) return undefined;
  switch (value) {
    case "off":
    case "false":
      return "off";
    case "on":
    case "true":
    case "sync":
      return "sync";
    case "async":
      return "async";
    default:
      throw new Error(
        `Invalid initial_connect_retry: '${value}', accepted values: 'off', 'sync', 'async'`,
      );
  }
}

function optionalBoolean(
  value: string | undefined,
  key: string,
  acceptTrueFalse = false,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "on" || (acceptTrueFalse && value === "true")) return true;
  if (value === "off" || (acceptTrueFalse && value === "false")) return false;
  throw new Error(
    `Invalid ${key}: '${value}', accepted values: 'on', 'off'${
      acceptTrueFalse ? ", 'true', 'false'" : ""
    }`,
  );
}

function optionalInteger(
  value: string | undefined,
  key: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${key}: '${value}'`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(
      `${key} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function optionalPositiveInteger(
  value: string | undefined,
  key: string,
): number | undefined {
  return optionalInteger(value, key, 1);
}

function optionalSize(
  value: string | undefined,
  key: string,
  minimum: number,
  acceptOff = false,
): number | undefined {
  if (value === undefined) return undefined;
  if (acceptOff && value === "off") return 0;
  const match = /^(\d+)([kmgt])?$/i.exec(value);
  if (!match) throw new Error(`Invalid ${key}: '${value}'`);
  const exponent = match[2]
    ? ["k", "m", "g", "t"].indexOf(match[2].toLowerCase()) + 1
    : 0;
  const parsed = Number(match[1]) * 1024 ** exponent;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new RangeError(
      `${key} must be a safe integer of at least ${minimum}`,
    );
  }
  return parsed;
}

function optionalEnum<const T extends readonly string[]>(
  value: string | undefined,
  key: string,
  accepted: T,
): T[number] | undefined {
  if (value === undefined) return undefined;
  if ((accepted as readonly string[]).includes(value)) {
    return value as T[number];
  }
  throw new Error(
    `Invalid ${key}: '${value}', accepted values: ${accepted.map((item) => `'${item}'`).join(", ")}`,
  );
}

function hasDefinedValue(value: object): boolean {
  return Object.values(value).some((item) => item !== undefined);
}
