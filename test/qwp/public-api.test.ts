import { describe, expect, it } from "vitest";

import * as browser from "../../packages/browser-client/src";
import * as node from "../../packages/nodejs-client/src";
import * as shared from "../../packages/client-core/src/qwp";

/**
 * Every runtime name both published packages re-export from the shared QWP
 * barrel. Exhaustive: the assertions below compare it with the module's own
 * export list in both directions, so an accidental addition fails here rather
 * than shipping as public API nobody meant to support.
 */
const sharedRuntimeContract = [
  "QWP_COLUMN_TYPE",
  "QWP_COMPRESSION_CODEC",
  "QWP_DECIMAL_MAX_SCALE",
  "QWP_DEFAULT_EGRESS_BUFFER_POOL_SIZE",
  "QWP_DEFAULT_EGRESS_INITIAL_CREDIT",
  "QWP_DEFAULT_EGRESS_SERVER_INFO_TIMEOUT_MS",
  "QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL",
  "QWP_EGRESS_CAPABILITY",
  "QWP_EGRESS_MESSAGE",
  "QWP_EGRESS_PATH",
  "QWP_ENCODING_GORILLA",
  "QWP_ENCODING_UNCOMPRESSED",
  "QWP_FLAG_DEFER_COMMIT",
  "QWP_FLAG_DELTA_SYMBOL_DICTIONARY",
  "QWP_FLAG_DURABLE_ACK_POLL",
  "QWP_FLAG_GORILLA",
  "QWP_FLAG_ZSTD",
  "QWP_HEADER_SIZE",
  "QWP_INGRESS_PATH",
  "QWP_INGRESS_PROGRESS_KIND",
  "QWP_INGRESS_SERVER_INFO_CAPABILITY",
  "QWP_INITIAL_CONNECT_MODE",
  "QWP_MAGIC",
  "QWP_MAX_ARRAY_DIMENSIONS",
  "QWP_MAX_ARRAY_DIMENSION_LENGTH",
  "QWP_MAX_BATCH_ROWS_UPPER_BOUND",
  "QWP_MAX_CELLS_PER_BATCH",
  "QWP_MAX_COLUMNS_PER_TABLE",
  "QWP_MAX_COLUMN_NAME_LENGTH",
  "QWP_MAX_IDENTIFIER_BYTES",
  "QWP_MAX_ROWS_PER_TABLE",
  "QWP_MAX_SYMBOL_DICTIONARY_SIZE",
  "QWP_MAX_TABLES_PER_FRAME",
  "QWP_MAX_TABLE_NAME_LENGTH",
  "QWP_MAX_ZSTD_DECOMPRESSED_SIZE",
  "QWP_QUERY_FLAG_RESET_DICTIONARY",
  "QWP_RECONNECT_EVENT_KIND",
  "QWP_RESET_MASK_DICTIONARY",
  "QWP_SENDER_ERROR_CATEGORY",
  "QWP_SENDER_ERROR_POLICY",
  "QWP_SERVER_ROLE",
  "QWP_STATUS",
  "QWP_TARGET",
  "QWP_UPGRADE_ERROR_KIND",
  "QWP_UPGRADE_TIMEOUT_PHASE",
  "QWP_VERSION",
  "QWP_ZSTD_MAX_COMPRESSION_LEVEL",
  "QWP_ZSTD_MIN_COMPRESSION_LEVEL",
  "QwpBatchTooLargeError",
  "QwpBindValues",
  "QwpByteReader",
  "QwpByteWriter",
  "QwpClient",
  "QwpClientClosedError",
  "QwpDurableAckUnavailableError",
  "QwpEgressQuery",
  "QwpEgressQueryAbandonedError",
  "QwpEgressQueryCancelTimeoutError",
  "QwpEgressQueryError",
  "QwpEgressQueryTimeoutError",
  "QwpEgressReplayRequiredError",
  "QwpEgressSession",
  "QwpEgressSessionClosedError",
  "QwpFailoverError",
  "QwpIngressAckAbandonedError",
  "QwpIngressAckTimeoutError",
  "QwpIngressNackError",
  "QwpIngressSession",
  "QwpIngressSessionClosedError",
  "QwpMemoryReplayAppendTimeoutError",
  "QwpMemoryReplayBatchTooLargeError",
  "QwpMemoryReplayFrameTooLargeError",
  "QwpPoolAcquireTimeoutError",
  "QwpPoolResourceError",
  "QwpProtocolError",
  "QwpQueryLease",
  "QwpReconnectExhaustedError",
  "QwpReplayDictionaryError",
  "QwpReplayDictionaryPersistenceError",
  "QwpReplayRejectedError",
  "QwpResultBatch",
  "QwpResultBatchDecoder",
  "QwpResultBatchView",
  "QwpResultColumnView",
  "QwpResultRowView",
  "QwpRoleMismatchError",
  "QwpSendClosedError",
  "QwpSendError",
  "QwpSendTimeoutError",
  "QwpSender",
  "QwpSenderCloseTimeoutError",
  "QwpSymbolDictionary",
  "QwpTableBuffer",
  "QwpTableWriter",
  "QwpUnrecoverableReplayDictionaryError",
  "QwpUpgradeError",
  "QwpWriterRowError",
  "addQwpDurableAckWebSocketProtocol",
  "binary",
  "bool",
  "byte",
  "char",
  "concatBytes",
  "createQwpDataLossSenderError",
  "createQwpProtocolViolationSenderError",
  "createQwpSenderError",
  "date",
  "decimal128",
  "decimal256",
  "decimal64",
  "decodeQwpContentEncoding",
  "decodeQwpEgressMessage",
  "decodeQwpFrame",
  "decodeQwpIngressResponse",
  "decodeQwpIngressServerInfo",
  "decodeQwpIngressSymbolDictionaryDelta",
  "decodeQwpVarint",
  "decodeUtf8",
  "decompressQwpZstdFrame",
  "defaultQwpSenderErrorHandler",
  "designatedTimestamp",
  "double",
  "doubleArray",
  "encodeQwpAcceptEncoding",
  "encodeQwpBinds",
  "encodeQwpCancel",
  "encodeQwpCredit",
  "encodeQwpDurableAckPollFrame",
  "encodeQwpFrame",
  "encodeQwpGorilla",
  "encodeQwpIngressCommitFrame",
  "encodeQwpIngressFrame",
  "encodeQwpIngressSymbolDictionaryFrame",
  "encodeQwpQueryRequest",
  "encodeQwpVarint",
  "encodeUtf8",
  "flattenQwpArray",
  "float32",
  "float64",
  "geohash",
  "int32",
  "int64",
  "ipv4",
  "isQwpDurableAckWebSocketProtocol",
  "long",
  "long256",
  "longArray",
  "qwpDefaultSenderErrorPolicy",
  "qwpGorillaSize",
  "qwpSenderErrorCategory",
  "qwpVarintSize",
  "readQwpVarint",
  "readQwpVarintNumber",
  "short",
  "symbol",
  "timestamp",
  "utf8Length",
  "uuid",
  "varchar",
  "writeQwpFrameHeader",
  "writeQwpVarint",
] as const;

/** Runtime names `@questdb/browser-client` adds to the shared barrel. */
const browserRuntimeContract = [
  "QwpBrowserSessionBootstrapError",
  "bootstrapQwpBrowserSession",
  "connectQwpBrowserClient",
  "connectQwpBrowserEgress",
  "connectQwpBrowserIngress",
  "connectQwpBrowserSender",
  "connectQwpBrowserWebSocket",
  "createQwpBrowserClient",
  "createQwpBrowserConnectionFactory",
  "createQwpBrowserSender",
] as const;

/** QWP runtime names `@questdb/nodejs-client` adds to the shared barrel. */
const nodeRuntimeContract = [
  "QWP_ORPHAN_DRAIN_EVENT_KIND",
  "QWP_ORPHAN_FAILED_SENTINEL",
  "QWP_SF_BACKPRESSURE_POLICY",
  "QWP_SF_DURABILITY",
  "QwpNodeFileReplayStore",
  "QwpNodeOrphanDrainer",
  "QwpNodeUdpSession",
  "QwpReplayStoreAppendTimeoutError",
  "QwpReplayStoreCheckpointError",
  "QwpReplayStoreCorruptionError",
  "QwpReplayStoreError",
  "QwpReplayStoreFullError",
  "QwpReplayStoreLockLostError",
  "QwpReplayStoreLockUnprovableError",
  "QwpReplayStoreLockedError",
  "QwpReplayStoreQuarantinedError",
  "QwpReplayStoreSegmentTooLargeError",
  "QwpUdpDatagramTooLargeError",
  "QwpVersionMismatchError",
  "connectQwpNodeClient",
  "connectQwpNodeEgress",
  "connectQwpNodeIngress",
  "connectQwpNodeSender",
  "connectQwpNodeUdp",
  "connectQwpNodeUdpSender",
  "connectQwpNodeWebSocket",
  "createQwpNodeClient",
  "createQwpNodeConnectionFactory",
  "createQwpNodeSender",
  "createQwpNodeUdpSender",
  "parseQwpNodeClientConfig",
  "retryQwpNodeOrphanSlot",
  "scanQwpNodeOrphanSlots",
] as const;

/**
 * The pre-QWP ILP surface, which the Node root exports alongside QWP. Pinned
 * here because nothing else asserts it: `pnpm typecheck` follows source paths
 * rather than the barrel, so a dropped re-export line reaches npm silently.
 */
const ilpRuntimeContract = [
  "HttpTransport",
  "Sender",
  "SenderBufferV1",
  "SenderBufferV2",
  "SenderBufferV3",
  "SenderOptions",
  "TcpTransport",
  "UndiciTransport",
  "bigintToTwosComplementBytes",
  "createBuffer",
  "createTransport",
] as const;

/**
 * Compares an entry point's runtime exports with its contract in BOTH
 * directions.
 *
 * A presence-only loop pinned nothing against accidental additions: both roots
 * re-export the whole shared barrel with `export *`, so any new `export` under
 * `_qwp/**` landed on two published packages -- and under semver -- without a
 * single test noticing. Nothing else closes that: package-boundaries.e2e.ts
 * pins the `exports` subpaths in package.json, not the module's own names, and
 * public-api-contract.ts pins types rather than the export list.
 *
 * Widening the surface is therefore a deliberate edit here, and the diff on
 * these arrays is the review record of what became public.
 */
function assertRuntimeContract(
  module: Record<string, unknown>,
  ...contracts: readonly (readonly string[])[]
): void {
  const expected = contracts.flat().sort();
  for (const name of expected) {
    expect(module, `missing public runtime export ${name}`).toHaveProperty(
      name,
    );
  }
  expect(
    Object.keys(module).sort(),
    "undeclared public runtime export; add it to the contract deliberately",
  ).toEqual(expected);
}

describe("QWP public API contract", () => {
  it("keeps the documented shared runtime exports", () => {
    assertRuntimeContract(shared, sharedRuntimeContract);
  });

  it("keeps the documented browser runtime exports", () => {
    assertRuntimeContract(
      browser,
      sharedRuntimeContract,
      browserRuntimeContract,
    );
  });

  it("keeps the documented Node.js runtime exports", () => {
    assertRuntimeContract(
      node,
      sharedRuntimeContract,
      nodeRuntimeContract,
      ilpRuntimeContract,
    );
  });
});
