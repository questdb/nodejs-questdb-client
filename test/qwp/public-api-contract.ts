import { Sender } from "../../src";
import type { ExtraOptions, QwpExtraOptions } from "../../src";
import {
  bootstrapQwpBrowserSession,
  connectQwpBrowserEgress,
  connectQwpBrowserIngress,
  connectQwpBrowserSender,
} from "../../src/qwp/browser";
import type {
  QwpBrowserSessionBootstrapOptions,
  QwpBrowserSessionBootstrapResult,
  QwpBrowserWebSocketOptions,
} from "../../src/qwp/browser";
import {
  connectQwpNodeEgress,
  connectQwpNodeIngress,
  connectQwpNodeSender,
  connectQwpNodeWebSocket,
} from "../../src/qwp/node";
import type {
  QwpNodeEgressOptions,
  QwpNodeIngressOptions,
  QwpNodeWebSocketOptions,
} from "../../src/qwp/node";
import type {
  QwpBinaryConnection,
  QwpEgressQueryOptions,
  QwpEgressSession,
  QwpEgressSessionOptions,
  QwpIngressSession,
  QwpIngressSessionOptions,
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
  options: QwpBrowserWebSocketOptions,
  sessionOptions?: QwpEgressSessionOptions,
) => Promise<QwpEgressSession> = connectQwpBrowserEgress;

const bootstrapSignature: (
  options: QwpBrowserSessionBootstrapOptions,
) => Promise<QwpBrowserSessionBootstrapResult> = bootstrapQwpBrowserSession;

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

const queryOptionsContract: QwpEgressQueryOptions = {
  initialCredit: 1024,
  autoCredit: true,
  timeoutMs: 30_000,
  binds: (binds) => binds.setVarchar(0, "ETH-USD"),
};

const qwpExtraOptionsContract: QwpExtraOptions = {
  webSocket: {
    requestDurableAck: true,
    storeAndForward: { directory: "/tmp/qwp-public-api-contract" },
  },
  sender: {
    transactional: true,
    awaitDurableAck: true,
  },
  session: {
    reconnect: { maxAttempts: 3 },
  },
};

const rootExtraOptionsContract: ExtraOptions = {
  qwp: qwpExtraOptionsContract,
};

void browserSenderSignature;
void browserIngressSignature;
void browserEgressSignature;
void bootstrapSignature;
void nodeSenderSignature;
void nodeIngressSignature;
void nodeEgressSignature;
void nodeWebSocketSignature;
void queryOptionsContract;
void rootExtraOptionsContract;
void Sender;
