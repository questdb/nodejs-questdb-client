import {
  decodeQwpEgressMessage,
  QWP_SERVER_ROLE,
  QwpProtocolError,
} from "../core";
import {
  QwpBinaryConnection,
  QwpConnectionFactory,
  QwpSendClosedError,
} from "../transport";
import {
  createQwpFailoverConnectionFactory,
  QwpFailoverSelectionOptions,
  QwpValidatedConnection,
} from "./failover";

/**
 * Creates an egress endpoint walker that validates authoritative SERVER_INFO
 * topology before exposing a connection. Reading the frame here works in both
 * Node and browsers; the frame is replayed to the normal session consumer.
 */
export function createQwpEgressFailoverConnectionFactory(
  preferredUrl: string | URL,
  failoverUrls: readonly (string | URL)[] | undefined,
  connect: (
    endpoint: string | URL,
    signal?: AbortSignal,
  ) => Promise<QwpBinaryConnection>,
  routing: QwpFailoverSelectionOptions,
  serverInfoTimeoutMs: number,
): QwpConnectionFactory {
  return createQwpFailoverConnectionFactory(
    preferredUrl,
    failoverUrls,
    connect,
    {
      ...routing,
      validateConnection: (connection) =>
        readAndReplayServerInfo(connection, serverInfoTimeoutMs),
    },
  );
}

async function readAndReplayServerInfo(
  connection: QwpBinaryConnection,
  timeoutMs: number,
): Promise<QwpValidatedConnection> {
  const iterator = connection.messages[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("timed out waiting for QWP SERVER_INFO")),
      timeoutMs,
    );
  });
  try {
    const result = await Promise.race([iterator.next(), timeout]);
    if (result.done) {
      throw new QwpSendClosedError(await connection.closed);
    }
    const serverInfo = decodeQwpEgressMessage(result.value);
    if (serverInfo.kind !== "server-info") {
      throw new QwpProtocolError(
        "QWP egress connection did not begin with SERVER_INFO",
      );
    }
    const serverRole = serverRoleName(serverInfo.role);
    const serverZone =
      serverInfo.zoneId ?? connection.handshake.serverZone ?? undefined;
    return {
      connection: prependMessage(connection, result.value, iterator, {
        serverRole,
        serverZone,
      }),
      serverRole,
      serverZone,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function serverRoleName(role: number): string {
  switch (role) {
    case QWP_SERVER_ROLE.STANDALONE:
      return "STANDALONE";
    case QWP_SERVER_ROLE.PRIMARY:
      return "PRIMARY";
    case QWP_SERVER_ROLE.REPLICA:
      return "REPLICA";
    case QWP_SERVER_ROLE.PRIMARY_CATCHUP:
      return "PRIMARY_CATCHUP";
    default:
      return `UNKNOWN(${role})`;
  }
}

function prependMessage(
  connection: QwpBinaryConnection,
  first: Uint8Array,
  iterator: AsyncIterator<Uint8Array>,
  topology: { readonly serverRole: string; readonly serverZone?: string },
): QwpBinaryConnection {
  let consumed = false;
  const messages: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      if (consumed) {
        throw new QwpProtocolError(
          "QWP connection messages already have a consumer",
        );
      }
      consumed = true;
      yield first;
      while (true) {
        const result = await iterator.next();
        if (result.done) return;
        yield result.value;
      }
    },
  };
  const wrapped: QwpBinaryConnection = {
    messages,
    closed: connection.closed,
    handshake: { ...connection.handshake, ...topology },
    endpoint: connection.endpoint,
    get ingressSymbolDictionary() {
      return connection.ingressSymbolDictionary;
    },
    get ingressDeltaSymbolDictionaryEnabled() {
      return connection.ingressDeltaSymbolDictionaryEnabled;
    },
    send: (payload) => connection.send(payload),
    close: (code, reason) => connection.close(code, reason),
  };
  if (connection.ping) wrapped.ping = () => connection.ping!();
  if (connection.getIngressMetrics) {
    wrapped.getIngressMetrics = () => connection.getIngressMetrics!();
  }
  return wrapped;
}
