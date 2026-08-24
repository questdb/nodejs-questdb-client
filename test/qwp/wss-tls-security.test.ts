import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as qwpNode from "../../src/qwp/node";
import { Sender } from "../../src/sender";

/**
 * A wss:// producer must verify the server certificate, and its authorization
 * header must carry the operator's credentials unchanged. Both are silent when
 * wrong -- a disabled check still connects, transposed Basic credentials still
 * form a header -- so nothing but an explicit assertion on the constructed TLS
 * agent and authorization catches a regression. The reused ILP fixture already
 * ships a real CA at test/certs/ca/ca.crt.
 *
 * There are two construction paths and both are asserted here: the documented
 * `wss::` connect string resolved by parseQwpNodeClientConfig(), and the
 * programmatic `new Sender({ protocol: "wss", ... })` object handled by
 * sender.ts.
 */

const CA_PATH = "test/certs/ca/ca.crt";

interface AgentTlsOptions {
  rejectUnauthorized?: boolean;
  ca?: Buffer | string;
  pfx?: Buffer | string;
  passphrase?: string;
}

/** node's http(s).Agent stores its constructor options on `.options`. */
function agentTlsOptions(agent: unknown): AgentTlsOptions {
  expect(agent, "expected a TLS agent to be constructed").toBeDefined();
  return (agent as { options: AgentTlsOptions }).options;
}

describe("QWP wss:: connect-string verifies the server certificate", () => {
  it("keeps verification on for tls_verify=on", () => {
    const options = qwpNode.parseQwpNodeClientConfig(
      "wss::addr=localhost;tls_verify=on;",
    );
    expect(agentTlsOptions(options.ingress.agent).rejectUnauthorized).toBe(
      true,
    );
  });

  it("applies a custom root CA and keeps verification on", () => {
    const options = qwpNode.parseQwpNodeClientConfig(
      `wss::addr=localhost;tls_roots=${CA_PATH};`,
    );
    const tls = agentTlsOptions(options.ingress.agent);
    expect(tls.rejectUnauthorized).toBe(true);
    expect(tls.ca).toEqual(readFileSync(CA_PATH));
    expect(tls.pfx).toBeUndefined();
  });

  it("loads a PFX trust store with its passphrase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qwp-pfx-roots-"));
    const store = join(dir, "roots.p12");
    const bytes = Uint8Array.of(1, 2, 3, 4);
    await writeFile(store, bytes);
    try {
      const options = qwpNode.parseQwpNodeClientConfig(
        `wss::addr=localhost;tls_roots=${store};tls_roots_password=secret;`,
      );
      const tls = agentTlsOptions(options.ingress.agent);
      expect(tls.rejectUnauthorized).toBe(true);
      expect(tls.pfx).toEqual(Buffer.from(bytes));
      expect(tls.passphrase).toBe("secret");
      expect(tls.ca).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("disables verification only when tls_verify=unsafe_off is explicit", () => {
    const options = qwpNode.parseQwpNodeClientConfig(
      "wss::addr=localhost;tls_verify=unsafe_off;",
    );
    expect(agentTlsOptions(options.ingress.agent).rejectUnauthorized).toBe(
      false,
    );
  });

  it("leaves TLS to node's verifying default when unconfigured", () => {
    // No explicit agent means the WebSocket upgrade uses node's default, which
    // verifies -- not an agent that silently turns verification off.
    const options = qwpNode.parseQwpNodeClientConfig("wss::addr=localhost;");
    expect(options.ingress.agent).toBeUndefined();
  });
});

describe("QWP programmatic wss sender applies TLS and authorization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Constructs a Sender for a programmatic options object and returns the
   * ingress options handed to createQwpNodeSender, without opening a socket.
   */
  function ingressFor(
    options: Record<string, unknown>,
  ): qwpNode.QwpNodeIngressOptions {
    const spy = vi
      .spyOn(qwpNode, "createQwpNodeSender")
      .mockReturnValue({ reset() {} } as unknown as qwpNode.QwpSender);
    new Sender({
      protocol: "wss",
      host: "localhost",
      port: 9000,
      ...options,
    } as never);
    expect(spy).toHaveBeenCalledTimes(1);
    return spy.mock.calls[0][0];
  }

  it("builds a verifying https agent with the configured root CA", () => {
    const tls = agentTlsOptions(ingressFor({ tls_ca: CA_PATH }).agent);
    expect(tls.rejectUnauthorized).toBe(true);
    expect(tls.ca).toEqual(readFileSync(CA_PATH));
  });

  it("verifies by default when neither tls_ca nor tls_verify is set", () => {
    expect(agentTlsOptions(ingressFor({}).agent).rejectUnauthorized).toBe(true);
  });

  it("disables verification only for tls_verify=false", () => {
    expect(
      agentTlsOptions(ingressFor({ tls_verify: false }).agent)
        .rejectUnauthorized,
    ).toBe(false);
  });

  it("encodes Basic credentials as username:password, in that order", () => {
    const authorization = ingressFor({
      username: "alice",
      password: "s3cret",
    }).authorization;
    expect(authorization).toBe(
      `Basic ${Buffer.from("alice:s3cret", "utf8").toString("base64")}`,
    );
  });

  it("prefixes a bearer token", () => {
    expect(ingressFor({ token: "tok-123" }).authorization).toBe(
      "Bearer tok-123",
    );
  });
});
