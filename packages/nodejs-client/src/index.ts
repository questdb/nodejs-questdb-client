/**
 * The QuestDB JavaScript client.
 *
 * This entry point targets Node.js. Use `@questdb/browser-client` for the browser build.
 * @packageDocumentation
 */

export { Sender } from "./sender";
export { SenderOptions } from "./options";
export type { ExtraOptions, QwpExtraOptions } from "./options";
export type { TimestampUnit } from "./utils";
export type { SenderBuffer } from "./buffer";
export { createBuffer } from "./buffer";
export { SenderBufferV1 } from "./buffer/bufferv1";
export { SenderBufferV2 } from "./buffer/bufferv2";
export { SenderBufferV3 } from "./buffer/bufferv3";
export type { SenderTransport } from "./transport";
export { createTransport } from "./transport";
export { TcpTransport } from "./transport/tcp";
export { HttpTransport } from "./transport/http/stdlib";
export { UndiciTransport } from "./transport/http/undici";
export type { Logger } from "./logging";
export { bigintToTwosComplementBytes } from "./utils";
// QWP: the shared protocol barrel plus the Node.js runtime adapter. The adapter
// is re-exported by name rather than with `export *` because qwp.ts also
// exports internal helpers: the ingress-session factory behind its senders and
// a raw WebSocket connector for tests.
export * from "../../client-core/src/qwp";
export {
  QWP_ORPHAN_DRAIN_EVENT_KIND,
  QWP_ORPHAN_FAILED_SENTINEL,
  QWP_SF_BACKPRESSURE_POLICY,
  QWP_SF_DURABILITY,
  QwpNodeFileReplayStore,
  QwpReplayStoreAppendTimeoutError,
  QwpReplayStoreBatchTooLargeError,
  QwpReplayStoreCheckpointError,
  QwpReplayStoreCorruptionError,
  QwpReplayStoreError,
  QwpReplayStoreFullError,
  QwpReplayStoreLockLostError,
  QwpReplayStoreLockUnprovableError,
  QwpReplayStoreLockedError,
  QwpReplayStoreQuarantinedError,
  QwpReplayStoreSegmentTooLargeError,
  QwpUdpDatagramTooLargeError,
  QwpVersionMismatchError,
  connectQwpNodeClient,
  connectQwpNodeEgress,
  connectQwpNodeSender,
  connectQwpNodeUdpSender,
  createQwpNodeClient,
  createQwpNodeSender,
  createQwpNodeUdpSender,
  parseQwpNodeClientConfig,
  retryQwpNodeOrphanSlot,
} from "./qwp";
export type {
  QwpNodeClientConfigOptions,
  QwpNodeClientOptions,
  QwpNodeEgressOptions,
  QwpNodeFileReplayStoreMetrics,
  QwpNodeFileReplayStoreOptions,
  QwpNodeIngressOptions,
  QwpNodeOrphanDrainEvent,
  QwpNodeOrphanDrainEventKind,
  QwpNodeOrphanDrainerMetrics,
  QwpNodeReplayDataLossReport,
  QwpNodeReplayRecoveryEvent,
  QwpNodeStoreAndForwardOptions,
  QwpNodeUdpOptions,
  QwpNodeUdpSocketLike,
  QwpNodeUpgradeRejection,
  QwpNodeWebSocketOptions,
  QwpSfBackpressurePolicy,
  QwpSfDurability,
  QwpWebSocketLike,
} from "./qwp";
