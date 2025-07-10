import { Sender } from "../src";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DEFAULT_BUFFER_SIZE, DEFAULT_MAX_BUFFER_SIZE } from "../src/sender";
import { readFileSync } from "fs";
import { MockProxy } from "./_utils_/mockproxy";
import { MockHttp } from "./_utils_/mockhttp";
import { GenericContainer } from "testcontainers";
import http from "http";
import { Agent } from "undici";
import { SenderOptions } from "../src/options";
import { fail } from "node:assert";
import { log } from "../src/logging";

const HTTP_OK = 200;

const QUESTDB_HTTP_PORT = 9000;
const QUESTDB_ILP_PORT = 9009;
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

describe("Sender configuration options suite", function () {
  it("creates a sender from a configuration string", async function () {
    await Sender.fromConfig("tcps::addr=hostname;").close();
  });

  it("creates a sender from a configuration string picked up from env", async function () {
    process.env.QDB_CLIENT_CONF = "https::addr=hostname;";
    await Sender.fromEnv().close();
  });

  it("throws exception if the username or the token is missing when TCP transport is used", async function () {
    try {
      await Sender.fromConfig("tcp::addr=hostname;username=bobo;").close();
      fail("Expected error is not thrown");
    } catch (err) {
      expect(err.message).toBe(
        "TCP transport requires a username and a private key for authentication, please, specify the 'username' and 'token' config options",
      );
    }

    try {
      await Sender.fromConfig("tcp::addr=hostname;token=bobo_token;").close();
      fail("Expected error is not thrown");
    } catch (err) {
      expect(err.message).toBe(
        "TCP transport requires a username and a private key for authentication, please, specify the 'username' and 'token' config options",
      );
    }
  });

  it("throws exception if tls_roots or tls_roots_password is used", async function () {
    try {
      await Sender.fromConfig(
        "tcps::addr=hostname;username=bobo;tls_roots=bla;",
      ).close();
      fail("Expected error is not thrown");
    } catch (err) {
      expect(err.message).toBe(
        "'tls_roots' and 'tls_roots_password' options are not supported, please, use the 'tls_ca' option or the NODE_EXTRA_CA_CERTS environment variable instead",
      );
    }

    try {
      await Sender.fromConfig(
        "tcps::addr=hostname;token=bobo_token;tls_roots_password=bla;",
      ).close();
      fail("Expected error is not thrown");
    } catch (err) {
      expect(err.message).toBe(
        "'tls_roots' and 'tls_roots_password' options are not supported, please, use the 'tls_ca' option or the NODE_EXTRA_CA_CERTS environment variable instead",
      );
    }
  });

  it("throws exception if connect() is called when http transport is used", async function () {
    let sender: Sender;
    try {
      sender = Sender.fromConfig("http::addr=hostname");
      await sender.connect();
      fail("Expected error is not thrown");
    } catch (err) {
      expect(err.message).toBe(
        "'connect()' should be called only if the sender connects via TCP",
      );
    }
    await sender.close();
  });
});

describe("Sender options test suite", function () {
  it("fails if no options defined", async function () {
    try {
      // @ts-expect-error - Testing invalid options
      await new Sender().close();
      fail("Expected error is not thrown");
    } catch (err) {
      expect(err.message).toBe("The 'protocol' option is mandatory");
    }
  });

  it("fails if options are null", async function () {
    try {
      await new Sender(null).close();
      fail("Expected error is not thrown");
    } catch (err) {
      expect(err.message).toBe("The 'protocol' option is mandatory");
    }
  });

  it("fails if options are undefined", async function () {
    try {
      await new Sender(undefined).close();
      fail("Expected error is not thrown");
    } catch (err) {
      expect(err.message).toBe("The 'protocol' option is mandatory");
    }
  });

  it("fails if options are empty", async function () {
    try {
      // @ts-expect-error - Testing invalid options
      await new Sender({}).close();
      fail("Expected error is not thrown");
    } catch (err) {
      expect(err.message).toBe("The 'protocol' option is mandatory");
    }
  });

  it("fails if protocol option is missing", async function () {
    try {
      // @ts-expect-error - Testing invalid options
      await new Sender({ host: "host" }).close();
      fail("Expected error is not thrown");
    } catch (err) {
      expect(err.message).toBe("The 'protocol' option is mandatory");
    }
  });

  it("fails if protocol option is invalid", async function () {
    try {
      await new Sender({ protocol: "abcd" }).close();
      fail("Expected error is not thrown");
    } catch (err) {
      expect(err.message).toBe("Invalid protocol: 'abcd'");
    }
  });

  it("sets default buffer size if init_buf_size is not set", async function () {
    const sender = new Sender({
      protocol: "http",
      host: "host",
    });
    expect(sender.bufferSize).toBe(DEFAULT_BUFFER_SIZE);
    await sender.close();
  });

  it("sets the requested buffer size if init_buf_size is set", async function () {
    const sender = new Sender({
      protocol: "http",
      host: "host",
      init_buf_size: 1024,
    });
    expect(sender.bufferSize).toBe(1024);
    await sender.close();
  });

  it("sets default buffer size if init_buf_size is set to null", async function () {
    const sender = new Sender({
      protocol: "http",
      host: "host",
      init_buf_size: null,
    });
    expect(sender.bufferSize).toBe(DEFAULT_BUFFER_SIZE);
    await sender.close();
  });

  it("sets default buffer size if init_buf_size is set to undefined", async function () {
    const sender = new Sender({
      protocol: "http",
      host: "host",
      init_buf_size: undefined,
    });
    expect(sender.bufferSize).toBe(DEFAULT_BUFFER_SIZE);
    await sender.close();
  });

  it("sets default buffer size if init_buf_size is not a number", async function () {
    const sender = new Sender({
      protocol: "http",
      host: "host",
      // @ts-expect-error - Testing invalid options
      init_buf_size: "1024",
    });
    expect(sender.bufferSize).toBe(DEFAULT_BUFFER_SIZE);
    await sender.close();
  });

  it("sets the requested buffer size if 'bufferSize' is set, but warns that it is deprecated", async function () {
    const log = (level: "error" | "warn" | "info" | "debug", message: string) => {
      expect(level).toBe("warn");
      expect(message).toMatch("Option 'bufferSize' is not supported anymore, please, replace it with 'init_buf_size'");
    };
    const sender = new Sender({
      protocol: "http",
      host: "host",
      // @ts-expect-error - Testing deprecated option
      bufferSize: 2048,
      log: log,
    });
    expect(sender.bufferSize).toBe(2048);
    await sender.close();
  });

  it("warns about deprecated option 'copy_buffer'", async function () {
    const log = (level: "error" | "warn" | "info" | "debug", message: string) => {
      expect(level).toBe("warn");
      expect(message).toMatch("Option 'copy_buffer' is not supported anymore, please, remove it");
    };
    const sender = new Sender({
      protocol: "http",
      host: "host",
      // @ts-expect-error - Testing deprecated option
      copy_buffer: false,
      log: log,
    });
    await sender.close();
  });

  it("warns about deprecated option 'copyBuffer'", async function () {
    const log = (level: "error" | "warn" | "info" | "debug", message: string) => {
      expect(level).toBe("warn");
      expect(message).toMatch("Option 'copyBuffer' is not supported anymore, please, remove it");
    };
    const sender = new Sender({
      protocol: "http",
      host: "host",
      // @ts-expect-error - Testing deprecated option
      copyBuffer: false,
      log: log,
    });
    await sender.close();
  });

  it("sets default max buffer size if max_buf_size is not set", async function () {
    const sender = new Sender({ protocol: "http", host: "host" });
    expect(sender.maxBufferSize).toBe(DEFAULT_MAX_BUFFER_SIZE);
    await sender.close();
  });

  it("sets the requested max buffer size if max_buf_size is set", async function () {
    const sender = new Sender({
      protocol: "http",
      host: "host",
      max_buf_size: 131072,
    });
    expect(sender.maxBufferSize).toBe(131072);
    await sender.close();
  });

  it("throws error if initial buffer size is greater than max_buf_size", async function () {
    try {
      await new Sender({
        protocol: "http",
        host: "host",
        max_buf_size: 8192,
        init_buf_size: 16384,
      }).close();
      fail('Expected error is not thrown');
    } catch (err) {
      expect(err.message).toBe(
        "Max buffer size is 8192 bytes, requested buffer size: 16384",
      );
    }
  });

  it("sets default max buffer size if max_buf_size is set to null", async function () {
    const sender = new Sender({
      protocol: "http",
      host: "host",
      max_buf_size: null,
    });
    expect(sender.maxBufferSize).toBe(DEFAULT_MAX_BUFFER_SIZE);
    await sender.close();
  });

  it("sets default max buffer size if max_buf_size is set to undefined", async function () {
    const sender = new Sender({
      protocol: "http",
      host: "host",
      max_buf_size: undefined,
    });
    expect(sender.maxBufferSize).toBe(DEFAULT_MAX_BUFFER_SIZE);
    await sender.close();
  });

  it("sets default max buffer size if max_buf_size is not a number", async function () {
    const sender = new Sender({
      protocol: "http",
      host: "host",
      // @ts-expect-error - Testing invalid vlaue
      max_buf_size: "1024",
    });
    expect(sender.maxBufferSize).toBe(DEFAULT_MAX_BUFFER_SIZE);
    await sender.close();
  });

  it("uses default logger if log function is not set", async function () {
    const sender = new Sender({ protocol: "http", host: "host" });
    expect(sender.log).toBe(log);
    await sender.close();
  });

  it("uses the required log function if it is set", async function () {
    const testFunc = () => { };
    const sender = new Sender({
      protocol: "http",
      host: "host",
      log: testFunc,
    });
    expect(sender.log).toBe(testFunc);
    await sender.close();
  });

  it("uses default logger if log is set to null", async function () {
    const sender = new Sender({ protocol: "http", host: "host", log: null });
    expect(sender.log).toBe(log);
    await sender.close();
  });

  it("uses default logger if log is set to undefined", async function () {
    const sender = new Sender({
      protocol: "http",
      host: "host",
      log: undefined,
    });
    expect(sender.log).toBe(log);
    await sender.close();
  });

  it("uses default logger if log is not a function", async function () {
    // @ts-expect-error - Testing invalid options
    const sender = new Sender({ protocol: "http", host: "host", log: "" });
    expect(sender.log).toBe(log);
    await sender.close();
  });
});

describe("Sender auth config checks suite", function () {
  it("requires a username for authentication", async function () {
    try {
      await new Sender({
        protocol: "tcp",
        host: "host",
        auth: {
          token: "privateKey",
        },
      }).close();
      fail("it should not be able to create the sender");
    } catch (err) {
      expect(err.message).toBe(
        "Missing username, please, specify the 'keyId' property of the 'auth' config option. " +
        "For example: new Sender({protocol: 'tcp', host: 'host', auth: {keyId: 'username', token: 'private key'}})",
      );
    }
  });

  it("requires a non-empty username", async function () {
    try {
      await new Sender({
        protocol: "tcp",
        host: "host",
        auth: {
          keyId: "",
          token: "privateKey",
        },
      }).close();
      fail("it should not be able to create the sender");
    } catch (err) {
      expect(err.message).toBe(
        "Missing username, please, specify the 'keyId' property of the 'auth' config option. " +
        "For example: new Sender({protocol: 'tcp', host: 'host', auth: {keyId: 'username', token: 'private key'}})",
      );
    }
  });

  it("requires that the username is a string", async function () {
    try {
      await new Sender({
        protocol: "tcp",
        host: "host",
        auth: {
          // @ts-expect-error - Testing invalid options
          keyId: 23,
          token: "privateKey",
        },
      }).close();
      fail("it should not be able to create the sender");
    } catch (err) {
      expect(err.message).toBe(
        "Please, specify the 'keyId' property of the 'auth' config option as a string. " +
        "For example: new Sender({protocol: 'tcp', host: 'host', auth: {keyId: 'username', token: 'private key'}})",
      );
    }
  });

  it("requires a private key for authentication", async function () {
    try {
      await new Sender({
        protocol: "tcp",
        host: "host",
        auth: {
          keyId: "username",
        },
      }).close();
      fail("it should not be able to create the sender");
    } catch (err) {
      expect(err.message).toBe(
        "Missing private key, please, specify the 'token' property of the 'auth' config option. " +
        "For example: new Sender({protocol: 'tcp', host: 'host', auth: {keyId: 'username', token: 'private key'}})",
      );
    }
  });

  it("requires a non-empty private key", async function () {
    try {
      await new Sender({
        protocol: "tcp",
        host: "host",
        auth: {
          keyId: "username",
          token: "",
        },
      }).close();
      fail("it should not be able to create the sender");
    } catch (err) {
      expect(err.message).toBe(
        "Missing private key, please, specify the 'token' property of the 'auth' config option. " +
        "For example: new Sender({protocol: 'tcp', host: 'host', auth: {keyId: 'username', token: 'private key'}})",
      );
    }
  });

  it("requires that the private key is a string", async function () {
    try {
      await new Sender({
        protocol: "tcp",
        host: "host",
        auth: {
          keyId: "username",
          // @ts-expect-error - Testing invalid options
          token: true,
        },
      }).close();
      fail("it should not be able to create the sender");
    } catch (err) {
      expect(err.message).toBe(
        "Please, specify the 'token' property of the 'auth' config option as a string. " +
        "For example: new Sender({protocol: 'tcp', host: 'host', auth: {keyId: 'username', token: 'private key'}})",
      );
    }
  });
});

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
  });

  it("can ingest via HTTP", async function () {
    mockHttp.reset();

    const sender = Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT}`,
    );
    await sendData(sender);
    expect(mockHttp.numOfRequests).toBe(1);

    await sender.close();
  });

  it("supports custom http agent", async function () {
    mockHttp.reset();
    const agent = new Agent({ pipelining: 3 });

    const sender = Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT}`,
      { agent: agent },
    );
    await sendData(sender);
    expect(mockHttp.numOfRequests).toBe(1);

    const symbols = Object.getOwnPropertySymbols(sender.agent);
    expect(sender.agent[symbols[6]]).toEqual({ pipelining: 3 });

    await sender.close();
    await agent.destroy();
  });

  it("can ingest via HTTPS", async function () {
    mockHttps.reset();

    const senderCertCheckFail = Sender.fromConfig(
      `https::addr=${PROXY_HOST}:${MOCK_HTTPS_PORT}`,
    );
    await expect(sendData(senderCertCheckFail)).rejects.toThrowError(
      "HTTP request failed, statusCode=unknown, error=self-signed certificate in certificate chain",
    );
    await senderCertCheckFail.close();

    const senderWithCA = Sender.fromConfig(
      `https::addr=${PROXY_HOST}:${MOCK_HTTPS_PORT};tls_ca=test/certs/ca/ca.crt`,
    );
    await sendData(senderWithCA);
    expect(mockHttps.numOfRequests).toEqual(1);
    await senderWithCA.close();

    const senderVerifyOff = Sender.fromConfig(
      `https::addr=${PROXY_HOST}:${MOCK_HTTPS_PORT};tls_verify=unsafe_off`,
    );
    await sendData(senderVerifyOff);
    expect(mockHttps.numOfRequests).toEqual(2);
    await senderVerifyOff.close();
  }, 20000);

  it("can ingest via HTTP with basic auth", async function () {
    mockHttp.reset({ username: "user1", password: "pwd" });

    const sender = Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};username=user1;password=pwd`,
    );
    await sendData(sender);
    expect(mockHttp.numOfRequests).toEqual(1);
    await sender.close();

    const senderFailPwd = Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};username=user1;password=xyz`,
    );
    await expect(sendData(senderFailPwd)).rejects.toThrowError(
      "HTTP request failed, statusCode=401",
    );
    await senderFailPwd.close();

    const senderFailMissingPwd = Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};username=user1z`,
    );
    await expect(sendData(senderFailMissingPwd)).rejects.toThrowError(
      "HTTP request failed, statusCode=401",
    );
    await senderFailMissingPwd.close();

    const senderFailUsername = Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};username=xyz;password=pwd`,
    );
    await expect(sendData(senderFailUsername)).rejects.toThrowError(
      "HTTP request failed, statusCode=401",
    );
    await senderFailUsername.close();

    const senderFailMissingUsername = Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};password=pwd`,
    );
    await expect(sendData(senderFailMissingUsername)).rejects.toThrowError(
      "HTTP request failed, statusCode=401",
    );
    await senderFailMissingUsername.close();

    const senderFailMissing = Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT}`,
    );
    await expect(sendData(senderFailMissing)).rejects.toThrowError(
      "HTTP request failed, statusCode=401",
    );
    await senderFailMissing.close();
  });

  it("can ingest via HTTP with token auth", async function () {
    mockHttp.reset({ token: "abcdefghijkl123" });

    const sender = Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};token=abcdefghijkl123`,
    );
    await sendData(sender);
    expect(mockHttp.numOfRequests).toBe(1);
    await sender.close();

    const senderFailToken = Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};token=xyz`,
    );
    await expect(sendData(senderFailToken)).rejects.toThrowError(
      "HTTP request failed, statusCode=401",
    );
    await senderFailToken.close();

    const senderFailMissing = Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT}`,
    );
    await expect(sendData(senderFailMissing)).rejects.toThrowError(
      "HTTP request failed, statusCode=401",
    );
    await senderFailMissing.close();
  });

  it("can retry via HTTP", async function () {
    mockHttp.reset({ responseCodes: [204, 500, 523, 504, 500] });

    const sender = Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT}`,
    );
    await sendData(sender);
    expect(mockHttp.numOfRequests).toBe(5);

    await sender.close();
  });

  it("fails when retry timeout expires", async function () {
    // TODO: artificial delay (responseDelays) is the same as retry timeout,
    //  This should result in the request failing on the second try.
    //  However, with undici transport sometimes we reach the third request too.
    //  Investigate why, probably because of pipelining?
    mockHttp.reset({
      responseCodes: [204, 500, 500],
      responseDelays: [1000, 1000, 1000],
    });

    const sender = Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};retry_timeout=1000`,
    );
    await expect(sendData(sender)).rejects.toThrowError(
      "HTTP request failed, statusCode=500, error=Request failed"
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

    const sender = Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};retry_timeout=0;request_timeout=100`,
    );
    await expect(sendData(sender)).rejects.toThrowError(
      "HTTP request timeout, statusCode=undefined, error=Headers Timeout Error",
    );
    await sender.close();
  });

  it("succeeds on the third request after two timeouts", async function () {
    mockHttp.reset({
      responseCodes: [204, 504, 504],
      responseDelays: [2000, 2000],
    });

    const sender = Sender.fromConfig(
      `http::addr=${PROXY_HOST}:${MOCK_HTTP_PORT};retry_timeout=30000;request_timeout=1000`,
    );
    await sendData(sender);

    await sender.close();
  });

  it("accepts custom http agent", async function () {
    mockHttp.reset();
    const agent = new Agent({ connect: { keepAlive: false } });

    const num = 300;
    const senders: Sender[] = [];
    const promises: Promise<void>[] = [];
    for (let i = 0; i < num; i++) {
      const sender = Sender.fromConfig(
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
});

describe("Sender connection suite", function () {
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
    // @ts-expect-error invalid options
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
    // @ts-expect-error invalid options
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
    const sender = new Sender({ protocol: "tcp" });
    try {
      await sender.connect();
      fail("it should not be able to connect");
    } catch (err) {
      expect(err.message).toBe("Hostname is not set");
    }
    await sender.close();
  });

  it("fails to send data if not connected", async function () {
    const sender = new Sender({ protocol: "tcp", host: "localhost" });
    try {
      await sender.table("test").symbol("location", "us").atNow();
      await sender.flush();
      fail("it should not be able to send data");
    } catch (err) {
      expect(err.message).toBe("TCP send failed, error=Sender is not connected");
    }
    await sender.close();
  });

  it("guards against multiple connect calls", async function () {
    const proxy = await createProxy(true, proxyOptions);
    const sender = await createSender(AUTH, true);
    try {
      await sender.connect();
      fail("it should not be able to connect again");
    } catch (err) {
      expect(err.message).toBe("Sender connected already");
    }
    await sender.close();
    await proxy.stop();
  });

  it("guards against concurrent connect calls", async function () {
    const proxy = await createProxy(true, proxyOptions);
    const sender = new Sender({
      protocol: "tcps",
      port: PROXY_PORT,
      host: PROXY_HOST,
      auth: AUTH,
      tls_ca: "test/certs/ca/ca.crt",
    });
    try {
      await Promise.all([sender.connect(), sender.connect()]);
      fail("it should not be able to connect twice");
    } catch (err) {
      expect(err.message).toBe("Sender connected already");
    }
    await sender.close();
    await proxy.stop();
  });

  it("can disable the server certificate check", async function () {
    const proxy = await createProxy(true, proxyOptions);
    const senderCertCheckFail = Sender.fromConfig(
      `tcps::addr=${PROXY_HOST}:${PROXY_PORT}`,
    );
    try {
      await senderCertCheckFail.connect();
      fail("it should not be able to connect");
    } catch (err) {
      expect(err.message).toMatch(
        /^self[ -]signed certificate in certificate chain$/,
      );
    }
    await senderCertCheckFail.close();

    const senderCertCheckOn = Sender.fromConfig(
      `tcps::addr=${PROXY_HOST}:${PROXY_PORT};tls_ca=test/certs/ca/ca.crt`,
    );
    await senderCertCheckOn.connect();
    await senderCertCheckOn.close();

    const senderCertCheckOff = Sender.fromConfig(
      `tcps::addr=${PROXY_HOST}:${PROXY_PORT};tls_verify=unsafe_off`,
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
    const log = (level: "error" | "warn" | "info" | "debug", message: string) => {
      expect(level).toBe("info");
      expect(message).toMatch(expectedMessages.shift());
    };
    const proxy = await createProxy();
    const sender = new Sender({
      protocol: "tcp",
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
});

describe("Client interop test suite", function () {
  it("runs client tests as per json test config", async function () {
    const testCases = JSON.parse(
      readFileSync(
        "./questdb-client-test/ilp-client-interop-test.json",
      ).toString(),
    );

    loopTestCase: for (const testCase of testCases) {
      console.info(`test name: ${testCase.testName}`);
      const sender = new Sender({
        protocol: "tcp",
        host: "host",
        init_buf_size: 1024,
      });
      try {
        sender.table(testCase.table);
        for (const symbol of testCase.symbols) {
          sender.symbol(symbol.name, symbol.value);
        }
        for (const column of testCase.columns) {
          switch (column.type) {
            case "STRING":
              sender.stringColumn(column.name, column.value);
              break;
            case "LONG":
              sender.intColumn(column.name, column.value);
              break;
            case "DOUBLE":
              sender.floatColumn(column.name, column.value);
              break;
            case "BOOLEAN":
              sender.booleanColumn(column.name, column.value);
              break;
            case "TIMESTAMP":
              sender.timestampColumn(column.name, column.value);
              break;
            default:
              fail("Unsupported column type");
          }
        }
        await sender.atNow();
      } catch (e) {
        if (testCase.result.status !== "ERROR") {
          fail("Did not expect error: " + e.message);
        }
        await sender.close();
        continue;
      }

      const buffer = sender.toBufferView();
      if (testCase.result.status === "SUCCESS") {
        if (testCase.result.line) {
          expect(buffer.toString()).toBe(testCase.result.line + "\n");
        } else {
          for (const line of testCase.result.anyLines) {
            if (buffer.toString() === line + "\n") {
              // test passed
              await sender.close();
              continue loopTestCase;
            }
          }
          fail("Line is not matching any of the expected results: " + buffer.toString());
        }
      } else {
        fail("Expected error missing, instead we have a line: " + buffer.toString());
      }

      await sender.close();
    }
  });
});

describe("Sender message builder test suite (anything not covered in client interop test suite)", function () {
  it("throws on invalid timestamp unit", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    try {
      await sender
        .table("tableName")
        .booleanColumn("boolCol", true)
        // @ts-expect-error - Testing invalid options
        .timestampColumn("timestampCol", 1658484765000000, "foobar")
        .atNow();
      fail("Expected error is not thrown");
    } catch (err) {
      expect(err.message).toBe("Unknown timestamp unit: foobar");
    }
    await sender.close();
  });

  it("supports json object", async function () {
    const pages: Array<{
      id: string;
      gridId: string;
    }>[] = [];
    for (let i = 0; i < 4; i++) {
      const pageProducts: Array<{
        id: string;
        gridId: string;
      }> = [
          {
            id: "46022e96-076f-457f-b630-51b82b871618" + i,
            gridId: "46022e96-076f-457f-b630-51b82b871618",
          },
          {
            id: "55615358-4af1-4179-9153-faaa57d71e55",
            gridId: "55615358-4af1-4179-9153-faaa57d71e55",
          },
          {
            id: "365b9cdf-3d4e-4135-9cb0-f1a65601c840",
            gridId: "365b9cdf-3d4e-4135-9cb0-f1a65601c840",
          },
          {
            id: "0b67ddf2-8e69-4482-bf0c-bb987ee5c280",
            gridId: "0b67ddf2-8e69-4482-bf0c-bb987ee5c280" + i,
          },
        ];
      pages.push(pageProducts);
    }

    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 256,
    });
    for (const p of pages) {
      await sender
        .table("tableName")
        .stringColumn("page_products", JSON.stringify(p || []))
        .booleanColumn("boolCol", true)
        .atNow();
    }
    expect(sender.toBufferView().toString()).toBe(
      'tableName page_products="[{\\"id\\":\\"46022e96-076f-457f-b630-51b82b8716180\\",\\"gridId\\":\\"46022e96-076f-457f-b630-51b82b871618\\"},{\\"id\\":\\"55615358-4af1-4179-9153-faaa57d71e55\\",\\"gridId\\":\\"55615358-4af1-4179-9153-faaa57d71e55\\"},{\\"id\\":\\"365b9cdf-3d4e-4135-9cb0-f1a65601c840\\",\\"gridId\\":\\"365b9cdf-3d4e-4135-9cb0-f1a65601c840\\"},{\\"id\\":\\"0b67ddf2-8e69-4482-bf0c-bb987ee5c280\\",\\"gridId\\":\\"0b67ddf2-8e69-4482-bf0c-bb987ee5c2800\\"}]",boolCol=t\n' +
      'tableName page_products="[{\\"id\\":\\"46022e96-076f-457f-b630-51b82b8716181\\",\\"gridId\\":\\"46022e96-076f-457f-b630-51b82b871618\\"},{\\"id\\":\\"55615358-4af1-4179-9153-faaa57d71e55\\",\\"gridId\\":\\"55615358-4af1-4179-9153-faaa57d71e55\\"},{\\"id\\":\\"365b9cdf-3d4e-4135-9cb0-f1a65601c840\\",\\"gridId\\":\\"365b9cdf-3d4e-4135-9cb0-f1a65601c840\\"},{\\"id\\":\\"0b67ddf2-8e69-4482-bf0c-bb987ee5c280\\",\\"gridId\\":\\"0b67ddf2-8e69-4482-bf0c-bb987ee5c2801\\"}]",boolCol=t\n' +
      'tableName page_products="[{\\"id\\":\\"46022e96-076f-457f-b630-51b82b8716182\\",\\"gridId\\":\\"46022e96-076f-457f-b630-51b82b871618\\"},{\\"id\\":\\"55615358-4af1-4179-9153-faaa57d71e55\\",\\"gridId\\":\\"55615358-4af1-4179-9153-faaa57d71e55\\"},{\\"id\\":\\"365b9cdf-3d4e-4135-9cb0-f1a65601c840\\",\\"gridId\\":\\"365b9cdf-3d4e-4135-9cb0-f1a65601c840\\"},{\\"id\\":\\"0b67ddf2-8e69-4482-bf0c-bb987ee5c280\\",\\"gridId\\":\\"0b67ddf2-8e69-4482-bf0c-bb987ee5c2802\\"}]",boolCol=t\n' +
      'tableName page_products="[{\\"id\\":\\"46022e96-076f-457f-b630-51b82b8716183\\",\\"gridId\\":\\"46022e96-076f-457f-b630-51b82b871618\\"},{\\"id\\":\\"55615358-4af1-4179-9153-faaa57d71e55\\",\\"gridId\\":\\"55615358-4af1-4179-9153-faaa57d71e55\\"},{\\"id\\":\\"365b9cdf-3d4e-4135-9cb0-f1a65601c840\\",\\"gridId\\":\\"365b9cdf-3d4e-4135-9cb0-f1a65601c840\\"},{\\"id\\":\\"0b67ddf2-8e69-4482-bf0c-bb987ee5c280\\",\\"gridId\\":\\"0b67ddf2-8e69-4482-bf0c-bb987ee5c2803\\"}]",boolCol=t\n',
    );
    await sender.close();
  });

  it("supports timestamp field as number", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000000)
      .atNow();
    expect(sender.toBufferView().toString()).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t\n",
    );
    await sender.close();
  });

  it("supports timestamp field as ns number", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000000, "ns")
      .atNow();
    expect(sender.toBufferView().toString()).toBe(
      "tableName boolCol=t,timestampCol=1658484765000t\n",
    );
    await sender.close();
  });

  it("supports timestamp field as us number", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000000, "us")
      .atNow();
    expect(sender.toBufferView().toString()).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t\n",
    );
    await sender.close();
  });

  it("supports timestamp field as ms number", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000, "ms")
      .atNow();
    expect(sender.toBufferView().toString()).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t\n",
    );
    await sender.close();
  });

  it("supports timestamp field as BigInt", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000000n)
      .atNow();
    expect(sender.toBufferView().toString()).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t\n",
    );
    await sender.close();
  });

  it("supports timestamp field as ns BigInt", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000000000n, "ns")
      .atNow();
    expect(sender.toBufferView().toString()).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t\n",
    );
    await sender.close();
  });

  it("supports timestamp field as us BigInt", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000000n, "us")
      .atNow();
    expect(sender.toBufferView().toString()).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t\n",
    );
    await sender.close();
  });

  it("supports timestamp field as ms BigInt", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000n, "ms")
      .atNow();
    expect(sender.toBufferView().toString()).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t\n",
    );
    await sender.close();
  });

  it("throws on invalid designated timestamp unit", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    try {
      await sender
        .table("tableName")
        .booleanColumn("boolCol", true)
        .timestampColumn("timestampCol", 1658484765000000)
        // @ts-expect-error - Testing invalid options
        .at(1658484769000000, "foobar");
    } catch (err) {
      expect(err.message).toBe("Unknown timestamp unit: foobar");
    }
    await sender.close();
  });

  it("supports setting designated us timestamp as number from client", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000000)
      .at(1658484769000000, "us");
    expect(sender.toBufferView().toString()).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t 1658484769000000000\n",
    );
    await sender.close();
  });

  it("supports setting designated ms timestamp as number from client", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000000)
      .at(1658484769000, "ms");
    expect(sender.toBufferView().toString()).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t 1658484769000000000\n",
    );
    await sender.close();
  });

  it("supports setting designated timestamp as BigInt from client", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000000)
      .at(1658484769000000n);
    expect(sender.toBufferView().toString()).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t 1658484769000000000\n",
    );
    await sender.close();
  });

  it("supports setting designated ns timestamp as BigInt from client", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000000)
      .at(1658484769000000123n, "ns");
    expect(sender.toBufferView().toString()).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t 1658484769000000123\n",
    );
    await sender.close();
  });

  it("supports setting designated us timestamp as BigInt from client", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000000)
      .at(1658484769000000n, "us");
    expect(sender.toBufferView().toString()).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t 1658484769000000000\n",
    );
    await sender.close();
  });

  it("supports setting designated ms timestamp as BigInt from client", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000000)
      .at(1658484769000n, "ms");
    expect(sender.toBufferView().toString()).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t 1658484769000000000\n",
    );
    await sender.close();
  });

  it("throws exception if table name is not a string", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    // @ts-expect-error invalid options
    expect(() => sender.table(23456)).toThrow(
      "Table name must be a string, received number",
    );
    await sender.close();
  });

  it("throws exception if table name is too long", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      sender.table(
        "123456789012345678901234567890123456789012345678901234567890" +
        "12345678901234567890123456789012345678901234567890123456789012345678",
      ),
    ).toThrow("Table name is too long, max length is 127");
    await sender.close();
  });

  it("throws exception if table name is set more times", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      sender.table("tableName").symbol("name", "value").table("newTableName"),
    ).toThrow("Table name has already been set");
    await sender.close();
  });

  it("throws exception if symbol name is not a string", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    // @ts-expect-error invalid options
    expect(() => sender.table("tableName").symbol(12345.5656, "value")).toThrow(
      "Symbol name must be a string, received number",
    );
    await sender.close();
  });

  it("throws exception if symbol name is empty string", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() => sender.table("tableName").symbol("", "value")).toThrow(
      "Empty string is not allowed as column name",
    );
    await sender.close();
  });

  it("throws exception if column name is not a string", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      // @ts-expect-error invalid options
      sender.table("tableName").stringColumn(12345.5656, "value"),
    ).toThrow("Column name must be a string, received number");
    await sender.close();
  });

  it("throws exception if column name is empty string", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() => sender.table("tableName").stringColumn("", "value")).toThrow(
      "Empty string is not allowed as column name",
    );
    await sender.close();
  });

  it("throws exception if column name is too long", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      sender
        .table("tableName")
        .stringColumn(
          "123456789012345678901234567890123456789012345678901234567890" +
          "12345678901234567890123456789012345678901234567890123456789012345678",
          "value",
        ),
    ).toThrow("Column name is too long, max length is 127");
    await sender.close();
  });

  it("throws exception if column value is not the right type", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      // @ts-expect-error invalid options
      sender.table("tableName").stringColumn("columnName", false),
    ).toThrow("Column value must be of type string, received boolean");
    await sender.close();
  });

  it("throws exception if adding column without setting table name", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() => sender.floatColumn("name", 12.459)).toThrow(
      "Column can be set only after table name is set",
    );
    await sender.close();
  });

  it("throws exception if adding symbol without setting table name", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() => sender.symbol("name", "value")).toThrow(
      "Symbol can be added only after table name is set and before any column added",
    );
    await sender.close();
  });

  it("throws exception if adding symbol after columns", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      sender
        .table("tableName")
        .stringColumn("name", "value")
        .symbol("symbolName", "symbolValue"),
    ).toThrow(
      "Symbol can be added only after table name is set and before any column added",
    );
    await sender.close();
  });

  it("returns null if preparing an empty buffer for send", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    expect(sender.toBufferView()).toBe(null);
    expect(sender.toBufferNew()).toBe(null);
    await sender.close();
  });

  it("leaves unfinished rows in the sender's buffer when preparing a copy of the buffer for send", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    sender.table("tableName").symbol("name", "value");
    await sender.at(1234567890n, "ns");
    sender.table("tableName").symbol("name", "value2");

    // copy of the sender's buffer contains the finished row
    expect(sender.toBufferNew(sender.endOfLastRow).toString()).toBe(
      "tableName,name=value 1234567890\n",
    );
    // the sender's buffer is compacted, and contains only the unfinished row
    expect(sender.toBufferView().toString()).toBe(
      "tableName,name=value2",
    );
    await sender.close();
  });

  it("throws exception if a float is passed as integer field", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      sender.table("tableName").intColumn("intField", 123.222),
    ).toThrow("Value must be an integer, received 123.222");
    await sender.close();
  });

  it("throws exception if a float is passed as timestamp field", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    expect(() =>
      sender.table("tableName").timestampColumn("intField", 123.222),
    ).toThrow("Value must be an integer or BigInt, received 123.222");
    await sender.close();
  });

  it("throws exception if designated timestamp is not an integer or bigint", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    try {
      await sender
        .table("tableName")
        .symbol("name", "value")
        .at(23232322323.05);
    } catch (e) {
      expect(e.message).toEqual(
        "Designated timestamp must be an integer or BigInt, received 23232322323.05",
      );
    }
    await sender.close();
  });

  it("throws exception if designated timestamp is invalid", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    try {
      // @ts-expect-error invalid options
      await sender.table("tableName").symbol("name", "value").at("invalid_dts");
    } catch (e) {
      expect(e.message).toEqual(
        "Designated timestamp must be an integer or BigInt, received invalid_dts",
      );
    }
    await sender.close();
  });

  it("throws exception if designated timestamp is set without any fields added", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    try {
      await sender.table("tableName").at(12345678n, "ns");
    } catch (e) {
      expect(e.message).toEqual(
        "The row must have a symbol or column set before it is closed",
      );
    }
    await sender.close();
  });

  it("extends the size of the buffer if data does not fit", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 8,
    });
    expect(sender.bufferSize).toBe(8);
    expect(sender.position).toBe(0);
    sender.table("tableName");
    expect(sender.bufferSize).toBe(16);
    expect(sender.position).toBe("tableName".length);
    sender.intColumn("intField", 123);
    expect(sender.bufferSize).toBe(32);
    expect(sender.position).toBe("tableName intField=123i".length);
    await sender.atNow();
    expect(sender.bufferSize).toBe(32);
    expect(sender.position).toBe("tableName intField=123i\n".length);
    expect(sender.toBufferView().toString()).toBe("tableName intField=123i\n");

    await sender
      .table("table2")
      .intColumn("intField", 125)
      .stringColumn("strField", "test")
      .atNow();
    expect(sender.bufferSize).toBe(64);
    expect(sender.position).toBe(
      'tableName intField=123i\ntable2 intField=125i,strField="test"\n'.length,
    );
    expect(sender.toBufferView().toString()).toBe(
      'tableName intField=123i\ntable2 intField=125i,strField="test"\n',
    );
    await sender.close();
  });

  it("throws exception if tries to extend the size of the buffer above max buffer size", async function () {
    const sender = Sender.fromConfig(
      "tcp::addr=host;init_buf_size=8;max_buf_size=48;",
    );
    expect(sender.bufferSize).toBe(8);
    expect(sender.position).toBe(0);
    sender.table("tableName");
    expect(sender.bufferSize).toBe(16);
    expect(sender.position).toBe("tableName".length);
    sender.intColumn("intField", 123);
    expect(sender.bufferSize).toBe(32);
    expect(sender.position).toBe("tableName intField=123i".length);
    await sender.atNow();
    expect(sender.bufferSize).toBe(32);
    expect(sender.position).toBe("tableName intField=123i\n".length);
    expect(sender.toBufferView().toString()).toBe("tableName intField=123i\n");

    try {
      await sender
        .table("table2")
        .intColumn("intField", 125)
        .stringColumn("strField", "test")
        .atNow();
    } catch (err) {
      expect(err.message).toBe(
        "Max buffer size is 48 bytes, requested buffer size: 64",
      );
    }
    await sender.close();
  });

  it("is possible to clear the buffer by calling reset()", async function () {
    const sender = new Sender({
      protocol: "tcp",
      host: "host",
      init_buf_size: 1024,
    });
    await sender
      .table("tableName")
      .booleanColumn("boolCol", true)
      .timestampColumn("timestampCol", 1658484765000000)
      .atNow();
    await sender
      .table("tableName")
      .booleanColumn("boolCol", false)
      .timestampColumn("timestampCol", 1658484766000000)
      .atNow();
    expect(sender.toBufferView().toString()).toBe(
      "tableName boolCol=t,timestampCol=1658484765000000t\n" +
      "tableName boolCol=f,timestampCol=1658484766000000t\n",
    );

    sender.reset();
    await sender
      .table("tableName")
      .floatColumn("floatCol", 1234567890)
      .timestampColumn("timestampCol", 1658484767000000)
      .atNow();
    expect(sender.toBufferView().toString()).toBe(
      "tableName floatCol=1234567890,timestampCol=1658484767000000t\n",
    );
    await sender.close();
  });
});

describe("Sender tests with containerized QuestDB instance", () => {
  let container: any;

  async function query(container: any, query: string) {
    const options = {
      hostname: container.getHost(),
      port: container.getMappedPort(QUESTDB_HTTP_PORT),
      path: `/exec?query=${encodeURIComponent(query)}`,
      method: "GET",
    };

    return new Promise((resolve, reject) => {
      const req = http.request(options, (response) => {
        if (response.statusCode === HTTP_OK) {
          const body: Uint8Array[] = [];
          response
            .on("data", (data: Uint8Array) => {
              body.push(data);
            })
            .on("end", () => {
              resolve(JSON.parse(Buffer.concat(body).toString()));
            });
        } else {
          reject(
            new Error(
              `HTTP request failed, statusCode=${response.statusCode}, query=${query}`,
            ),
          );
        }
      });

      req.on("error", (error) => {
        reject(error);
      });

      req.end();
    });
  }

  async function runSelect(container: any, select: string, expectedCount: number, timeout = 60000) {
    const interval = 500;
    const num = timeout / interval;
    let selectResult: any;
    for (let i = 0; i < num; i++) {
      selectResult = await query(container, select);
      if (selectResult && selectResult.count >= expectedCount) {
        return selectResult;
      }
      await sleep(interval);
    }
    throw new Error(
      `Timed out while waiting for ${expectedCount} rows, select='${select}'`,
    );
  }

  async function waitForTable(container: any, tableName: string, timeout = 30000) {
    await runSelect(container, `tables() where table_name='${tableName}'`, 1, timeout);
  }

  function getFieldsString(schema: any) {
    let fields = "";
    for (const element of schema) {
      fields += `${element.name} ${element.type}, `;
    }
    return fields.substring(0, fields.length - 2);
  }

  beforeAll(async () => {
    container = await new GenericContainer("questdb/questdb:nightly")
      .withExposedPorts(QUESTDB_HTTP_PORT, QUESTDB_ILP_PORT)
      .start();

    const stream = await container.logs();
    stream
      .on("data", (line: string) => console.log(line))
      .on("err", (line: string) => console.error(line))
      .on("end", () => console.log("Stream closed"));
  }, 3000000);

  afterAll(async () => {
    await container.stop();
  });

  it("can ingest data via TCP and run queries", async () => {
    const sender = new Sender({
      protocol: "tcp",
      host: container.getHost(),
      port: container.getMappedPort(QUESTDB_ILP_PORT),
    });
    await sender.connect();

    const tableName = "test_tcp";
    const schema = [
      { name: "location", type: "SYMBOL" },
      { name: "temperature", type: "DOUBLE" },
      { name: "timestamp", type: "TIMESTAMP" },
    ];

    // ingest via client
    await sender
      .table(tableName)
      .symbol("location", "us")
      .floatColumn("temperature", 17.1)
      .at(1658484765000000000n, "ns");
    await sender.flush();

    // wait for the table
    await waitForTable(container, tableName)

    // query table
    const select1Result = await runSelect(container, tableName, 1);
    expect(select1Result.query).toBe(tableName);
    expect(select1Result.count).toBe(1);
    expect(select1Result.columns).toStrictEqual(schema);
    expect(select1Result.dataset).toStrictEqual([
      ["us", 17.1, "2022-07-22T10:12:45.000000Z"],
    ]);

    // ingest via client, add new column
    await sender
      .table(tableName)
      .symbol("location", "us")
      .floatColumn("temperature", 17.3)
      .at(1658484765000666000n, "ns");
    await sender
      .table(tableName)
      .symbol("location", "emea")
      .floatColumn("temperature", 17.4)
      .at(1658484765000999000n, "ns");
    await sender
      .table(tableName)
      .symbol("location", "emea")
      .symbol("city", "london")
      .floatColumn("temperature", 18.8)
      .at(1658484765001234000n, "ns");
    await sender.flush();

    // query table
    const select2Result = await runSelect(container, tableName, 4);
    expect(select2Result.query).toBe(tableName);
    expect(select2Result.count).toBe(4);
    expect(select2Result.columns).toStrictEqual([
      { name: "location", type: "SYMBOL" },
      { name: "temperature", type: "DOUBLE" },
      { name: "timestamp", type: "TIMESTAMP" },
      { name: "city", type: "SYMBOL" },
    ]);
    expect(select2Result.dataset).toStrictEqual([
      ["us", 17.1, "2022-07-22T10:12:45.000000Z", null],
      ["us", 17.3, "2022-07-22T10:12:45.000666Z", null],
      ["emea", 17.4, "2022-07-22T10:12:45.000999Z", null],
      ["emea", 18.8, "2022-07-22T10:12:45.001234Z", "london"],
    ]);

    await sender.close();
  });

  it("can ingest data via HTTP with auto flush rows", async () => {
    const tableName = "test_http_rows";
    const schema = [
      { name: "location", type: "SYMBOL" },
      { name: "temperature", type: "DOUBLE" },
      { name: "timestamp", type: "TIMESTAMP" },
    ];

    const sender = Sender.fromConfig(
      `http::addr=${container.getHost()}:${container.getMappedPort(QUESTDB_HTTP_PORT)};auto_flush_interval=0;auto_flush_rows=1`,
    );

    // ingest via client
    await sender
      .table(tableName)
      .symbol("location", "us")
      .floatColumn("temperature", 17.1)
      .at(1658484765000000000n, "ns");

    // wait for the table
    await waitForTable(container, tableName)

    // query table
    const select1Result = await runSelect(container, tableName, 1);
    expect(select1Result.query).toBe(tableName);
    expect(select1Result.count).toBe(1);
    expect(select1Result.columns).toStrictEqual(schema);
    expect(select1Result.dataset).toStrictEqual([
      ["us", 17.1, "2022-07-22T10:12:45.000000Z"],
    ]);

    // ingest via client, add new column
    await sender
      .table(tableName)
      .symbol("location", "us")
      .floatColumn("temperature", 17.36)
      .at(1658484765000666000n, "ns");
    await sender
      .table(tableName)
      .symbol("location", "emea")
      .floatColumn("temperature", 17.41)
      .at(1658484765000999000n, "ns");
    await sender
      .table(tableName)
      .symbol("location", "emea")
      .symbol("city", "london")
      .floatColumn("temperature", 18.81)
      .at(1658484765001234000n, "ns");

    // query table
    const select2Result = await runSelect(container, tableName, 4);
    expect(select2Result.query).toBe(tableName);
    expect(select2Result.count).toBe(4);
    expect(select2Result.columns).toStrictEqual([
      { name: "location", type: "SYMBOL" },
      { name: "temperature", type: "DOUBLE" },
      { name: "timestamp", type: "TIMESTAMP" },
      { name: "city", type: "SYMBOL" },
    ]);
    expect(select2Result.dataset).toStrictEqual([
      ["us", 17.1, "2022-07-22T10:12:45.000000Z", null],
      ["us", 17.36, "2022-07-22T10:12:45.000666Z", null],
      ["emea", 17.41, "2022-07-22T10:12:45.000999Z", null],
      ["emea", 18.81, "2022-07-22T10:12:45.001234Z", "london"],
    ]);

    await sender.close();
  });

  it("can ingest data via HTTP with auto flush interval", async () => {
    const tableName = "test_http_interval";
    const schema = [
      { name: "location", type: "SYMBOL" },
      { name: "temperature", type: "DOUBLE" },
      { name: "timestamp", type: "TIMESTAMP" },
    ];

    const sender = Sender.fromConfig(
      `http::addr=${container.getHost()}:${container.getMappedPort(QUESTDB_HTTP_PORT)};auto_flush_interval=1;auto_flush_rows=0`,
    );

    // wait longer than the set auto flush interval to make sure there is a flush
    await sleep(10);

    // ingest via client
    await sender
      .table(tableName)
      .symbol("location", "us")
      .floatColumn("temperature", 17.1)
      .at(1658484765000000000n, "ns");

    // wait for the table
    await waitForTable(container, tableName)

    // query table
    const select1Result = await runSelect(container, tableName, 1);
    expect(select1Result.query).toBe(tableName);
    expect(select1Result.count).toBe(1);
    expect(select1Result.columns).toStrictEqual(schema);
    expect(select1Result.dataset).toStrictEqual([
      ["us", 17.1, "2022-07-22T10:12:45.000000Z"],
    ]);

    // ingest via client, add new column
    await sleep(10);
    await sender
      .table(tableName)
      .symbol("location", "us")
      .floatColumn("temperature", 17.36)
      .at(1658484765000666000n, "ns");
    await sleep(10);
    await sender
      .table(tableName)
      .symbol("location", "emea")
      .floatColumn("temperature", 17.41)
      .at(1658484765000999000n, "ns");
    await sleep(10);
    await sender
      .table(tableName)
      .symbol("location", "emea")
      .symbol("city", "london")
      .floatColumn("temperature", 18.81)
      .at(1658484765001234000n, "ns");

    // query table
    const select2Result = await runSelect(container, tableName, 4);
    expect(select2Result.query).toBe(tableName);
    expect(select2Result.count).toBe(4);
    expect(select2Result.columns).toStrictEqual([
      { name: "location", type: "SYMBOL" },
      { name: "temperature", type: "DOUBLE" },
      { name: "timestamp", type: "TIMESTAMP" },
      { name: "city", type: "SYMBOL" },
    ]);
    expect(select2Result.dataset).toStrictEqual([
      ["us", 17.1, "2022-07-22T10:12:45.000000Z", null],
      ["us", 17.36, "2022-07-22T10:12:45.000666Z", null],
      ["emea", 17.41, "2022-07-22T10:12:45.000999Z", null],
      ["emea", 18.81, "2022-07-22T10:12:45.001234Z", "london"],
    ]);

    await sender.close();
  });

  it("does not duplicate rows if await is missing when calling flush", async () => {
    // setting copyBuffer to make sure promises send data from their own local buffer
    const sender = new Sender({
      protocol: "tcp",
      host: container.getHost(),
      port: container.getMappedPort(QUESTDB_ILP_PORT),
    });
    await sender.connect();

    const tableName = "test2";
    const schema = [
      { name: "location", type: "SYMBOL" },
      { name: "temperature", type: "DOUBLE" },
      { name: "timestamp", type: "TIMESTAMP" },
    ];

    // ingest via client
    const numOfRows = 100;
    for (let i = 0; i < numOfRows; i++) {
      await sender
        .table(tableName)
        .symbol("location", "us")
        .floatColumn("temperature", i)
        .at(1658484765000000000n, "ns");
      // missing await is intentional
      await sender.flush();
    }

    // wait for the table
    await waitForTable(container, tableName)

    // query table
    const selectQuery = `${tableName} order by temperature`;
    const selectResult = await runSelect(container, selectQuery, numOfRows);
    expect(selectResult.query).toBe(selectQuery);
    expect(selectResult.count).toBe(numOfRows);
    expect(selectResult.columns).toStrictEqual(schema);

    const expectedData: (string | number)[][] = [];
    for (let i = 0; i < numOfRows; i++) {
      expectedData.push(["us", i, "2022-07-22T10:12:45.000000Z"]);
    }
    expect(selectResult.dataset).toStrictEqual(expectedData);

    await sender.close();
  });

  it("ingests all data without loss under high load with auto-flush", async () => {
    const sender = Sender.fromConfig(
      `tcp::addr=${container.getHost()}:${container.getMappedPort(QUESTDB_ILP_PORT)};auto_flush_rows=5;auto_flush_interval=1`,
    );
    await sender.connect();

    const tableName = "test_high_load_autoflush";
    const numOfRows = 1000;
    const promises: Promise<void>[] = [];

    for (let i = 0; i < numOfRows; i++) {
      // Not awaiting each .at() call individually to allow them to queue up
      const p = sender
        .table(tableName)
        .intColumn("id", i)
        .at(1658484765000000000n + BigInt(1000 * i), "ns"); // Unique timestamp for each row
      promises.push(p);
    }

    // Wait for all .at() calls to complete their processing (including triggering auto-flushes)
    await Promise.all(promises);

    // Perform a final flush to ensure any data remaining in the buffer is sent.
    // This will be queued correctly after any ongoing auto-flushes.
    await sender.flush();

    // Wait for the table
    await waitForTable(container, tableName)

    // Query table and verify count
    const selectQuery = `SELECT id FROM ${tableName}`;
    const selectResult = await runSelect(container, selectQuery, numOfRows);
    expect(selectResult.count).toBe(numOfRows);

    // Verify data integrity
    for (let i = 0; i < numOfRows; i++) {
      expect(selectResult.dataset[i][0]).toBe(i);
    }

    await sender.close();
  }, 30000); // Increased test timeout for this specific test
});
