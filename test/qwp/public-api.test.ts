import { describe, expect, it } from "vitest";

import * as browser from "../../src/qwp/browser";
import * as node from "../../src/qwp/node";
import * as shared from "../../src/qwp";

const sharedRuntimeContract = [
  "QWP_INGRESS_PROGRESS_KIND",
  "QWP_RECONNECT_EVENT_KIND",
  "QWP_UPGRADE_ERROR_KIND",
  "QWP_VERSION",
  "QwpBatchTooLargeError",
  "QwpBindValues",
  "QwpDurableAckUnavailableError",
  "QwpEgressQuery",
  "QwpEgressQueryError",
  "QwpEgressQueryTimeoutError",
  "QwpEgressReplayRequiredError",
  "QwpEgressSession",
  "QwpIngressNackError",
  "QwpIngressSession",
  "QwpProtocolError",
  "QwpReconnectExhaustedError",
  "QwpReplayRejectedError",
  "QwpResultBatch",
  "QwpSendTimeoutError",
  "QwpSender",
  "QwpUpgradeError",
] as const;

const browserRuntimeContract = [
  "QwpBrowserSessionBootstrapError",
  "bootstrapQwpBrowserSession",
  "connectQwpBrowserEgress",
  "connectQwpBrowserIngress",
  "connectQwpBrowserSender",
  "connectQwpBrowserWebSocket",
  "createQwpBrowserConnectionFactory",
  "createQwpBrowserSender",
] as const;

const nodeRuntimeContract = [
  "QwpNodeFileReplayStore",
  "QwpReplayStoreError",
  "QwpReplayStoreFullError",
  "QwpVersionMismatchError",
  "connectQwpNodeEgress",
  "connectQwpNodeIngress",
  "connectQwpNodeSender",
  "connectQwpNodeWebSocket",
  "createQwpNodeConnectionFactory",
  "createQwpNodeSender",
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
