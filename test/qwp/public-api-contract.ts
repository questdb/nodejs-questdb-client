import { Sender } from "../../packages/nodejs-client/src";
import type {
  ExtraOptions,
  QwpExtraOptions,
} from "../../packages/nodejs-client/src";
import {
  binary,
  char,
  date,
  decimal64,
  decimal128,
  decimal256,
  defaultQwpSenderErrorHandler,
  designatedTimestamp,
  double,
  doubleArray,
  geohash,
  ipv4,
  long,
  long256,
  longArray,
  symbol as qwpSymbol,
  uuid,
} from "../../packages/nodejs-client/src";
import {
  bootstrapQwpBrowserSession,
  connectQwpBrowserClient,
  connectQwpBrowserEgress,
  connectQwpBrowserIngress,
  connectQwpBrowserSender,
} from "../../packages/browser-client/src";
import type {
  QwpBrowserClusterOptions,
  QwpBrowserClientEgressOptions,
  QwpBrowserClientIngressOptions,
  QwpBrowserClientOptions,
  QwpBrowserSessionBootstrapOptions,
  QwpBrowserSessionBootstrapResult,
  QwpBrowserEgressOptions,
  QwpBrowserSplitClientOptions,
  QwpBrowserUnifiedClientOptions,
  QwpBrowserWebSocketOptions,
} from "../../packages/browser-client/src";
import {
  connectQwpNodeEgress,
  connectQwpNodeClient,
  connectQwpNodeIngress,
  connectQwpNodeSender,
  connectQwpNodeUdp,
  connectQwpNodeUdpSender,
  connectQwpNodeWebSocket,
  parseQwpNodeClientConfig,
  retryQwpNodeOrphanSlot,
  scanQwpNodeOrphanSlots,
} from "../../packages/nodejs-client/src";
import type {
  QwpNodeClientOptions,
  QwpNodeClientConfigOptions,
  QwpNodeEgressOptions,
  QwpNodeIngressOptions,
  QwpNodeUdpOptions,
  QwpNodeUdpSession,
  QwpNodeOrphanDrainEvent,
  QwpNodeOrphanDrainSession,
  QwpNodeReplayRecoveryEvent,
  QwpNodeStoreAndForwardOptions,
  QwpNodeWebSocketOptions,
} from "../../packages/nodejs-client/src";
import type {
  QwpBinaryConnection,
  QwpClient,
  QwpClientPoolOptions,
  QwpEgressQueryOptions,
  QwpEgressSession,
  QwpEgressSessionOptions,
  QwpEgressViewQuery,
  QwpIngressSession,
  QwpIngressSessionOptions,
  QwpIngressSendResult,
  QwpSenderError,
  QwpQueryLease,
  QwpResultBatchView,
  QwpResultBatchViewHandler,
  QwpResultRowView,
  QwpResultRowViewCallback,
  QwpServerInfoMessage,
  QwpSender,
  QwpSenderOptions,
  QwpTableWriter,
  QwpWriterRow,
} from "../../packages/nodejs-client/src";

// This file is part of the repository typecheck. Assignments deliberately
// capture the documented call shapes, so removing or changing a public
// signature fails compilation even though TypeScript types do not exist at
// runtime.
const browserSenderSignature: (
  options: QwpBrowserWebSocketOptions,
  senderOptions?: QwpSenderOptions,
  sessionOptions?: QwpIngressSessionOptions,
) => Promise<QwpSender> = connectQwpBrowserSender;

const defaultSenderErrorHandlerSignature: (error: QwpSenderError) => void =
  defaultQwpSenderErrorHandler;

const browserIngressSignature: (
  options: QwpBrowserWebSocketOptions,
  sessionOptions?: QwpIngressSessionOptions,
) => Promise<QwpIngressSession> = connectQwpBrowserIngress;

const browserEgressSignature: (
  options: QwpBrowserEgressOptions,
  sessionOptions?: QwpEgressSessionOptions,
) => Promise<QwpEgressSession> = connectQwpBrowserEgress;

const bootstrapSignature: (
  options: QwpBrowserSessionBootstrapOptions,
) => Promise<QwpBrowserSessionBootstrapResult> = bootstrapQwpBrowserSession;

const browserClientSignature: (
  options: QwpBrowserClientOptions,
) => Promise<QwpClient> = connectQwpBrowserClient;

const nodeSenderSignature: (
  options: QwpNodeIngressOptions,
  senderOptions?: QwpSenderOptions,
  sessionOptions?: QwpIngressSessionOptions,
) => Promise<QwpSender> = connectQwpNodeSender;

const nodeUdpSignature: (
  options: QwpNodeUdpOptions,
) => Promise<QwpNodeUdpSession> = connectQwpNodeUdp;

const nodeUdpSenderSignature: (
  options: QwpNodeUdpOptions,
  senderOptions?: QwpSenderOptions,
) => Promise<QwpSender> = connectQwpNodeUdpSender;

const nodeIngressSignature: (
  options: QwpNodeIngressOptions,
  sessionOptions?: QwpIngressSessionOptions,
) => Promise<QwpIngressSession> = connectQwpNodeIngress;

const nodeEgressSignature: (
  options: QwpNodeEgressOptions,
  sessionOptions?: QwpEgressSessionOptions,
) => Promise<QwpEgressSession> = connectQwpNodeEgress;

const nodeWebSocketSignature: (
  options: QwpNodeWebSocketOptions,
) => Promise<QwpBinaryConnection> = connectQwpNodeWebSocket;

const nodeWebSocketOptionsContract: QwpNodeWebSocketOptions = {
  url: "wss://node-1.example/write/v4",
  connectTimeoutMs: 5_000,
  authTimeoutMs: 15_000,
};

const nodeClientSignature: (
  options: QwpNodeClientOptions,
) => Promise<QwpClient> = connectQwpNodeClient;

const nodeClusterClientSignature: (
  configurationString: string,
  extraOptions?: QwpNodeClientConfigOptions,
) => Promise<QwpClient> = connectQwpNodeClient;

const nodeClusterParserSignature: (
  configurationString: string,
  extraOptions?: QwpNodeClientConfigOptions,
) => QwpNodeClientOptions = parseQwpNodeClientConfig;

const poolOptionsContract: QwpClientPoolOptions = {
  senderPoolMin: 1,
  senderPoolMax: 2,
  queryPoolMin: 1,
  queryPoolMax: 8,
  acquireTimeoutMs: 5_000,
  idleTimeoutMs: 60_000,
  maxLifetimeMs: 30 * 60_000,
  housekeepingIntervalMs: 5_000,
};

const nodeOrphanScanSignature: (
  rootDirectory: string,
  excludeSlot?: (slotName: string) => boolean,
) => Promise<readonly string[]> = scanQwpNodeOrphanSlots;

const nodeOrphanRetrySignature: (directory: string) => Promise<void> =
  retryQwpNodeOrphanSlot;

// QwpNodeOrphanDrainerOptions.createSession returns this, so anyone
// implementing that interface must be able to name it.
const nodeOrphanDrainSessionContract: (
  session: QwpNodeOrphanDrainSession,
) => Promise<void> = async (session) => {
  await session.closed;
};

const nodeStoreAndForwardContract: QwpNodeStoreAndForwardOptions = {
  directory: "/tmp/qwp-public-api-contract",
  maxSegmentBytes: 4 * 1024 * 1024,
  durability: "periodic",
  checkpointIntervalMs: 5_000,
  backpressurePolicy: "wait",
  appendDeadlineMs: 30_000,
  drainOrphans: true,
  maxBackgroundDrainers: 2,
  orphanScanIntervalMs: 30_000,
  onOrphanDrainEvent: (event: QwpNodeOrphanDrainEvent) => void event.metrics,
  onRecoveryQuarantine: (event: QwpNodeReplayRecoveryEvent) =>
    void event.quarantineDirectory,
};

const queryOptionsContract: QwpEgressQueryOptions = {
  initialCredit: 1024,
  autoCredit: true,
  timeoutMs: 30_000,
  resetDictionary: true,
  binds: (binds) => binds.setVarchar(0, "ETH-USD"),
};

const egressSessionOptionsContract: QwpEgressSessionOptions = {
  initialCredit: 256 * 1024,
  bufferPoolSize: 4,
  queryTimeoutMs: 30_000,
  cancelDrainTimeoutMs: 5_000,
  maxBatchRows: 4096,
};

const fixedConnectionIngressContract: QwpIngressSessionOptions = {
  reconnect: false,
  connectionListenerInboxCapacity: 64,
  errorInboxCapacity: 256,
  onSenderError: (error: QwpSenderError) =>
    void [
      error.category,
      error.appliedPolicy,
      error.fromFsn,
      error.toFsn,
      error.quarantinedPath,
    ],
};

const memoryReplayIngressContract: QwpIngressSessionOptions = {
  memoryReplayMaxBytes: 128 * 1024 * 1024,
  memoryReplayAppendDeadlineMs: 30_000,
};

const fixedConnectionEgressContract: QwpEgressSessionOptions = {
  reconnect: false,
};

const browserEgressOptionsContract: QwpBrowserEgressOptions = {
  url: "wss://node-1.example/read/v1",
  failoverUrls: ["wss://node-2.example/read/v1"],
  target: "replica",
  zone: "eu-west-1a",
  maxBatchRows: 512,
};

const browserClusterOptionsContract: QwpBrowserClusterOptions = {
  url: "wss://node-1.example/qdb",
  failoverUrls: ["wss://node-2.example/qdb"],
  connectTimeoutMs: 5_000,
  sessionBootstrap: {
    authentication: { type: "bearer", token: "oidc-token" },
  },
};

const browserIngressOverridesContract: QwpBrowserClientIngressOptions = {
  requestDurableAck: true,
  ingressNegotiationTimeoutMs: 1_000,
};

const browserEgressOverridesContract: QwpBrowserClientEgressOptions = {
  target: "replica",
  zone: "eu-west-1a",
  compression: "zstd",
  maxBatchRows: 512,
};

const browserUnifiedClientContract: QwpBrowserUnifiedClientOptions = {
  cluster: browserClusterOptionsContract,
  ingress: browserIngressOverridesContract,
  egress: browserEgressOverridesContract,
};

const browserSplitClientContract: QwpBrowserSplitClientOptions = {
  ingress: { url: "wss://node-1.example/write/v4" },
  egress: { url: "wss://node-1.example/read/v1" },
};

const browserClientOptionsContracts: readonly QwpBrowserClientOptions[] = [
  browserUnifiedClientContract,
  browserSplitClientContract,
];

const nodeEgressOptionsContract: QwpNodeEgressOptions = {
  url: "wss://node-1.example/read/v1",
  failoverUrls: ["wss://node-2.example/read/v1"],
  target: "primary",
  maxBatchRows: 512,
};

const qwpExtraOptionsContract: QwpExtraOptions = {
  webSocket: {
    requestDurableAck: true,
    storeAndForward: {
      directory: "/tmp/qwp-public-api-contract",
      initialConnectMode: "sync",
      catchUpCapGapMinEscalationWindowMs: 300_000,
    },
  },
  sender: {
    transactional: true,
    autoFlushBytes: 4 * 1024 * 1024,
    maxNameLength: 255,
    closeFlushTimeoutMs: 5_000,
    awaitDurableAck: true,
  },
  session: {
    reconnect: { maxAttempts: 3 },
  },
  udp: {
    maxDatagramSize: 1_400,
    multicastTtl: 1,
  },
};

function senderSequenceContract(
  sender: QwpSender,
  session: QwpIngressSession,
): void {
  const published: Promise<bigint> = sender.flushAndGetSequence();
  const senderWait: Promise<void> = sender.waitForAcknowledged(0n, 5_000);
  const senderPublished: bigint = sender.publishedSequence;
  const senderAcknowledged: bigint = sender.acknowledgedSequence;
  const sessionWait: Promise<void> = session.waitForAcknowledged(0n, 5_000);
  const sessionPublished: bigint = session.publishedFrameSequence;
  const sessionAcknowledged: bigint = session.acknowledgedFrameSequence;
  const tracked: QwpIngressSendResult = session.sendFrameWithPublication(
    new Uint8Array(),
  );
  const localPublication: Promise<void> = tracked.publication;
  const serverAcknowledgement = tracked.acknowledgement;
  const trackedSequence: bigint = tracked.sequence;
  void published;
  void senderWait;
  void senderPublished;
  void senderAcknowledged;
  void sessionWait;
  void sessionPublished;
  void sessionAcknowledged;
  void localPublication;
  void serverAcknowledgement;
  void trackedSequence;
}

function rootSenderSequenceContract(sender: Sender): void {
  const published: Promise<bigint> = sender.flushAndGetSequence();
  const wait: Promise<void> = sender.waitForAcknowledged(0n, 5_000);
  const publishedWatermark: bigint = sender.publishedSequence;
  const acknowledgedWatermark: bigint = sender.acknowledgedSequence;
  void published;
  void wait;
  void publishedWatermark;
  void acknowledgedWatermark;
}

function compiledWriterContract(sender: QwpSender, rootSender: Sender): void {
  const schema = {
    symbol: qwpSymbol(),
    price: double(),
    quantity: long(),
    timestamp: designatedTimestamp("ns"),
  } as const;
  const writer: QwpTableWriter<typeof schema> = sender.writer("trades", schema);
  const row: QwpWriterRow<typeof schema> = {
    symbol: "ETH-USD",
    price: 2_615.54,
    quantity: 42n,
    timestamp: 1_723_000_000_000_000_000n,
  };
  const single: Promise<void> = writer.row(row);
  const batch: Promise<void> = writer.rows([row]);
  const rootWriter: QwpTableWriter<typeof schema> = rootSender.writer(
    "trades",
    schema,
  );
  // @ts-expect-error The designated timestamp is required.
  void writer.row({ price: 1 });
  // @ts-expect-error LONG values are bigint, not number.
  void writer.row({ quantity: 42, timestamp: 1n });
  void single;
  void batch;
  void rootWriter;
}

function compiledWriterTypeContract(sender: QwpSender): void {
  const schema = {
    created_date: date(),
    letter: char(),
    payload: binary(),
    id: uuid(),
    hash: long256(),
    ip: ipv4(),
    location: geohash(20),
    price: decimal64(4),
    wide_price: decimal128(2),
    widest_price: decimal256(0),
    samples: doubleArray(),
    counters: longArray(),
    timestamp: designatedTimestamp("ns"),
  } as const;
  const writer: QwpTableWriter<typeof schema> = sender.writer("typed", schema);
  const row: QwpWriterRow<typeof schema> = {
    created_date: 1_700_000_000_000n,
    letter: "Q",
    payload: Uint8Array.of(1, 2, 3),
    id: "123e4567-e89b-12d3-a456-426614174000",
    hash: "0x0102",
    ip: "192.168.0.1",
    location: "u33d",
    price: "123.4500",
    wide_price: 1_234n,
    widest_price: { unscaled: 42n, scale: 0 },
    samples: [
      [1.5, 2.5],
      [3.5, 4.5],
    ],
    counters: [1n, 2n, 3n],
    timestamp: 1_723_000_000_000_000_000n,
  };
  // Egress-shaped values are accepted without casts.
  const egressShaped: QwpWriterRow<typeof schema> = {
    id: { low: 1n, high: 2n },
    hash: { words: [1n, 2n, 3n, 4n] },
    location: { bits: 7n, precisionBits: 20 },
    price: { unscaled: 1_234_500n, scale: 4 },
    samples: { dimensions: [2, 2], values: [1, 2, 3, 4] },
    timestamp: 1_723_000_001_000_000_000n,
  };
  // @ts-expect-error BINARY values are bytes, not number arrays.
  void writer.row({ payload: [1, 2, 3], timestamp: 1n });
  // @ts-expect-error CHAR values are strings.
  void writer.row({ letter: 7, timestamp: 1n });
  void writer.rows([row, egressShaped]);
}

function queryViewContract(
  session: QwpEgressSession,
  lease: QwpQueryLease,
): void {
  const sessionServerInfo: QwpServerInfoMessage | undefined =
    session.serverInfo;
  const leaseServerInfo: QwpServerInfoMessage | undefined = lease.serverInfo;
  const handler: QwpResultBatchViewHandler = (batch, query) => {
    const typedBatch: QwpResultBatchView = batch;
    const requestId: bigint = query.requestId;
    const completionWait: Promise<boolean> = query.awaitCompletion(1_000);
    const done: boolean = query.isDone();
    const rawValues: Uint8Array | undefined = batch.column(0).valuesBytes();
    const directRow: QwpResultRowView = batch.row(0);
    const rowCallback: QwpResultRowViewCallback = (row) => {
      const rowIndex: number = row.rowIndex;
      const value: bigint = row.getLong(0);
      void rowIndex;
      void value;
    };
    batch.forEachRow(rowCallback);
    void typedBatch;
    void requestId;
    void completionWait;
    void done;
    void rawValues;
    void directRow;
  };
  const direct: Promise<QwpEgressViewQuery> = session.queryViews(
    "select * from trades",
    handler,
  );
  const pooled: Promise<QwpEgressViewQuery> = lease.queryViews(
    "select * from trades",
    handler,
  );
  void direct;
  void pooled;
  void sessionServerInfo;
  void leaseServerInfo;
}

const rootExtraOptionsContract: ExtraOptions = {
  qwp: qwpExtraOptionsContract,
};

void browserSenderSignature;
void defaultSenderErrorHandlerSignature;
void browserIngressSignature;
void memoryReplayIngressContract;
void browserEgressSignature;
void bootstrapSignature;
void browserClientSignature;
void nodeSenderSignature;
void nodeUdpSignature;
void nodeUdpSenderSignature;
void nodeIngressSignature;
void nodeEgressSignature;
void nodeWebSocketSignature;
void nodeWebSocketOptionsContract;
void nodeClientSignature;
void poolOptionsContract;
void nodeOrphanScanSignature;
void nodeOrphanRetrySignature;
void nodeOrphanDrainSessionContract;
void nodeStoreAndForwardContract;
void queryOptionsContract;
void egressSessionOptionsContract;
void fixedConnectionIngressContract;
void fixedConnectionEgressContract;
void browserEgressOptionsContract;
void nodeEgressOptionsContract;
void rootExtraOptionsContract;
void senderSequenceContract;
void rootSenderSequenceContract;
void compiledWriterContract;
void compiledWriterTypeContract;
void queryViewContract;
void Sender;
