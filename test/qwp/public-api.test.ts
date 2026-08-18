import { describe, expect, it } from "vitest";

import * as browser from "../../src/qwp/browser";
import * as node from "../../src/qwp/node";
import * as shared from "../../src/qwp";

const sharedRuntimeContract = [
  "QWP_INGRESS_PROGRESS_KIND",
  "QWP_DEFAULT_EGRESS_INITIAL_CREDIT",
  "QWP_RECONNECT_EVENT_KIND",
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
  "QwpIngressSession",
  "QwpProtocolError",
  "QwpPoolAcquireTimeoutError",
  "QwpPoolResourceError",
  "QwpReconnectExhaustedError",
  "QwpRoleMismatchError",
  "QwpReplayRejectedError",
  "QwpResultBatch",
  "QwpQueryLease",
  "QwpSendTimeoutError",
  "QwpSender",
  "QwpUpgradeError",
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
  "QwpNodeFileReplayStore",
  "QwpNodeOrphanDrainer",
  "QwpReplayStoreError",
  "QwpReplayStoreFullError",
  "QwpReplayStoreLockedError",
  "QwpVersionMismatchError",
  "connectQwpNodeEgress",
  "connectQwpNodeIngress",
  "connectQwpNodeClient",
  "connectQwpNodeSender",
  "connectQwpNodeWebSocket",
  "createQwpNodeConnectionFactory",
  "createQwpNodeClient",
  "createQwpNodeSender",
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
