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
  QwpBindSetter,
  QwpBindType,
  QwpCacheResetMessage,
  QwpClientFactories,
  QwpClientMetrics,
  QwpClientPoolOptions,
  QwpColumnBuffer,
  QwpColumnType,
  QwpConnectionCloseInfo,
  QwpDecimalInput,
  QwpDecimalValue,
  QwpDoubleArrayInput,
  QwpEgressCompression,
  QwpEgressMessage,
  QwpEgressMetrics,
  QwpEgressQueryOptions,
  QwpEgressReconnectOptions,
  QwpEgressReplayResetEvent,
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
  QwpIngressResponse,
  QwpIngressServerInfo,
  QwpIngressSymbolDictionaryDelta,
  QwpIngressTableResult,
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
  QwpBindSetter as BrowserQwpBindSetter,
  QwpBindType as BrowserQwpBindType,
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
  QwpDecimalInput as BrowserQwpDecimalInput,
  QwpDecimalValue as BrowserQwpDecimalValue,
  QwpDoubleArrayInput as BrowserQwpDoubleArrayInput,
  QwpEgressCompression as BrowserQwpEgressCompression,
  QwpEgressMessage as BrowserQwpEgressMessage,
  QwpEgressMetrics as BrowserQwpEgressMetrics,
  QwpEgressQueryOptions as BrowserQwpEgressQueryOptions,
  QwpEgressReconnectOptions as BrowserQwpEgressReconnectOptions,
  QwpEgressReplayResetEvent as BrowserQwpEgressReplayResetEvent,
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
  QwpIngressResponse as BrowserQwpIngressResponse,
  QwpIngressServerInfo as BrowserQwpIngressServerInfo,
  QwpIngressSymbolDictionaryDelta as BrowserQwpIngressSymbolDictionaryDelta,
  QwpIngressTableResult as BrowserQwpIngressTableResult,
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
  QwpServerInfoMessage as BrowserQwpServerInfoMessage,
  QwpSymbolValue as BrowserQwpSymbolValue,
  QwpTarget as BrowserQwpTarget,
  QwpTimestampUnit as BrowserQwpTimestampUnit,
  QwpUpgradeErrorDetails as BrowserQwpUpgradeErrorDetails,
  QwpUpgradeErrorKind as BrowserQwpUpgradeErrorKind,
  QwpUpgradeTimeoutPhase as BrowserQwpUpgradeTimeoutPhase,
  QwpUuidInput as BrowserQwpUuidInput,
  QwpUuidValue as BrowserQwpUuidValue,
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

// So are the raw connection helpers: the senders, the query sessions and the
// pooled client open their own connections.
// @ts-expect-error connectQwpNodeWebSocket is internal.
export type NodeRawConnect = typeof NodeRoot.connectQwpNodeWebSocket;
export type NodeConnectionFactory =
  // @ts-expect-error createQwpNodeConnectionFactory is internal.
  typeof NodeRoot.createQwpNodeConnectionFactory;
// @ts-expect-error connectQwpBrowserWebSocket is internal.
export type BrowserRawConnect = typeof BrowserRoot.connectQwpBrowserWebSocket;
export type BrowserConnectionFactory =
  // @ts-expect-error createQwpBrowserConnectionFactory is internal.
  typeof BrowserRoot.createQwpBrowserConnectionFactory;

// So is the store-and-forward journal, with its options and metrics, and the
// replay store contract it implements: storeAndForward configures the one
// persistent store, and no option takes another.
// @ts-expect-error QwpNodeFileReplayStore is internal.
export type NodeFileReplayStore = NodeRoot.QwpNodeFileReplayStore;
export type NodeFileReplayStoreOptions =
  // @ts-expect-error QwpNodeFileReplayStoreOptions is internal.
  NodeRoot.QwpNodeFileReplayStoreOptions;
export type NodeFileReplayStoreMetrics =
  // @ts-expect-error QwpNodeFileReplayStoreMetrics is internal.
  NodeRoot.QwpNodeFileReplayStoreMetrics;
// @ts-expect-error QwpIngressReplayStore is internal.
export type NodeReplayStore = NodeRoot.QwpIngressReplayStore;
// @ts-expect-error QwpIngressReplayRecord is internal.
export type NodeReplayRecord = NodeRoot.QwpIngressReplayRecord;
// @ts-expect-error QwpIngressReplayReference is internal.
export type NodeReplayReference = NodeRoot.QwpIngressReplayReference;
// @ts-expect-error QwpIngressReplayStore is internal.
export type BrowserReplayStore = BrowserRoot.QwpIngressReplayStore;
// @ts-expect-error QwpIngressReplayRecord is internal.
export type BrowserReplayRecord = BrowserRoot.QwpIngressReplayRecord;
// @ts-expect-error QwpIngressReplayReference is internal.
export type BrowserReplayReference = BrowserRoot.QwpIngressReplayReference;

// The sender's buffering options and the ingress session's delivery options
// are part of each runtime's ingress options, not types of their own, and the
// session options only an adapter sets are internal too.
// @ts-expect-error QwpSenderOptions is internal.
export type NodeSenderOptions = NodeRoot.QwpSenderOptions;
// @ts-expect-error QwpSenderOptions is internal.
export type BrowserSenderOptions = BrowserRoot.QwpSenderOptions;
// @ts-expect-error QwpIngressSessionOptions is internal.
export type NodeSessionOptions = NodeRoot.QwpIngressSessionOptions;
// @ts-expect-error QwpIngressSessionOptions is internal.
export type BrowserSessionOptions = BrowserRoot.QwpIngressSessionOptions;
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
// The published ingress options carry the session's delivery options, and
// must not regain any of the adapter's handoffs.
export type NodeSessionLeaks = ExpectNone<
  Extract<keyof NodeRoot.QwpNodeIngressOptions, InternalSessionField>
>;
export type BrowserSessionLeaks = ExpectNone<
  Extract<keyof BrowserRoot.QwpBrowserIngressOptions, InternalSessionField>
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

// The endpoints and WebSocket deadlines both runtimes read are a non-exported
// base, published only through the runtime options that extend it -- so those
// must keep every one of its fields.
// @ts-expect-error QwpWebSocketConnectOptions is internal.
export type NodeConnectOptions = NodeRoot.QwpWebSocketConnectOptions;
// @ts-expect-error QwpWebSocketConnectOptions is internal.
export type BrowserConnectOptions = BrowserRoot.QwpWebSocketConnectOptions;
type SharedConnectField =
  | "url"
  | "failoverUrls"
  | "protocols"
  | "connectTimeoutMs"
  | "sendTimeoutMs"
  | "closeTimeoutMs";
export type NodeConnectFields = ExpectNone<
  Exclude<SharedConnectField, keyof NodeRoot.QwpNodeWebSocketOptions>
>;
export type BrowserConnectFields = ExpectNone<
  Exclude<SharedConnectField, keyof BrowserRoot.QwpBrowserWebSocketOptions>
>;

// The journal's own settings are folded into the store-and-forward options,
// which must keep every one of them.
type JournalField =
  | "directory"
  | "maxBytes"
  | "maxSegmentBytes"
  | "durability"
  | "checkpointIntervalMs"
  | "backpressurePolicy"
  | "appendDeadlineMs"
  | "onRecoveryDataLoss";
export type NodeJournalFields = ExpectNone<
  Exclude<JournalField, keyof NodeRoot.QwpNodeStoreAndForwardOptions>
>;

// A query session is the query API, but constructing one is internal: its
// constructor takes a token only the runtime adapters hold, and it has no
// static connect() any more. The connection layer below it -- connections,
// their factory and their transport metrics -- is internal with it, and so are
// the session's own options, which each runtime's egress options include.
// @ts-expect-error QwpBinaryConnection is internal.
export type NodeBinaryConnection = NodeRoot.QwpBinaryConnection;
// @ts-expect-error QwpConnectionFactory is internal.
export type NodeConnectionFactoryType = NodeRoot.QwpConnectionFactory;
// @ts-expect-error QwpEgressSessionOptions is internal.
export type NodeEgressSessionOptions = NodeRoot.QwpEgressSessionOptions;
export type NodeEgressTransportMetrics =
  // @ts-expect-error QwpEgressTransportMetrics is internal.
  NodeRoot.QwpEgressTransportMetrics;
export type NodeIngressTransportMetrics =
  // @ts-expect-error QwpIngressTransportMetrics is internal.
  NodeRoot.QwpIngressTransportMetrics;
// @ts-expect-error QwpBinaryConnection is internal.
export type BrowserBinaryConnection = BrowserRoot.QwpBinaryConnection;
// @ts-expect-error QwpConnectionFactory is internal.
export type BrowserConnectionFactoryType = BrowserRoot.QwpConnectionFactory;
export type BrowserEgressSessionOptions =
  // @ts-expect-error QwpEgressSessionOptions is internal.
  BrowserRoot.QwpEgressSessionOptions;
export type BrowserEgressTransportMetrics =
  // @ts-expect-error QwpEgressTransportMetrics is internal.
  BrowserRoot.QwpEgressTransportMetrics;
export type BrowserIngressTransportMetrics =
  // @ts-expect-error QwpIngressTransportMetrics is internal.
  BrowserRoot.QwpIngressTransportMetrics;
export type NodeEgressSessionConnect = ExpectNone<
  Extract<keyof typeof NodeRoot.QwpEgressSession, "connect">
>;
export type BrowserEgressSessionConnect = ExpectNone<
  Extract<keyof typeof BrowserRoot.QwpEgressSession, "connect">
>;
export type NodeEgressSessionToken = ExpectNone<
  Exclude<ConstructorParameters<typeof NodeRoot.QwpEgressSession>[0], symbol>
>;
export type BrowserEgressSessionToken = ExpectNone<
  Exclude<ConstructorParameters<typeof BrowserRoot.QwpEgressSession>[0], symbol>
>;
type EgressSessionField =
  | "serverInfoTimeoutMs"
  | "initialCredit"
  | "bufferPoolSize"
  | "queryTimeoutMs"
  | "cancelDrainTimeoutMs"
  | "maxBatchRows"
  | "reconnect"
  | "connectionListenerInboxCapacity"
  | "onReplayReset";
export type NodeEgressSessionFields = ExpectNone<
  Exclude<EgressSessionField, keyof NodeRoot.QwpNodeEgressOptions>
>;
export type BrowserEgressSessionFields = ExpectNone<
  Exclude<EgressSessionField, keyof BrowserRoot.QwpBrowserEgressOptions>
>;
