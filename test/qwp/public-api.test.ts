import { describe, expect, it } from "vitest";

import * as browser from "../../packages/browser-client/src";
import * as node from "../../packages/nodejs-client/src";
import * as shared from "../../packages/client-core/src/qwp";

const sharedRuntimeContract = [
  "QWP_INGRESS_PROGRESS_KIND",
  "QWP_DEFAULT_EGRESS_INITIAL_CREDIT",
  "QWP_DEFAULT_EGRESS_BUFFER_POOL_SIZE",
  "QWP_DEFAULT_EGRESS_SERVER_INFO_TIMEOUT_MS",
  "QWP_MAX_BATCH_ROWS_UPPER_BOUND",
  "QWP_RECONNECT_EVENT_KIND",
  "QWP_SENDER_ERROR_CATEGORY",
  "QWP_SENDER_ERROR_POLICY",
  "QWP_TARGET",
  "QWP_UPGRADE_ERROR_KIND",
  "QWP_VERSION",
  "QwpBatchTooLargeError",
  "QwpBindValues",
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
  "QwpIngressNackError",
  "QwpIngressAckTimeoutError",
  "QwpIngressSession",
  "QwpMemoryReplayAppendTimeoutError",
  "QwpMemoryReplayBatchTooLargeError",
  "QwpMemoryReplayFrameTooLargeError",
  "QwpProtocolError",
  "QwpPoolAcquireTimeoutError",
  "QwpPoolResourceError",
  "QwpReconnectExhaustedError",
  "QwpRoleMismatchError",
  "QwpReplayRejectedError",
  "QwpResultBatch",
  "QwpResultBatchView",
  "QwpResultColumnView",
  "QwpResultRowView",
  "QwpQueryLease",
  "QwpSendTimeoutError",
  "QwpSender",
  "QwpSenderCloseTimeoutError",
  "QwpUnrecoverableReplayDictionaryError",
  "QwpUpgradeError",
  "defaultQwpSenderErrorHandler",
] as const;

const browserRuntimeContract = [
  "QwpBrowserSessionBootstrapError",
  "bootstrapQwpBrowserSession",
  "connectQwpBrowserEgress",
  "connectQwpBrowserIngress",
  "connectQwpBrowserClient",
  "connectQwpBrowserSender",
  "connectQwpBrowserWebSocket",
  "createQwpBrowserConnectionFactory",
  "createQwpBrowserClient",
  "createQwpBrowserSender",
] as const;

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
  "QwpReplayStoreLockedError",
  "QwpReplayStoreLockLostError",
  "QwpReplayStoreQuarantinedError",
  "QwpUdpDatagramTooLargeError",
  "QwpVersionMismatchError",
  "connectQwpNodeEgress",
  "connectQwpNodeIngress",
  "connectQwpNodeClient",
  "connectQwpNodeSender",
  "connectQwpNodeUdp",
  "connectQwpNodeUdpSender",
  "connectQwpNodeWebSocket",
  "createQwpNodeConnectionFactory",
  "createQwpNodeClient",
  "createQwpNodeSender",
  "createQwpNodeUdpSender",
  "retryQwpNodeOrphanSlot",
  "scanQwpNodeOrphanSlots",
] as const;

function assertRuntimeContract(
  module: Record<string, unknown>,
  contract: readonly string[],
): void {
  for (const name of contract) {
    expect(module, `missing public runtime export ${name}`).toHaveProperty(
      name,
    );
  }
}

describe("QWP public API contract", () => {
  it("keeps the documented shared runtime exports", () => {
    assertRuntimeContract(shared, sharedRuntimeContract);
  });

  it("keeps the documented browser runtime exports", () => {
    assertRuntimeContract(browser, sharedRuntimeContract);
    assertRuntimeContract(browser, browserRuntimeContract);
  });

  it("keeps the documented Node.js runtime exports", () => {
    assertRuntimeContract(node, sharedRuntimeContract);
    assertRuntimeContract(node, nodeRuntimeContract);
  });
});
