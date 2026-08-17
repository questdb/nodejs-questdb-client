export interface QwpConnectionCloseInfo {
  code: number;
  reason: string;
  wasClean: boolean;
}

export const QWP_UPGRADE_ERROR_KIND = {
  AUTHENTICATION: "authentication",
  ROLE_REJECTED: "role-rejected",
  HTTP_REJECTED: "http-rejected",
  VERSION_MISMATCH: "version-mismatch",
  CAPABILITY_MISMATCH: "capability-mismatch",
  TIMEOUT: "timeout",
  TRANSPORT: "transport",
  /** Browser WebSocket APIs do not expose the rejected HTTP upgrade. */
  OPAQUE: "opaque",
} as const;

export type QwpUpgradeErrorKind =
  (typeof QWP_UPGRADE_ERROR_KIND)[keyof typeof QWP_UPGRADE_ERROR_KIND];

export interface QwpUpgradeErrorDetails {
  kind: QwpUpgradeErrorKind;
  /** Whether a later retry against the configured endpoint set may recover. */
  retryable?: boolean;
  /** Whether failover code should try another endpoint before surfacing this. */
  tryNextEndpoint?: boolean;
  url?: string | URL;
  statusCode?: number;
  statusMessage?: string;
  serverRole?: string;
  serverZone?: string;
  closeCode?: number;
  cause?: unknown;
}

/** A failure while establishing or validating a QWP WebSocket upgrade. */
export class QwpUpgradeError extends Error {
  readonly kind: QwpUpgradeErrorKind;
  readonly retryable?: boolean;
  readonly tryNextEndpoint?: boolean;
  readonly url?: string | URL;
  readonly statusCode?: number;
  readonly statusMessage?: string;
  readonly serverRole?: string;
  readonly serverZone?: string;
  readonly closeCode?: number;
  readonly cause?: unknown;

  constructor(message: string, details: QwpUpgradeErrorDetails) {
    super(message);
    this.name = "QwpUpgradeError";
    this.kind = details.kind;
    this.retryable = details.retryable;
    this.tryNextEndpoint = details.tryNextEndpoint;
    this.url = details.url;
    this.statusCode = details.statusCode;
    this.statusMessage = details.statusMessage;
    this.serverRole = details.serverRole;
    this.serverZone = details.serverZone;
    this.closeCode = details.closeCode;
    this.cause = details.cause;
  }

  /** True for a 421 response from a read-only replica. */
  get isTopologicalRoleReject(): boolean {
    return (
      this.kind === QWP_UPGRADE_ERROR_KIND.ROLE_REJECTED &&
      this.serverRole?.toUpperCase() === "REPLICA"
    );
  }

  /** True for a 421 response from a primary still completing catch-up. */
  get isTransientRoleReject(): boolean {
    return (
      this.kind === QWP_UPGRADE_ERROR_KIND.ROLE_REJECTED &&
      this.serverRole?.toUpperCase() === "PRIMARY_CATCHUP"
    );
  }
}

/** Metadata negotiated during the QWP WebSocket upgrade. */
export interface QwpHandshakeMetadata {
  /** QWP protocol version selected by the server. */
  readonly qwpVersion: number;
  /** Server's hard ingress WebSocket-payload cap, when advertised. */
  readonly maxBatchSizeBytes?: number;
  /** Server-selected egress content encoding, when advertised. */
  readonly contentEncoding?: string;
  /** Whether the server confirmed durable-ACK support. */
  readonly durableAckEnabled?: boolean;
  /** Server role advertised on a successful upgrade, when available. */
  readonly serverRole?: string;
}

/**
 * Normalized binary connection consumed by QWP sessions.
 *
 * Adapters buffer messages until the single async iterator consumes them, so
 * unsolicited frames such as egress SERVER_INFO cannot race session startup.
 */
export interface QwpBinaryConnection {
  readonly messages: AsyncIterable<Uint8Array>;
  readonly closed: Promise<QwpConnectionCloseInfo>;
  readonly handshake: QwpHandshakeMetadata;

  send(payload: Uint8Array): Promise<void>;
  /** Sends an RFC 6455 PING when the underlying runtime supports it. */
  ping?(): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}

export interface QwpWebSocketConnectOptions {
  url: string | URL;
  protocols?: string | string[];
  connectTimeoutMs?: number;
}

export type QwpConnectionFactory = () => Promise<QwpBinaryConnection>;
