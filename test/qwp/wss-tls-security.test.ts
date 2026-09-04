import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import { Agent as UndiciAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
// Spy on the module Sender imports, rather than the public re-export facade.
import * as qwpNode from "../../packages/nodejs-client/src/qwp";
import { Sender } from "../../packages/nodejs-client/src/sender";
import {
  SenderOptions,
  qwpConfig,
} from "../../packages/nodejs-client/src/options";

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
const TRUSTED_CA_PATH = "test/certs/ca/ca-trusted.crt";

interface AgentTlsOptions {
  rejectUnauthorized?: boolean;
  ca?: Buffer | string;
  pfx?: Buffer | string;
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

  it.each([
    ["CERTIFICATE", CA_PATH],
    ["TRUSTED CERTIFICATE", TRUSTED_CA_PATH],
  ])("trusts a server signed by a %s PEM root", async (_label, rootsPath) => {
    const server = https.createServer(
      {
        key: readFileSync("test/certs/server/server.key"),
        cert: readFileSync("test/certs/server/server.crt"),
      },
      (_request, response) => {
        response.end("ok");
      },
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const port = (server.address() as AddressInfo).port;
      const options = qwpNode.parseQwpNodeClientConfig(
        `wss::addr=127.0.0.1:${port};tls_roots=${rootsPath};`,
      );
      await new Promise<void>((resolve, reject) => {
        const request = https.get(
          {
            hostname: "127.0.0.1",
            port,
            agent: options.ingress.agent as https.Agent,
          },
          (response) => {
            response.resume();
            response.once("end", resolve);
            response.once("error", reject);
          },
        );
        request.once("error", reject);
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects password-protected PKCS#12 trust stores with PEM guidance", () => {
    expect(() =>
      qwpNode.parseQwpNodeClientConfig(
        "wss::addr=localhost;tls_roots=roots.p12;tls_roots_password=secret;",
      ),
    ).toThrow(/tls_roots_password.*PEM-encoded CA certificates.*PKCS#12/);
  });

  it("rejects non-PEM tls_roots before opening a connection", () => {
    expect(() =>
      qwpNode.parseQwpNodeClientConfig(
        "wss::addr=localhost;tls_roots=package.json;",
      ),
    ).toThrow(/PEM-encoded CA certificates.*PKCS#12/);
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

  it("rejects a caller agent combined with tls_verify", () => {
    // The agent is the upgrade's sole TLS channel, so preferring it silently
    // dropped the verification tls_verify asked for. Reject, don't drop.
    expect(() =>
      qwpNode.parseQwpNodeClientConfig("wss::addr=localhost;tls_verify=on;", {
        webSocket: { agent: new https.Agent() },
      }),
    ).toThrow(/custom QWP WebSocket agent cannot be combined/);
  });

  it("rejects a caller agent combined with tls_roots", () => {
    expect(() =>
      qwpNode.parseQwpNodeClientConfig(
        `wss::addr=localhost;tls_roots=${CA_PATH};`,
        { webSocket: { agent: new https.Agent() } },
      ),
    ).toThrow(/custom QWP WebSocket agent cannot be combined/);
  });

  it("keeps a caller agent when no TLS keys are set", () => {
    // Without tls_verify/tls_roots the caller owns TLS through their agent, so
    // it passes through unchanged rather than being rejected.
    const agent = new https.Agent();
    const options = qwpNode.parseQwpNodeClientConfig("wss::addr=localhost;", {
      webSocket: { agent },
    });
    expect(options.ingress.agent).toBe(agent);
  });

  it("promotes a top-level https agent onto the wss connect string", async () => {
    const agent = new https.Agent();
    const options = await SenderOptions.fromConfig("wss::addr=localhost;", {
      agent,
    });
    expect(qwpConfig(options)?.ingress.agent).toBe(agent);
  });

  it("does not promote a plain http agent onto wss", async () => {
    // https.Agent extends http.Agent, so the old instanceof http.Agent test
    // admitted a bare http.Agent that fails a wss upgrade with
    // ERR_INVALID_PROTOCOL. It is ignored now, leaving node's verifying default.
    const logger = vi.fn();
    const options = await SenderOptions.fromConfig("wss::addr=localhost;", {
      agent: new http.Agent(),
      log: logger,
    });
    expect(qwpConfig(options)?.ingress.agent).toBeUndefined();
    expect(logger).toHaveBeenCalledWith(
      "warn",
      expect.stringMatching(
        /Ignoring Node\.js http\.Agent.*QWP wss.*https\.Agent/,
      ),
    );
  });

  it("warns when an undici agent cannot be promoted onto wss", async () => {
    const agent = new UndiciAgent();
    const logger = vi.fn();
    try {
      const options = await SenderOptions.fromConfig("wss::addr=localhost;", {
        agent,
        log: logger,
      });
      expect(qwpConfig(options)?.ingress.agent).toBeUndefined();
      expect(logger).toHaveBeenCalledWith(
        "warn",
        expect.stringMatching(/Ignoring undici\.Agent.*QWP wss.*https\.Agent/),
      );
    } finally {
      await agent.close();
    }
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

  /**
   * Constructs a wss Sender, stubbing createQwpNodeSender so a construction
   * that fails to reject does not open a real socket. For the throwing cases.
   */
  function constructWss(options: Record<string, unknown>): void {
    vi.spyOn(qwpNode, "createQwpNodeSender").mockReturnValue({
      reset() {},
    } as unknown as qwpNode.QwpSender);
    new Sender({
      protocol: "wss",
      host: "localhost",
      port: 9000,
      ...options,
    } as never);
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

  it("keeps a caller https agent for the wss upgrade", () => {
    const agent = new https.Agent();
    expect(ingressFor({ agent }).agent).toBe(agent);
  });

  it("does not admit a plain http agent to a wss upgrade", () => {
    // A bare http.Agent would fail the wss upgrade with ERR_INVALID_PROTOCOL
    // after at()/atNow() already accepted rows. It is ignored, leaving the
    // verifying default agent in place instead.
    const logger = vi.fn();
    const ingress = ingressFor({ agent: new http.Agent(), log: logger });
    expect(ingress.agent).toBeInstanceOf(https.Agent);
    expect(agentTlsOptions(ingress.agent).rejectUnauthorized).toBe(true);
    expect(logger).toHaveBeenCalledWith(
      "warn",
      expect.stringMatching(
        /Ignoring Node\.js http\.Agent.*QWP wss.*https\.Agent/,
      ),
    );
  });

  it("warns before replacing an undici agent with the wss default", async () => {
    const agent = new UndiciAgent();
    const logger = vi.fn();
    try {
      const ingress = ingressFor({ agent, log: logger });
      expect(ingress.agent).toBeInstanceOf(https.Agent);
      expect(logger).toHaveBeenCalledWith(
        "warn",
        expect.stringMatching(/Ignoring undici\.Agent.*QWP wss.*https\.Agent/),
      );
    } finally {
      await agent.close();
    }
  });

  it("rejects a caller agent combined with tls_verify", () => {
    // Passing an agent alongside tls_verify used to silently drop tls_verify,
    // letting an insecure agent connect with verification requested on.
    expect(() =>
      constructWss({ agent: new https.Agent(), tls_verify: false }),
    ).toThrow(/custom QWP WebSocket agent cannot be combined/);
  });

  it("rejects a caller agent combined with tls_ca", () => {
    expect(() =>
      constructWss({ agent: new https.Agent(), tls_ca: CA_PATH }),
    ).toThrow(/custom QWP WebSocket agent cannot be combined/);
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

  it("rejects Bearer authentication combined with Basic credentials", () => {
    expect(() =>
      constructWss({
        username: "alice",
        password: "s3cret",
        token: "tok-123",
      }),
    ).toThrow(
      "QWP 'token' authentication cannot be combined with 'username'/'password'",
    );
  });

  it("rejects empty programmatic authentication secrets", () => {
    expect(() => constructWss({ username: "alice", password: "" })).toThrow(
      "QWP Basic authentication requires both 'username' and 'password'",
    );
    expect(() => constructWss({ token: "" })).toThrow(
      "QWP Bearer authentication requires a non-empty 'token'",
    );
  });

  it("rejects the JWK credentials QWP has no way to honour", () => {
    // qwpAuthorization() reads username/password/token only, so an ILP-style
    // auth or jwk object was dropped in silence and the upgrade went out
    // unauthenticated -- while the sibling udp path rejects the very same
    // keys. token_x/token_y are what a TCP JWK config still carries once the
    // renamed keys are removed, and are named for the same reason udp names
    // them.
    for (const credential of [
      { auth: { keyId: "admin", token: "priv" } },
      { jwk: { kid: "admin", d: "priv", x: "a", y: "b", kty: "EC" } },
      { token_x: "aa" },
      { token_y: "bb" },
    ]) {
      expect(
        () => constructWss(credential),
        JSON.stringify(credential),
      ).toThrow(
        "JWK authentication is not supported for QWP WebSocket transport",
      );
    }
  });

  it("rejects tls_verify and tls_ca on the plaintext ws protocol", () => {
    // `ws::` rejects these through the QWP schema; the programmatic object
    // read neither, so a caller who meant wss and supplied a CA got a
    // plaintext socket and no diagnostic. tls_ca was not even opened, so a
    // missing file went unnoticed too.
    vi.spyOn(qwpNode, "createQwpNodeSender").mockReturnValue({
      reset() {},
    } as unknown as qwpNode.QwpSender);
    for (const tls of [{ tls_verify: false }, { tls_ca: CA_PATH }]) {
      expect(
        () =>
          new Sender({
            protocol: "ws",
            host: "localhost",
            port: 9000,
            ...tls,
          } as never),
        JSON.stringify(tls),
      ).toThrow("tls_verify and tls_ca are only supported by the wss protocol");
    }
    // wss still accepts both.
    expect(agentTlsOptions(ingressFor({ tls_ca: CA_PATH }).agent).ca).toEqual(
      readFileSync(CA_PATH),
    );
  });

  it("rejects a custom authorization header combined with credentials", () => {
    // The adjacent agent branch rejects exactly this shape of ambiguity for
    // TLS -- "rather than doing either quietly". The header silently won over
    // username/password, so the sender connected as a different principal
    // than the credentials the caller also supplied.
    for (const credentials of [
      { username: "alice", password: "s3cret" },
      { token: "tok-123" },
    ]) {
      expect(
        () =>
          constructWss({
            ...credentials,
            qwp: { webSocket: { authorization: "Bearer override" } },
          }),
        JSON.stringify(credentials),
      ).toThrow(/cannot be combined with 'username'\/'password' or 'token'/);
    }
    // On its own the explicit header is still the way to supply a scheme the
    // option vocabulary does not cover.
    expect(
      ingressFor({ qwp: { webSocket: { authorization: "Negotiate abc" } } })
        .authorization,
    ).toBe("Negotiate abc");
  });

  it("rejects connect-string credentials combined with custom authorization", async () => {
    const extraOptions = {
      qwp: { webSocket: { authorization: "Bearer override" } },
    };
    for (const configuration of [
      "wss::addr=localhost;username=alice;password=s3cret;",
      "wss::addr=localhost;token=tok-123;",
    ]) {
      await expect(
        Sender.fromConfig(configuration, extraOptions),
        configuration,
      ).rejects.toThrow(
        /cannot be combined with 'username'\/'password' or 'token'/,
      );
      expect(
        () =>
          qwpNode.parseQwpNodeClientConfig(configuration, {
            webSocket: extraOptions.qwp.webSocket,
          }),
        configuration,
      ).toThrow(/cannot be combined with 'username'\/'password' or 'token'/);
    }
  });
});
