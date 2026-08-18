import { Sender } from "../../src";
import type { ExtraOptions, QwpExtraOptions } from "../../src";
import {
  bootstrapQwpBrowserSession,
  connectQwpBrowserClient,
  connectQwpBrowserEgress,
  connectQwpBrowserIngress,
  connectQwpBrowserSender,
} from "../../src/qwp/browser";
import type {
  QwpBrowserClientOptions,
  QwpBrowserSessionBootstrapOptions,
  QwpBrowserSessionBootstrapResult,
  QwpBrowserEgressOptions,
  QwpBrowserWebSocketOptions,
} from "../../src/qwp/browser";
import {
  connectQwpNodeEgress,
  connectQwpNodeClient,
  connectQwpNodeIngress,
  connectQwpNodeSender,
  connectQwpNodeWebSocket,
  retryQwpNodeOrphanSlot,
  scanQwpNodeOrphanSlots,
} from "../../src/qwp/node";
import type {
  QwpNodeClientOptions,
  QwpNodeEgressOptions,
  QwpNodeIngressOptions,
  QwpNodeOrphanDrainEvent,
  QwpNodeStoreAndForwardOptions,
  QwpNodeWebSocketOptions,
} from "../../src/qwp/node";
import type {
  QwpBinaryConnection,
  QwpClient,
  QwpEgressQueryOptions,
  QwpEgressSession,
  QwpEgressSessionOptions,
  QwpEgressViewQuery,
  QwpIngressSession,
  QwpIngressSessionOptions,
  QwpQueryLease,
  QwpResultBatchView,
  QwpResultBatchViewHandler,
  QwpResultRowView,
  QwpResultRowViewCallback,
  QwpSender,
  QwpSenderOptions,
} from "../../src/qwp";

// This file is part of the repository typecheck. Assignments deliberately
// capture the documented call shapes, so removing or changing a public
// signature fails compilation even though TypeScript types do not exist at
// runtime.
const browserSenderSignature: (
  options: QwpBrowserWebSocketOptions,
  senderOptions?: QwpSenderOptions,
  sessionOptions?: QwpIngressSessionOptions,
) => Promise<QwpSender> = connectQwpBrowserSender;

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

const nodeClientSignature: (
  options: QwpNodeClientOptions,
) => Promise<QwpClient> = connectQwpNodeClient;

const nodeOrphanScanSignature: (
  rootDirectory: string,
  excludeSlot?: (slotName: string) => boolean,
) => Promise<readonly string[]> = scanQwpNodeOrphanSlots;

const nodeOrphanRetrySignature: (directory: string) => Promise<void> =
  retryQwpNodeOrphanSlot;

const nodeStoreAndForwardContract: QwpNodeStoreAndForwardOptions = {
  directory: "/tmp/qwp-public-api-contract",
  durability: "periodic",
  checkpointIntervalMs: 5_000,
  backpressurePolicy: "wait",
  appendDeadlineMs: 30_000,
  drainOrphans: true,
  maxBackgroundDrainers: 2,
  orphanScanIntervalMs: 30_000,
  onOrphanDrainEvent: (event: QwpNodeOrphanDrainEvent) => void event.metrics,
};

const queryOptionsContract: QwpEgressQueryOptions = {
  initialCredit: 1024,
  autoCredit: true,
  timeoutMs: 30_000,
  binds: (binds) => binds.setVarchar(0, "ETH-USD"),
};

const egressSessionOptionsContract: QwpEgressSessionOptions = {
  initialCredit: 256 * 1024,
  bufferPoolSize: 4,
  queryTimeoutMs: 30_000,
  cancelDrainTimeoutMs: 5_000,
};

const browserEgressOptionsContract: QwpBrowserEgressOptions = {
  url: "wss://node-1.example/read/v1",
  failoverUrls: ["wss://node-2.example/read/v1"],
  target: "replica",
  zone: "eu-west-1a",
  maxBatchRows: 512,
};

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
    closeFlushTimeoutMs: 5_000,
    awaitDurableAck: true,
  },
  session: {
    reconnect: { maxAttempts: 3 },
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
  void published;
  void senderWait;
  void senderPublished;
  void senderAcknowledged;
  void sessionWait;
  void sessionPublished;
  void sessionAcknowledged;
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

function queryViewContract(
  session: QwpEgressSession,
  lease: QwpQueryLease,
): void {
  const handler: QwpResultBatchViewHandler = (batch, query) => {
    const typedBatch: QwpResultBatchView = batch;
    const requestId: bigint = query.requestId;
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
}

const rootExtraOptionsContract: ExtraOptions = {
  qwp: qwpExtraOptionsContract,
};

void browserSenderSignature;
void browserIngressSignature;
void browserEgressSignature;
void bootstrapSignature;
void browserClientSignature;
void nodeSenderSignature;
void nodeIngressSignature;
void nodeEgressSignature;
void nodeWebSocketSignature;
void nodeClientSignature;
void nodeOrphanScanSignature;
void nodeOrphanRetrySignature;
void nodeStoreAndForwardContract;
void queryOptionsContract;
void egressSessionOptionsContract;
void browserEgressOptionsContract;
void nodeEgressOptionsContract;
void rootExtraOptionsContract;
void senderSequenceContract;
void rootSenderSequenceContract;
void queryViewContract;
void Sender;
