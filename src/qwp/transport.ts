export interface QwpConnectionCloseInfo {
  code: number;
  reason: string;
  wasClean: boolean;
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

  send(payload: Uint8Array): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}

export interface QwpWebSocketConnectOptions {
  url: string | URL;
  protocols?: string | string[];
  connectTimeoutMs?: number;
}

export type QwpConnectionFactory = () => Promise<QwpBinaryConnection>;
