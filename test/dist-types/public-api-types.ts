/**
 * Exhaustive consumer contract for erased public names in the built packages.
 *
 * The three dist-type tsconfigs compile this file against ESM declarations,
 * CJS declarations, and TypeScript 4.9. Keep every type explicit so a missing
 * declaration export fails independently of runtime bundle tests.
 */
export type {
  ExtraOptions,
  Logger,
  QwpArrayValue,
  QwpBinaryConnection,
  QwpBindSetter,
  QwpBindType,
  QwpCacheResetMessage,
  QwpClientFactories,
  QwpClientMetrics,
  QwpClientPoolOptions,
  QwpColumnBuffer,
  QwpColumnType,
  QwpConnectionCloseInfo,
  QwpConnectionFactory,
  QwpDecimalInput,
  QwpDecimalValue,
  QwpDoubleArrayInput,
  QwpEgressCompression,
  QwpEgressMessage,
  QwpEgressMetrics,
  QwpEgressQueryOptions,
  QwpEgressReconnectOptions,
  QwpEgressReplayResetEvent,
  QwpEgressSessionOptions,
  QwpEgressTransportMetrics,
  QwpEgressViewCallbackControl,
  QwpEgressViewQuery,
  QwpEncodedBinds,
  QwpExecDoneMessage,
  QwpExtraOptions,
  QwpFailoverAttempt,
  QwpFrame,
  QwpFrameHeader,
  QwpGeohashInput,
  QwpGeohashValue,
  QwpHandshakeMetadata,
  QwpIngressEncodeOptions,
  QwpIngressErrorEvent,
  QwpIngressMetrics,
  QwpIngressProgressEvent,
  QwpIngressProgressKind,
  QwpIngressReconnectOptions,
  QwpIngressReplayRecord,
  QwpIngressReplayReference,
  QwpIngressReplayStore,
  QwpIngressResponse,
  QwpIngressServerInfo,
  QwpIngressSessionOptions,
  QwpIngressSymbolDictionaryDelta,
  QwpIngressTableResult,
  QwpIngressTransportMetrics,
  QwpInitialConnectMode,
  QwpInt64,
  QwpIpv4Input,
  QwpLong256Input,
  QwpLong256Value,
  QwpLong256Words,
  QwpLongArrayInput,
  QwpNegotiatedEgressCompression,
  QwpNestedLongArray,
  QwpNestedNumberArray,
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
  QwpPoolSlotReservation,
  QwpQueryCompletion,
  QwpQueryErrorMessage,
  QwpQueryRequest,
  QwpReconnectEvent,
  QwpReconnectEventKind,
  QwpResourcePoolMetrics,
  QwpResultArrayValue,
  QwpResultBatchMessage,
  QwpResultBatchViewHandler,
  QwpResultColumn,
  QwpResultColumnSchema,
  QwpResultEndMessage,
  QwpResultRowViewCallback,
  QwpResultValue,
  QwpRoutingOptions,
  QwpSenderError,
  QwpSenderErrorCategory,
  QwpSenderErrorPolicy,
  QwpSenderErrorResponseContext,
  QwpSenderLogger,
  QwpSenderMetrics,
  QwpSenderOptions,
  QwpServerInfoMessage,
  QwpSfBackpressurePolicy,
  QwpSfDurability,
  QwpSymbolValue,
  QwpTarget,
  QwpTimestampUnit,
  QwpUpgradeErrorDetails,
  QwpUpgradeErrorKind,
  QwpUpgradeTimeoutPhase,
  QwpUuidInput,
  QwpUuidValue,
  QwpWebSocketConnectOptions,
  QwpWebSocketLike,
  QwpWriterColumn,
  QwpWriterColumnKind,
  QwpWriterRow,
  QwpWriterSchema,
  SenderBuffer,
  SenderTransport,
  TimestampUnit,
} from "@questdb/nodejs-client";

// Resolve the shared contract independently through the browser package.
export type {
  QwpArrayValue as BrowserQwpArrayValue,
  QwpBinaryConnection as BrowserQwpBinaryConnection,
  QwpBindSetter as BrowserQwpBindSetter,
  QwpBindType as BrowserQwpBindType,
  QwpBrowserClientEgressOptions,
  QwpBrowserClientIngressOptions,
  QwpBrowserClientOptions,
  QwpBrowserEgressOptions,
  QwpBrowserFetch,
  QwpBrowserIngressOptions,
  QwpBrowserSessionAuthentication,
  QwpBrowserSessionBootstrapConfig,
  QwpBrowserSessionBootstrapOptions,
  QwpBrowserSessionBootstrapResult,
  QwpBrowserWebSocketOptions,
  QwpCacheResetMessage as BrowserQwpCacheResetMessage,
  QwpClientFactories as BrowserQwpClientFactories,
  QwpClientMetrics as BrowserQwpClientMetrics,
  QwpClientPoolOptions as BrowserQwpClientPoolOptions,
  QwpColumnBuffer as BrowserQwpColumnBuffer,
  QwpColumnType as BrowserQwpColumnType,
  QwpConnectionCloseInfo as BrowserQwpConnectionCloseInfo,
  QwpConnectionFactory as BrowserQwpConnectionFactory,
  QwpDecimalInput as BrowserQwpDecimalInput,
  QwpDecimalValue as BrowserQwpDecimalValue,
  QwpDoubleArrayInput as BrowserQwpDoubleArrayInput,
  QwpEgressCompression as BrowserQwpEgressCompression,
  QwpEgressMessage as BrowserQwpEgressMessage,
  QwpEgressMetrics as BrowserQwpEgressMetrics,
  QwpEgressQueryOptions as BrowserQwpEgressQueryOptions,
  QwpEgressReconnectOptions as BrowserQwpEgressReconnectOptions,
  QwpEgressReplayResetEvent as BrowserQwpEgressReplayResetEvent,
  QwpEgressSessionOptions as BrowserQwpEgressSessionOptions,
  QwpEgressTransportMetrics as BrowserQwpEgressTransportMetrics,
  QwpEgressViewCallbackControl as BrowserQwpEgressViewCallbackControl,
  QwpEgressViewQuery as BrowserQwpEgressViewQuery,
  QwpEncodedBinds as BrowserQwpEncodedBinds,
  QwpExecDoneMessage as BrowserQwpExecDoneMessage,
  QwpFailoverAttempt as BrowserQwpFailoverAttempt,
  QwpFrame as BrowserQwpFrame,
  QwpFrameHeader as BrowserQwpFrameHeader,
  QwpGeohashInput as BrowserQwpGeohashInput,
  QwpGeohashValue as BrowserQwpGeohashValue,
  QwpHandshakeMetadata as BrowserQwpHandshakeMetadata,
  QwpIngressEncodeOptions as BrowserQwpIngressEncodeOptions,
  QwpIngressErrorEvent as BrowserQwpIngressErrorEvent,
  QwpIngressMetrics as BrowserQwpIngressMetrics,
  QwpIngressProgressEvent as BrowserQwpIngressProgressEvent,
  QwpIngressProgressKind as BrowserQwpIngressProgressKind,
  QwpIngressReconnectOptions as BrowserQwpIngressReconnectOptions,
  QwpIngressReplayRecord as BrowserQwpIngressReplayRecord,
  QwpIngressReplayReference as BrowserQwpIngressReplayReference,
  QwpIngressReplayStore as BrowserQwpIngressReplayStore,
  QwpIngressResponse as BrowserQwpIngressResponse,
  QwpIngressServerInfo as BrowserQwpIngressServerInfo,
  QwpIngressSessionOptions as BrowserQwpIngressSessionOptions,
  QwpIngressSymbolDictionaryDelta as BrowserQwpIngressSymbolDictionaryDelta,
  QwpIngressTableResult as BrowserQwpIngressTableResult,
  QwpIngressTransportMetrics as BrowserQwpIngressTransportMetrics,
  QwpInitialConnectMode as BrowserQwpInitialConnectMode,
  QwpInt64 as BrowserQwpInt64,
  QwpIpv4Input as BrowserQwpIpv4Input,
  QwpLong256Input as BrowserQwpLong256Input,
  QwpLong256Value as BrowserQwpLong256Value,
  QwpLong256Words as BrowserQwpLong256Words,
  QwpLongArrayInput as BrowserQwpLongArrayInput,
  QwpNegotiatedEgressCompression as BrowserQwpNegotiatedEgressCompression,
  QwpNestedLongArray as BrowserQwpNestedLongArray,
  QwpNestedNumberArray as BrowserQwpNestedNumberArray,
  QwpPoolSlotReservation as BrowserQwpPoolSlotReservation,
  QwpQueryCompletion as BrowserQwpQueryCompletion,
  QwpQueryErrorMessage as BrowserQwpQueryErrorMessage,
  QwpQueryRequest as BrowserQwpQueryRequest,
  QwpReconnectEvent as BrowserQwpReconnectEvent,
  QwpReconnectEventKind as BrowserQwpReconnectEventKind,
  QwpResourcePoolMetrics as BrowserQwpResourcePoolMetrics,
  QwpResultArrayValue as BrowserQwpResultArrayValue,
  QwpResultBatchMessage as BrowserQwpResultBatchMessage,
  QwpResultBatchViewHandler as BrowserQwpResultBatchViewHandler,
  QwpResultColumn as BrowserQwpResultColumn,
  QwpResultColumnSchema as BrowserQwpResultColumnSchema,
  QwpResultEndMessage as BrowserQwpResultEndMessage,
  QwpResultRowViewCallback as BrowserQwpResultRowViewCallback,
  QwpResultValue as BrowserQwpResultValue,
  QwpRoutingOptions as BrowserQwpRoutingOptions,
  QwpSenderError as BrowserQwpSenderError,
  QwpSenderErrorCategory as BrowserQwpSenderErrorCategory,
  QwpSenderErrorPolicy as BrowserQwpSenderErrorPolicy,
  QwpSenderErrorResponseContext as BrowserQwpSenderErrorResponseContext,
  QwpSenderLogger as BrowserQwpSenderLogger,
  QwpSenderMetrics as BrowserQwpSenderMetrics,
  QwpSenderOptions as BrowserQwpSenderOptions,
  QwpServerInfoMessage as BrowserQwpServerInfoMessage,
  QwpSymbolValue as BrowserQwpSymbolValue,
  QwpTarget as BrowserQwpTarget,
  QwpTimestampUnit as BrowserQwpTimestampUnit,
  QwpUpgradeErrorDetails as BrowserQwpUpgradeErrorDetails,
  QwpUpgradeErrorKind as BrowserQwpUpgradeErrorKind,
  QwpUpgradeTimeoutPhase as BrowserQwpUpgradeTimeoutPhase,
  QwpUuidInput as BrowserQwpUuidInput,
  QwpUuidValue as BrowserQwpUuidValue,
  QwpWebSocketConnectOptions as BrowserQwpWebSocketConnectOptions,
  QwpWebSocketLike as BrowserQwpWebSocketLike,
  QwpWriterColumn as BrowserQwpWriterColumn,
  QwpWriterColumnKind as BrowserQwpWriterColumnKind,
  QwpWriterRow as BrowserQwpWriterRow,
  QwpWriterSchema as BrowserQwpWriterSchema,
} from "@questdb/browser-client";

// The sender-to-transport session seam is internal. Neither built package may
// export it from its declarations.
import type * as NodeRoot from "@questdb/nodejs-client";
import type * as BrowserRoot from "@questdb/browser-client";
// @ts-expect-error QwpSenderSession is internal.
export type NodeSenderSession = NodeRoot.QwpSenderSession;
// @ts-expect-error QwpSenderSessionFactory is internal.
export type NodeSenderSessionFactory = NodeRoot.QwpSenderSessionFactory;
// @ts-expect-error QwpSenderSession is internal.
export type BrowserSenderSession = BrowserRoot.QwpSenderSession;
// @ts-expect-error QwpSenderSessionFactory is internal.
export type BrowserSenderSessionFactory = BrowserRoot.QwpSenderSessionFactory;

// So is the ingress session below the sender, along with the factories that
// return one and the error only its own close() throws.
// @ts-expect-error QwpIngressSession is internal.
export type NodeIngressSession = NodeRoot.QwpIngressSession;
export type NodeIngressCloseTimeout =
  // @ts-expect-error QwpIngressSessionCloseTimeoutError is internal.
  NodeRoot.QwpIngressSessionCloseTimeoutError;
// @ts-expect-error connectQwpNodeIngress is internal.
export type NodeIngressFactory = typeof NodeRoot.connectQwpNodeIngress;
// @ts-expect-error QwpIngressSession is internal.
export type BrowserIngressSession = BrowserRoot.QwpIngressSession;
export type BrowserIngressCloseTimeout =
  // @ts-expect-error QwpIngressSessionCloseTimeoutError is internal.
  BrowserRoot.QwpIngressSessionCloseTimeoutError;
// @ts-expect-error connectQwpBrowserIngress is internal.
export type BrowserIngressFactory = typeof BrowserRoot.connectQwpBrowserIngress;

// So are the Node orphan drainer, with its options, session and slot scanner,
// and the UDP session, with its metrics and the factory that returned one.
// @ts-expect-error QwpNodeOrphanDrainer is internal.
export type NodeOrphanDrainer = NodeRoot.QwpNodeOrphanDrainer;
// @ts-expect-error QwpNodeOrphanDrainerOptions is internal.
export type NodeOrphanDrainerOptions = NodeRoot.QwpNodeOrphanDrainerOptions;
// @ts-expect-error QwpNodeOrphanDrainSession is internal.
export type NodeOrphanDrainSession = NodeRoot.QwpNodeOrphanDrainSession;
// @ts-expect-error scanQwpNodeOrphanSlots is internal.
export type NodeOrphanScan = typeof NodeRoot.scanQwpNodeOrphanSlots;
// @ts-expect-error QwpNodeUdpSession is internal.
export type NodeUdpSession = NodeRoot.QwpNodeUdpSession;
// @ts-expect-error QwpNodeUdpMetrics is internal.
export type NodeUdpMetrics = NodeRoot.QwpNodeUdpMetrics;
// @ts-expect-error connectQwpNodeUdp is internal.
export type NodeUdpFactory = typeof NodeRoot.connectQwpNodeUdp;

// So is the interface carrying the session options only an adapter sets, and
// the published session options must not regain any of its handoffs.
// @ts-expect-error QwpIngressSessionInternalOptions is internal.
export type NodeSessionInternals = NodeRoot.QwpIngressSessionInternalOptions;
export type BrowserSessionInternals =
  // @ts-expect-error QwpIngressSessionInternalOptions is internal.
  BrowserRoot.QwpIngressSessionInternalOptions;
type ExpectNone<T extends never> = T;
type InternalSessionField =
  | "replayStore"
  | "backgroundStoreAndForward"
  | "orphanStoreAndForward"
  | "orphanDurableAckMismatchMaxDurationMs"
  | "catchUpCapGapMinEscalationWindowMs"
  | "priorSenderErrorDeliveries";
export type NodeSessionLeaks = ExpectNone<
  Extract<keyof NodeRoot.QwpIngressSessionOptions, InternalSessionField>
>;
export type BrowserSessionLeaks = ExpectNone<
  Extract<keyof BrowserRoot.QwpIngressSessionOptions, InternalSessionField>
>;

// Durable ACK is negotiated on /write/v4 only, so neither the transport
// options both sides share nor the egress options may carry the request.
export type NodeSharedDurableAck = ExpectNone<
  Extract<
    | keyof NodeRoot.QwpNodeWebSocketOptions
    | keyof NodeRoot.QwpNodeEgressOptions,
    "requestDurableAck"
  >
>;
export type BrowserSharedIngressNegotiation = ExpectNone<
  Extract<
    | keyof BrowserRoot.QwpBrowserWebSocketOptions
    | keyof BrowserRoot.QwpBrowserEgressOptions,
    "requestDurableAck" | "ingressNegotiationTimeoutMs"
  >
>;
