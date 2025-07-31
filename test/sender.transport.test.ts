// @ts-check
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { Agent } from "undici";
import http from "http";

import { Sender } from "../src";
import { SenderOptions } from "../src/options";
import { UndiciTransport } from "../src/transport/http/undici";
import { HttpTransport } from "../src/transport/http/stdlib";
import { MockProxy } from "./util/mockproxy";
import { MockHttp } from "./util/mockhttp";

const MOCK_HTTP_PORT = 9099;
const MOCK_HTTPS_PORT = 9098;
const PROXY_PORT = 9088;
const PROXY_HOST = "localhost";

const proxyOptions = {
  key: readFileSync("test/certs/server/server.key"),
  cert: readFileSync("test/certs/server/server.crt"),
  ca: readFileSync("test/certs/ca/ca.crt"),
};

const USER_NAME = "testapp";
const PRIVATE_KEY = "9b9x5WhJywDEuo1KGQWSPNxtX-6X6R2BRCKhYMMY6n8";
const AUTH: SenderOptions["auth"] = {
  keyId: USER_NAME,
  token: PRIVATE_KEY,
};

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Sender HTTP suite", function () {
  async function sendData(sender: Sender) {
    await sender
      .table("test")
      .symbol("location", "us")
      .floatColumn("temperature", 17.1)
      .at(1658484765000000000n, "ns");
    await sender.flush();
  }

  const mockHttp = new MockHttp();
  const mockHttps = new MockHttp();

  beforeAll(async function () {
    await mockHttp.start(MOCK_HTTP_PORT);
    await mockHttps.start(MOCK_HTTPS_PORT, true, proxyOptions);
  });

  afterAll(async function () {
    await mockHttp.stop();
    await mockHttps.stop();
  }, 30000);

  it("can ingest via HTTP", async function () {
    mockHttp.reset();

    const sender = await Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT}`,
    );
    await sendData(sender);
    expect(mockHttp.numOfRequests).toBe(1);

    await sender.close();
  });

  it("can ingest via HTTPS", async function () {
    mockHttps.reset();

    const senderCertCheckFail = await Sender.fromConfig(
      `https::addr=${PROXY_HOST}:${MOCK_HTTPS_PORT};protocol_version=2`,
    );
    await expect(
      async () => await sendData(senderCertCheckFail),
    ).rejects.toThrowError("self-signed certificate in certificate chain");
    await senderCertCheckFail.close();

    const senderWithCA = await Sender.fromConfig(
      `https::addr=${PROXY_HOST}:${MOCK_HTTPS_PORT};protocol_version=2;tls_ca=test/certs/ca/ca.crt`,
    );
    await sendData(senderWithCA);
    expect(mockHttps.numOfRequests).toEqual(1);
    await senderWithCA.close();

    const senderVerifyOff = await Sender.fromConfig(
      `https::addr=${PROXY_HOST}:${MOCK_HTTPS_PORT};protocol_version=2;tls_verify=unsafe_off`,
    );
    await sendData(senderVerifyOff);
    expect(mockHttps.numOfRequests).toEqual(2);
    await senderVerifyOff.close();
  }, 20000);

  it("can ingest via HTTP with basic auth", async function () {
    mockHttp.reset({ username: "user1", password: "pwd" });

    const sender = await Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};username=user1;password=pwd`,
    );
    await sendData(sender);
    expect(mockHttp.numOfRequests).toEqual(1);
    await sender.close();

    const senderFailPwd = await Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};username=user1;password=xyz`,
    );
    await expect(
      async () => await sendData(senderFailPwd),
    ).rejects.toThrowError("HTTP request failed, statusCode=401");
    await senderFailPwd.close();

    const senderFailMissingPwd = await Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};username=user1z`,
    );
    await expect(
      async () => await sendData(senderFailMissingPwd),
    ).rejects.toThrowError("HTTP request failed, statusCode=401");
    await senderFailMissingPwd.close();

    const senderFailUsername = await Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};username=xyz;password=pwd`,
    );
    await expect(
      async () => await sendData(senderFailUsername),
    ).rejects.toThrowError("HTTP request failed, statusCode=401");
    await senderFailUsername.close();

    const senderFailMissingUsername = await Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};password=pwd`,
    );
    await expect(
      async () => await sendData(senderFailMissingUsername),
    ).rejects.toThrowError("HTTP request failed, statusCode=401");
    await senderFailMissingUsername.close();

    const senderFailMissing = await Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT}`,
    );
    await expect(
      async () => await sendData(senderFailMissing),
    ).rejects.toThrowError("HTTP request failed, statusCode=401");
    await senderFailMissing.close();
  });

  it("can ingest via HTTP with token auth", async function () {
    mockHttp.reset({ token: "abcdefghijkl123" });

    const sender = await Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};token=abcdefghijkl123`,
    );
    await sendData(sender);
    expect(mockHttp.numOfRequests).toBe(1);
    await sender.close();

    const senderFailToken = await Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};token=xyz`,
    );
    await expect(
      async () => await sendData(senderFailToken),
    ).rejects.toThrowError("HTTP request failed, statusCode=401");
    await senderFailToken.close();

    const senderFailMissing = await Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT}`,
    );
    await expect(
      async () => await sendData(senderFailMissing),
    ).rejects.toThrowError("HTTP request failed, statusCode=401");
    await senderFailMissing.close();
  });

  it("can retry via HTTP", async function () {
    mockHttp.reset({ responseCodes: [204, 500, 523, 504, 500] });

    const sender = await Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT}`,
    );
    await sendData(sender);
    expect(mockHttp.numOfRequests).toBe(5);

    await sender.close();
  });

  it("fails when retry timeout expires", async function () {
    // artificial delay (responseDelays) is the same as retry timeout,
    // this should result in the request failing on the second try.
    mockHttp.reset({
      responseCodes: [204, 500, 503],
      responseDelays: [1000, 1000, 1000],
    });

    const sender = await Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};retry_timeout=1000`,
    );
    await expect(async () => await sendData(sender)).rejects.toThrowError(
      "HTTP request timeout, no response from server in time",
    );
    await sender.close();
  });

  it("fails when HTTP request times out", async function () {
    // artificial delay (responseDelays) is greater than request timeout, and retry is switched off
    // should result in the request failing with timeout
    mockHttp.reset({
      responseCodes: [204],
      responseDelays: [1000],
    });

    const sender = await Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};retry_timeout=0;request_timeout=100`,
    );
    await expect(async () => await sendData(sender)).rejects.toThrowError(
      "HTTP request timeout, no response from server in time",
    );
    await sender.close();
  });

  it("succeeds on the third request after two timeouts", async function () {
    mockHttp.reset({
      responseCodes: [204, 504, 504],
      responseDelays: [2000, 2000],
    });

    const sender = await Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};retry_timeout=600000;request_timeout=1000`,
    );
    await sendData(sender);

    await sender.close();
  });

  it("multiple senders can use a single HTTP agent", async function () {
    mockHttp.reset();
    const agent = new Agent({ connect: { keepAlive: false } });

    const num = 300;
    const senders: Sender[] = [];
    const promises: Promise<void>[] = [];
    for (let i = 0; i < num; i++) {
      const sender = await Sender.fromConfig(
        `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT}`,
        { agent: agent },
      );
      senders.push(sender);
      const promise = sendData(sender);
      promises.push(promise);
    }
    await Promise.all(promises);
    expect(mockHttp.numOfRequests).toBe(num);

    for (const sender of senders) {
      await sender.close();
    }
    await agent.destroy();
  });

  it("supports custom Undici HTTP agent", async function () {
    mockHttp.reset();
    const agent = new Agent({ pipelining: 3 });

    const sender = await Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT}`,
      { agent: agent },
    );

    await sendData(sender);
    expect(mockHttp.numOfRequests).toBe(1);

    // @ts-expect-error - Accessing private field
    const senderAgent = (sender.transport as UndiciTransport).agent;
    const symbols = Object.getOwnPropertySymbols(senderAgent);
    expect(senderAgent[symbols[6]]).toEqual({ pipelining: 3 });

    await sender.close();
    await agent.destroy();
  });

  it("supports custom stdlib HTTP agent", async function () {
    mockHttp.reset();
    const agent = new http.Agent({ maxSockets: 128 });

    const sender = await Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};stdlib_http=on`,
      { agent: agent },
    );
    await sendData(sender);
    expect(mockHttp.numOfRequests).toBe(1);

    // @ts-expect-error - Accessing private field
    const senderAgent = (sender.transport as HttpTransport).agent;
    expect(senderAgent.maxSockets).toBe(128);

    await sender.close();
    agent.destroy();
  });
});

describe("Sender TCP suite", function () {
  async function createProxy(
    auth = false,
    tlsOptions?: Record<string, unknown>,
  ) {
    const mockConfig = { auth: auth, assertions: true };
    const proxy = new MockProxy(mockConfig);
    await proxy.start(PROXY_PORT, tlsOptions);
    expect(proxy.mockConfig).toBe(mockConfig);
    expect(proxy.dataSentToRemote).toStrictEqual([]);
    return proxy;
  }

  async function createSender(auth: SenderOptions["auth"], secure = false) {
    const sender = new Sender({
      protocol: secure ? "tcps" : "tcp",
      protocol_version: "1",
      port: PROXY_PORT,
      host: PROXY_HOST,
      auth: auth,
      tls_ca: "test/certs/ca/ca.crt",
    });
    const connected = await sender.connect();
    expect(connected).toBe(true);
    return sender;
  }

  async function sendData(sender: Sender) {
    await sender
      .table("test")
      .symbol("location", "us")
      .floatColumn("temperature", 17.1)
      .at(1658484765000000000n, "ns");
    await sender.flush();
  }

  async function assertSentData(
    proxy: MockProxy,
    authenticated: boolean,
    expected: string,
    timeout = 60000,
  ) {
    const interval = 100;
    const num = timeout / interval;
    let actual: string;
    for (let i = 0; i < num; i++) {
      const dataSentToRemote = proxy.getDataSentToRemote().join("").split("\n");
      if (authenticated) {
        dataSentToRemote.splice(1, 1);
      }
      actual = dataSentToRemote.join("\n");
      if (actual === expected) {
        return new Promise((resolve) => resolve(null));
      }
      await sleep(interval);
    }
    return new Promise((resolve) =>
      resolve(`data assert failed [expected=${expected}, actual=${actual}]`),
    );
  }

  it("can authenticate", async function () {
    const proxy = await createProxy(true);
    const sender = await createSender(AUTH);
    await assertSentData(proxy, true, "testapp\n");
    await sender.close();
    await proxy.stop();
  });

  it("can authenticate with a different private key", async function () {
    const proxy = await createProxy(true);
    const sender = await createSender({
      keyId: "user1",
      token: "zhPiK3BkYMYJvRf5sqyrWNJwjDKHOWHnRbmQggUll6A",
    });
    await assertSentData(proxy, true, "user1\n");
    await sender.close();
    await proxy.stop();
  });

  it("is backwards compatible and still can authenticate with full JWK", async function () {
    const JWK = {
      x: "BtUXC_K3oAyGlsuPjTgkiwirMUJhuRQDfcUHeyoxFxU",
      y: "R8SOup-rrNofB7wJagy4HrJhTVfrVKmj061lNRk3bF8",
      kid: "user2",
      kty: "EC",
      d: "hsg6Zm4kSBlIEvKUWT3kif-2y2Wxw-iWaGrJxrPXQhs",
      crv: "P-256",
    };

    const proxy = await createProxy(true);
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      port: PROXY_PORT,
      host: PROXY_HOST,
      jwk: JWK,
    });
    const connected = await sender.connect();
    expect(connected).toBe(true);
    await assertSentData(proxy, true, "user2\n");
    await sender.close();
    await proxy.stop();
  });

  it("can connect unauthenticated", async function () {
    const proxy = await createProxy();
    // @ts-expect-error - Invalid options
    const sender = await createSender();
    await assertSentData(proxy, false, "");
    await sender.close();
    await proxy.stop();
  });

  it("can authenticate and send data to server", async function () {
    const proxy = await createProxy(true);
    const sender = await createSender(AUTH);
    await sendData(sender);
    await assertSentData(
      proxy,
      true,
      "testapp\ntest,location=us temperature=17.1 1658484765000000000\n",
    );
    await sender.close();
    await proxy.stop();
  });

  it("can connect unauthenticated and send data to server", async function () {
    const proxy = await createProxy();
    // @ts-expect-error - Invalid options
    const sender = await createSender();
    await sendData(sender);
    await assertSentData(
      proxy,
      false,
      "test,location=us temperature=17.1 1658484765000000000\n",
    );
    await sender.close();
    await proxy.stop();
  });

  it("can authenticate and send data to server via secure connection", async function () {
    const proxy = await createProxy(true, proxyOptions);
    const sender = await createSender(AUTH, true);
    await sendData(sender);
    await assertSentData(
      proxy,
      true,
      "testapp\ntest,location=us temperature=17.1 1658484765000000000\n",
    );
    await sender.close();
    await proxy.stop();
  });

  it("can connect unauthenticated and send data to server via secure connection", async function () {
    const proxy = await createProxy(false, proxyOptions);
    const sender = await createSender(null, true);
    await sendData(sender);
    await assertSentData(
      proxy,
      false,
      "test,location=us temperature=17.1 1658484765000000000\n",
    );
    await sender.close();
    await proxy.stop();
  });

  it("fails to connect without hostname and port", async function () {
    await expect(
      async () => await new Sender({ protocol: "tcp" }).close(),
    ).rejects.toThrow("The 'host' option is mandatory");
  });

  it("fails to send data if not connected", async function () {
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "2",
      host: "localhost",
    });
    await expect(async () => {
      await sender.table("test").symbol("location", "us").atNow();
      await sender.flush();
    }).rejects.toThrow("TCP transport is not connected");
    await sender.close();
  });

  it("guards against multiple connect calls", async function () {
    const proxy = await createProxy(true, proxyOptions);
    const sender = await createSender(AUTH, true);
    await expect(async () => await sender.connect()).rejects.toThrow(
      "Sender connected already",
    );
    await sender.close();
    await proxy.stop();
  });

  it("guards against concurrent connect calls", async function () {
    const proxy = await createProxy(true, proxyOptions);
    const sender = new Sender({
      protocol: "tcps",
      protocol_version: "1",
      port: PROXY_PORT,
      host: PROXY_HOST,
      auth: AUTH,
      tls_ca: "test/certs/ca/ca.crt",
    });
    await expect(
      async () => await Promise.all([sender.connect(), sender.connect()]),
    ).rejects.toThrow("Sender connected already");
    await sender.close();
    await proxy.stop();
  });

  it("can disable the server certificate check", async function () {
    const proxy = await createProxy(true, proxyOptions);
    const senderCertCheckFail = await Sender.fromConfig(
      `tcps::addr=${PROXY_HOST}:${PROXY_PORT};protocol_version=1`,
    );
    await expect(
      async () => await senderCertCheckFail.connect(),
    ).rejects.toThrow("self-signed certificate in certificate chain");
    await senderCertCheckFail.close();

    const senderCertCheckOn = await Sender.fromConfig(
      `tcps::addr=${PROXY_HOST}:${PROXY_PORT};protocol_version=1;tls_ca=test/certs/ca/ca.crt`,
    );
    await senderCertCheckOn.connect();
    await senderCertCheckOn.close();

    const senderCertCheckOff = await Sender.fromConfig(
      `tcps::addr=${PROXY_HOST}:${PROXY_PORT};protocol_version=1;tls_verify=unsafe_off`,
    );
    await senderCertCheckOff.connect();
    await senderCertCheckOff.close();
    await proxy.stop();
  });

  it("can handle unfinished rows during flush()", async function () {
    const proxy = await createProxy(true, proxyOptions);
    const sender = await createSender(AUTH, true);
    sender.table("test").symbol("location", "us");
    const sent = await sender.flush();
    expect(sent).toBe(false);
    await assertSentData(proxy, true, "testapp\n");
    await sender.close();
    await proxy.stop();
  });

  it("supports custom logger", async function () {
    const expectedMessages = [
      "Successfully connected to localhost:9088",
      /^Connection to .*1:9088 is closed$/,
    ];
    const log = (
      level: "error" | "warn" | "info" | "debug",
      message: string,
    ) => {
      if (level !== "debug") {
        expect(level).toBe("info");
        expect(message).toMatch(expectedMessages.shift());
      }
    };
    const proxy = await createProxy();
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      port: PROXY_PORT,
      host: PROXY_HOST,
      log: log,
    });
    await sender.connect();
    await sendData(sender);
    await assertSentData(
      proxy,
      false,
      "test,location=us temperature=17.1 1658484765000000000\n",
    );
    await sender.close();
    await proxy.stop();
  });

  it("warns if data is lost on close()", async function () {
    // we expect a warning about non-flushed data at close()
    const expectedMessages = [
      "Successfully connected to localhost:9088",
      `Buffer contains data which has not been flushed before closing the sender, and it will be lost [position=${"test,location=gb".length}]`,
      /^Connection to .*1:9088 is closed$/,
    ];
    const log = (
        level: "error" | "warn" | "info" | "debug",
        message: string,
    ) => {
      if (level !== "debug") {
        expect(message).toMatch(expectedMessages.shift());
      }
    };
    const proxy = await createProxy();
    const sender = new Sender({
      protocol: "tcp",
      protocol_version: "1",
      port: PROXY_PORT,
      host: PROXY_HOST,
      log: log,
    });
    await sender.connect();
    await sendData(sender);

    // write something into the buffer without calling flush()
    sender.table("test").symbol("location", "gb");

    // assert that only the first line was sent
    await assertSentData(
        proxy,
        false,
        "test,location=us temperature=17.1 1658484765000000000\n",
    );
    await sender.close();
    await proxy.stop();
  });
});
