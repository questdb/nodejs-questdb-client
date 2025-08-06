// @ts-check
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Agent } from "undici";

import { SenderOptions } from "../src/options";
import { MockHttp } from "./util/mockhttp";
import { readFileSync } from "fs";

const MOCK_HTTP_PORT = 9097;
const MOCK_HTTPS_PORT = 9096;

const proxyOptions = {
  key: readFileSync("test/certs/server/server.key"),
  cert: readFileSync("test/certs/server/server.crt"),
  ca: readFileSync("test/certs/ca/ca.crt"),
};

describe("Configuration string parser suite", function () {
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

  it("can parse a basic config string", async function () {
    const options = await SenderOptions.fromConfig(
      "https::addr=host;username=user1;password=pwd;protocol_version=2",
    );
    expect(options.protocol).toBe("https");
    expect(options.protocol_version).toBe("2");
    expect(options.addr).toBe("host");
    expect(options.username).toBe("user1");
    expect(options.password).toBe("pwd");
  });

  it("can parse a config string from environment variable", async function () {
    process.env.QDB_CLIENT_CONF = "tcp::addr=host;";
    const options = await SenderOptions.fromEnv();
    expect(options.protocol).toBe("tcp");
    expect(options.addr).toBe("host");
  });

  it("accepts only lowercase protocols", async function () {
    let options = await SenderOptions.fromConfig("tcp::addr=host;");
    expect(options.protocol).toBe("tcp");

    options = await SenderOptions.fromConfig("tcps::addr=host;");
    expect(options.protocol).toBe("tcps");

    options = await SenderOptions.fromConfig(
      "http::addr=host;protocol_version=2",
    );
    expect(options.protocol).toBe("http");

    options = await SenderOptions.fromConfig(
      "https::addr=host;protocol_version=2",
    );
    expect(options.protocol).toBe("https");

    await expect(
      async () => await SenderOptions.fromConfig("HTTP::"),
    ).rejects.toThrow(
      "Invalid protocol: 'HTTP', accepted protocols: 'http', 'https', 'tcp', 'tcps'",
    );
    await expect(
      async () => await SenderOptions.fromConfig("Http::"),
    ).rejects.toThrow(
      "Invalid protocol: 'Http', accepted protocols: 'http', 'https', 'tcp', 'tcps'",
    );
    await expect(
      async () => await SenderOptions.fromConfig("HtTps::"),
    ).rejects.toThrow(
      "Invalid protocol: 'HtTps', accepted protocols: 'http', 'https', 'tcp', 'tcps'",
    );

    await expect(
      async () => await SenderOptions.fromConfig("TCP::"),
    ).rejects.toThrow(
      "Invalid protocol: 'TCP', accepted protocols: 'http', 'https', 'tcp', 'tcps'",
    );
    await expect(
      async () => await SenderOptions.fromConfig("TcP::"),
    ).rejects.toThrow(
      "Invalid protocol: 'TcP', accepted protocols: 'http', 'https', 'tcp', 'tcps'",
    );
    await expect(
      async () => await SenderOptions.fromConfig("Tcps::"),
    ).rejects.toThrow(
      "Invalid protocol: 'Tcps', accepted protocols: 'http', 'https', 'tcp', 'tcps'",
    );
  });

  it("considers that keys and values are case-sensitive", async function () {
    const options = await SenderOptions.fromConfig(
      "tcps::addr=Host;username=useR1;token=TOKEN;",
    );
    expect(options.protocol).toBe("tcps");
    expect(options.addr).toBe("Host");
    expect(options.username).toBe("useR1");
    expect(options.token).toBe("TOKEN");

    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "tcps::addr=Host;UserNAME=useR1;PaSswOrD=pWd;",
        ),
    ).rejects.toThrow("Unknown configuration key: 'UserNAME'");
    await expect(
      async () =>
        await SenderOptions.fromConfig("tcps::addr=Host;PaSswOrD=pWd;"),
    ).rejects.toThrow("Unknown configuration key: 'PaSswOrD'");
  });

  it("can parse with or without the last semicolon", async function () {
    let options = await SenderOptions.fromConfig(
      "https::addr=host:9002;protocol_version=2;",
    );
    expect(options.protocol).toBe("https");
    expect(options.addr).toBe("host:9002");

    options = await SenderOptions.fromConfig(
      "https::addr=host:9002;protocol_version=2",
    );
    expect(options.protocol).toBe("https");
    expect(options.addr).toBe("host:9002");

    options = await SenderOptions.fromConfig(
      "https::addr=host:9002;token=abcde;protocol_version=2",
    );
    expect(options.protocol).toBe("https");
    expect(options.addr).toBe("host:9002");
    expect(options.token).toBe("abcde");

    options = await SenderOptions.fromConfig(
      "https::addr=host:9002;token=abcde;protocol_version=2;",
    );
    expect(options.protocol).toBe("https");
    expect(options.addr).toBe("host:9002");
    expect(options.token).toBe("abcde");

    options = await SenderOptions.fromConfig(
      "https::addr=host:9002;protocol_version=2;token=abcde;;",
    );
    expect(options.protocol).toBe("https");
    expect(options.addr).toBe("host:9002");
    expect(options.token).toBe("abcde;");

    options = await SenderOptions.fromConfig(
      "https::addr=host:9002;protocol_version=2;token=abcde;;;",
    );
    expect(options.protocol).toBe("https");
    expect(options.addr).toBe("host:9002");
    expect(options.token).toBe("abcde;");
  });

  it("can parse escaped config string values", async function () {
    const options = await SenderOptions.fromConfig(
      "https::addr=host:9002;protocol_version=2;username=us;;;;;;er;;1;;;password=p;;wd;",
    );
    expect(options.protocol).toBe("https");
    expect(options.addr).toBe("host:9002");
    expect(options.username).toBe("us;;;er;1;");
    expect(options.password).toBe("p;wd");
  });

  it("can parse the address", async function () {
    let options = await SenderOptions.fromConfig(
      "https::addr=host1:9002;token=resttoken123;protocol_version=2;",
    );
    expect(options.protocol).toBe("https");
    expect(options.protocol_version).toBe("2");
    expect(options.addr).toBe("host1:9002");
    expect(options.host).toBe("host1");
    expect(options.port).toBe(9002);
    expect(options.token).toBe("resttoken123");

    options = await SenderOptions.fromConfig(
      "tcps::addr=host2:9005;username=user1;token=jwkprivkey123;",
    );
    expect(options.protocol).toBe("tcps");
    expect(options.addr).toBe("host2:9005");
    expect(options.host).toBe("host2");
    expect(options.port).toBe(9005);
    expect(options.username).toBe("user1");
    expect(options.token).toBe("jwkprivkey123");
  });

  it("can default the port", async function () {
    let options = await SenderOptions.fromConfig(
      "https::addr=hostname;protocol_version=2;token=resttoken123;",
    );
    expect(options.protocol).toBe("https");
    expect(options.addr).toBe("hostname");
    expect(options.host).toBe("hostname");
    expect(options.port).toBe(9000);
    expect(options.token).toBe("resttoken123");

    options = await SenderOptions.fromConfig(
      "http::addr=hostname;protocol_version=2;token=resttoken123;",
    );
    expect(options.protocol).toBe("http");
    expect(options.addr).toBe("hostname");
    expect(options.host).toBe("hostname");
    expect(options.port).toBe(9000);
    expect(options.token).toBe("resttoken123");

    options = await SenderOptions.fromConfig(
      "tcps::addr=hostname;username=user1;token=jwkprivkey123;",
    );
    expect(options.protocol).toBe("tcps");
    expect(options.addr).toBe("hostname");
    expect(options.host).toBe("hostname");
    expect(options.port).toBe(9009);
    expect(options.username).toBe("user1");
    expect(options.token).toBe("jwkprivkey123");

    options = await SenderOptions.fromConfig(
      "tcp::addr=hostname;username=user1;token=jwkprivkey123;",
    );
    expect(options.protocol).toBe("tcp");
    expect(options.addr).toBe("hostname");
    expect(options.host).toBe("hostname");
    expect(options.port).toBe(9009);
    expect(options.username).toBe("user1");
    expect(options.token).toBe("jwkprivkey123");
  });

  it("can parse protocol version", async function () {
    // invalid protocol version
    await expect(
      async () =>
        await SenderOptions.fromConfig("tcp::addr=hostname;protocol_version=3"),
    ).rejects.toThrow(
      "Invalid protocol version: '3', accepted values: 'auto', '1', '2'",
    );
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=hostname;protocol_version=0",
        ),
    ).rejects.toThrow(
      "Invalid protocol version: '0', accepted values: 'auto', '1', '2'",
    );
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=hostname;protocol_version=-1",
        ),
    ).rejects.toThrow(
      "Invalid protocol version: '-1', accepted values: 'auto', '1', '2'",
    );
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "https::addr=hostname;protocol_version=automatic",
        ),
    ).rejects.toThrow(
      "Invalid protocol version: 'automatic', accepted values: 'auto', '1', '2'",
    );

    let options: SenderOptions;

    // defaults with supported versions: 1,2
    mockHttp.reset();
    mockHttps.reset();
    options = await SenderOptions.fromConfig("tcp::addr=localhost");
    expect(options.protocol_version).toBe("1");
    options = await SenderOptions.fromConfig("tcps::addr=localhost");
    expect(options.protocol_version).toBe("1");
    options = await SenderOptions.fromConfig(
      `http::addr=localhost:${MOCK_HTTP_PORT}`,
    );
    expect(options.protocol_version).toBe("2");
    options = await SenderOptions.fromConfig(
      `https::addr=localhost:${MOCK_HTTPS_PORT};tls_verify=unsafe_off`,
    );
    expect(options.protocol_version).toBe("2");

    // defaults with supported versions: 1
    const only1 = {
      settings: {
        config: { "line.proto.support.versions": [1] },
      },
    };
    mockHttp.reset(only1);
    mockHttps.reset(only1);
    options = await SenderOptions.fromConfig("tcp::addr=localhost");
    expect(options.protocol_version).toBe("1");
    options = await SenderOptions.fromConfig("tcps::addr=localhost");
    expect(options.protocol_version).toBe("1");
    options = await SenderOptions.fromConfig(
      `http::addr=localhost:${MOCK_HTTP_PORT}`,
    );
    expect(options.protocol_version).toBe("1");
    options = await SenderOptions.fromConfig(
      `https::addr=localhost:${MOCK_HTTPS_PORT};tls_verify=unsafe_off`,
    );
    expect(options.protocol_version).toBe("1");

    // defaults with no supported versions
    const noVersions = {
      settings: {
        config: {},
      },
    };
    mockHttp.reset(noVersions);
    mockHttps.reset(noVersions);
    options = await SenderOptions.fromConfig("tcp::addr=localhost");
    expect(options.protocol_version).toBe("1");
    options = await SenderOptions.fromConfig("tcps::addr=localhost");
    expect(options.protocol_version).toBe("1");
    options = await SenderOptions.fromConfig(
      `http::addr=localhost:${MOCK_HTTP_PORT}`,
    );
    expect(options.protocol_version).toBe("1");
    options = await SenderOptions.fromConfig(
      `https::addr=localhost:${MOCK_HTTPS_PORT};tls_verify=unsafe_off`,
    );
    expect(options.protocol_version).toBe("1");

    // defaults with no match with supported versions
    const no1and2 = {
      settings: {
        config: { "line.proto.support.versions": [3, 5] },
      },
    };
    mockHttp.reset(no1and2);
    mockHttps.reset(no1and2);
    options = await SenderOptions.fromConfig("tcp::addr=localhost");
    expect(options.protocol_version).toBe("1");
    options = await SenderOptions.fromConfig("tcps::addr=localhost");
    expect(options.protocol_version).toBe("1");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          `http::addr=localhost:${MOCK_HTTP_PORT};tls_verify=unsafe_off`,
        ),
    ).rejects.toThrow(
      "Unsupported protocol versions received from server: 3,5",
    );
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          `https::addr=localhost:${MOCK_HTTPS_PORT};tls_verify=unsafe_off`,
        ),
    ).rejects.toThrow(
      "Unsupported protocol versions received from server: 3,5",
    );

    // auto, 1, 2 with each protocol (tcp, tcps, http, https), supported versions: 1,2
    mockHttp.reset();
    mockHttps.reset();
    options = await SenderOptions.fromConfig(
      "tcp::addr=localhost;protocol_version=1",
    );
    expect(options.protocol_version).toBe("1");
    options = await SenderOptions.fromConfig(
      "tcp::addr=localhost;protocol_version=2",
    );
    expect(options.protocol_version).toBe("2");
    options = await SenderOptions.fromConfig(
      "tcp::addr=localhost;protocol_version=auto",
    );
    expect(options.protocol_version).toBe("1");

    options = await SenderOptions.fromConfig(
      "tcps::addr=localhost;protocol_version=1",
    );
    expect(options.protocol_version).toBe("1");
    options = await SenderOptions.fromConfig(
      "tcps::addr=localhost;protocol_version=2",
    );
    expect(options.protocol_version).toBe("2");
    options = await SenderOptions.fromConfig(
      "tcps::addr=localhost;protocol_version=auto",
    );
    expect(options.protocol_version).toBe("1");

    options = await SenderOptions.fromConfig(
      `http::addr=localhost:${MOCK_HTTP_PORT};protocol_version=1`,
    );
    expect(options.protocol_version).toBe("1");
    options = await SenderOptions.fromConfig(
      `http::addr=localhost:${MOCK_HTTP_PORT};protocol_version=2`,
    );
    expect(options.protocol_version).toBe("2");
    options = await SenderOptions.fromConfig(
      `http::addr=localhost:${MOCK_HTTP_PORT};protocol_version=auto`,
    );
    expect(options.protocol_version).toBe("2");

    options = await SenderOptions.fromConfig(
      `https::addr=localhost:${MOCK_HTTPS_PORT};protocol_version=1`,
    );
    expect(options.protocol_version).toBe("1");
    options = await SenderOptions.fromConfig(
      `https::addr=localhost:${MOCK_HTTPS_PORT};protocol_version=2`,
    );
    expect(options.protocol_version).toBe("2");
    options = await SenderOptions.fromConfig(
      `https::addr=localhost:${MOCK_HTTPS_PORT};tls_verify=unsafe_off;protocol_version=auto`,
    );
    expect(options.protocol_version).toBe("2");
  });

  it("fails if port is not a positive integer", async function () {
    await expect(
      async () => await SenderOptions.fromConfig("tcp::addr=host:;"),
    ).rejects.toThrow("Port is required");
    await expect(
      async () => await SenderOptions.fromConfig("tcp::addr=host:0"),
    ).rejects.toThrow("Invalid port: 0");
    await expect(
      async () => await SenderOptions.fromConfig("tcp::addr=host:0.2"),
    ).rejects.toThrow("Invalid port: 0.2");
    await expect(
      async () => await SenderOptions.fromConfig("tcp::addr=host:-2"),
    ).rejects.toThrow("Invalid port: -2");
    await expect(
      async () => await SenderOptions.fromConfig("tcp::addr=host:!;"),
    ).rejects.toThrow("Invalid port: '!'");
    await expect(
      async () => await SenderOptions.fromConfig("tcp::addr=host:9009x;"),
    ).rejects.toThrow("Invalid port: '9009x'");
    await expect(
      async () => await SenderOptions.fromConfig("tcp::addr=host:900 9;"),
    ).rejects.toThrow("Invalid port: '900 9'");
  });

  it("fails if init_buf_size is not a positive integer", async function () {
    await expect(
      async () =>
        await SenderOptions.fromConfig("tcp::addr=host;init_buf_size=;"),
    ).rejects.toThrow(
      "Invalid configuration, value is not set for 'init_buf_size'",
    );
    await expect(
      async () =>
        await SenderOptions.fromConfig("tcp::addr=host;init_buf_size=1024a;"),
    ).rejects.toThrow(
      "Invalid initial buffer size option, not a number: '1024a'",
    );
    await expect(
      async () =>
        await SenderOptions.fromConfig("tcp::addr=host;init_buf_size=102 4;"),
    ).rejects.toThrow(
      "Invalid initial buffer size option, not a number: '102 4'",
    );
    await expect(
      async () =>
        await SenderOptions.fromConfig("tcp::addr=host;init_buf_size=0;"),
    ).rejects.toThrow("Invalid initial buffer size option: 0");
  });

  it("fails if max_buf_size is not a positive integer", async function () {
    await expect(
      async () =>
        await SenderOptions.fromConfig("tcp::addr=host;max_buf_size=;"),
    ).rejects.toThrow(
      "Invalid configuration, value is not set for 'max_buf_size'",
    );
    await expect(
      async () =>
        await SenderOptions.fromConfig("tcp::addr=host;max_buf_size=1024a;"),
    ).rejects.toThrow("Invalid max buffer size option, not a number: '1024a'");
    await expect(
      async () =>
        await SenderOptions.fromConfig("tcp::addr=host;max_buf_size=102 4;"),
    ).rejects.toThrow("Invalid max buffer size option, not a number: '102 4'");
    await expect(
      async () =>
        await SenderOptions.fromConfig("tcp::addr=host;max_buf_size=0;"),
    ).rejects.toThrow("Invalid max buffer size option: 0");
  });

  it("rejects missing or empty hostname", async function () {
    await expect(
      async () => await SenderOptions.fromConfig("http::"),
    ).rejects.toThrow("Invalid configuration, 'addr' is required");
    await expect(
      async () => await SenderOptions.fromConfig("http::;"),
    ).rejects.toThrow("Missing '=' sign in ''");
    await expect(
      async () => await SenderOptions.fromConfig("http::addr=;"),
    ).rejects.toThrow("Invalid configuration, value is not set for 'addr'");
    await expect(
      async () => await SenderOptions.fromConfig("http::addr=;username=user1;"),
    ).rejects.toThrow("Invalid configuration, value is not set for 'addr'");
    await expect(
      async () => await SenderOptions.fromConfig("http::username=user1;addr=;"),
    ).rejects.toThrow("Invalid configuration, value is not set for 'addr'");
    await expect(
      async () => await SenderOptions.fromConfig("http::addr=:9000;"),
    ).rejects.toThrow("Host name is required");

    const options = await SenderOptions.fromConfig(
      "http::addr=x;protocol_version=2",
    );
    expect(options.protocol).toBe("http");
    expect(options.host).toBe("x");
  });

  it("does not default optional fields", async function () {
    const options = await SenderOptions.fromConfig(
      "https::addr=host:9000;token=abcdef123;protocol_version=2;",
    );
    expect(options.protocol).toBe("https");
    expect(options.token).toBe("abcdef123");
    expect(options.username).toBe(undefined);
    expect(options.password).toBe(undefined);
  });

  it("rejects invalid config value", async function () {
    await expect(
      async () =>
        await SenderOptions.fromConfig("http::addr=host:9000;username=;"),
    ).rejects.toThrow("Invalid configuration, value is not set for 'username'");

    await expect(
      async () =>
        await SenderOptions.fromConfig("http::addr=host:9000;username=user\t;"),
    ).rejects.toThrow(
      "Invalid configuration, control characters are not allowed: 'user\t'",
    );
    await expect(
      async () =>
        await SenderOptions.fromConfig("http::addr=host:9000;username=user\n;"),
    ).rejects.toThrow(
      "Invalid configuration, control characters are not allowed: 'user\n'",
    );

    let options = await SenderOptions.fromConfig(
      "http::addr=host:9000;username=us\x7Eer;protocol_version=2;",
    );
    expect(options.protocol).toBe("http");
    expect(options.addr).toBe("host:9000");
    expect(options.username).toBe("us\x7Eer");

    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;username=us\x7Fer;",
        ),
    ).rejects.toThrow(
      "Invalid configuration, control characters are not allowed: 'us\x7Fer'",
    );
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;username=us\x9Fer;",
        ),
    ).rejects.toThrow(
      "Invalid configuration, control characters are not allowed: 'us\x9Fer'",
    );

    options = await SenderOptions.fromConfig(
      "http::addr=host:9000;username=us\xA0er;protocol_version=2;",
    );
    expect(options.protocol).toBe("http");
    expect(options.addr).toBe("host:9000");
    expect(options.username).toBe("us\xA0er");
  });

  it("reject invalid config keys", async function () {
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;username=user1;pass=pwd;",
        ),
    ).rejects.toThrow("Unknown configuration key: 'pass'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;user=user1;password=pwd;",
        ),
    ).rejects.toThrow("Unknown configuration key: 'user'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;username =user1;password=pwd;",
        ),
    ).rejects.toThrow("Unknown configuration key: 'username '");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000; username=user1;password=pwd;",
        ),
    ).rejects.toThrow("Unknown configuration key: ' username'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;user name=user1;password=pwd;",
        ),
    ).rejects.toThrow("Unknown configuration key: 'user name'");
  });

  it("rejects keys without value", async function () {
    await expect(
      async () => await SenderOptions.fromConfig("http::addr;username=user1"),
    ).rejects.toThrow("Missing '=' sign in 'addr'");
    await expect(
      async () =>
        await SenderOptions.fromConfig("http::addr=host:9000;username;"),
    ).rejects.toThrow("Missing '=' sign in 'username'");
  });

  it("throws error if protocol is invalid", async function () {
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "::addr=host;username=user1;password=pwd;",
        ),
    ).rejects.toThrow(
      "Invalid protocol: '', accepted protocols: 'http', 'https', 'tcp', 'tcps'",
    );
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "htt::addr=host;username=user1;password=pwd;",
        ),
    ).rejects.toThrow(
      "Invalid protocol: 'htt', accepted protocols: 'http', 'https', 'tcp', 'tcps'",
    );
  });

  it("throws error if protocol is missing", async function () {
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "addr=host;username=user1;password=pwd;",
        ),
    ).rejects.toThrow(
      "Missing protocol, configuration string format: 'protocol::key1=value1;key2=value2;key3=value3;'",
    );
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "https:addr=host;username=user1;password=pwd;",
        ),
    ).rejects.toThrow(
      "Missing protocol, configuration string format: 'protocol::key1=value1;key2=value2;key3=value3;'",
    );
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "https addr=host;username=user1;password=pwd;",
        ),
    ).rejects.toThrow(
      "Missing protocol, configuration string format: 'protocol::key1=value1;key2=value2;key3=value3;'",
    );
  });

  it("throws error if configuration string is missing", async function () {
    // @ts-expect-error - Testing invalid input
    await expect(async () => await SenderOptions.fromConfig()).rejects.toThrow(
      "Configuration string is missing",
    );
    await expect(
      async () => await SenderOptions.fromConfig(""),
    ).rejects.toThrow("Configuration string is missing");
    await expect(
      async () => await SenderOptions.fromConfig(null),
    ).rejects.toThrow("Configuration string is missing");
    await expect(
      async () => await SenderOptions.fromConfig(undefined),
    ).rejects.toThrow("Configuration string is missing");
  });

  it("can parse auto_flush config", async function () {
    let options = await SenderOptions.fromConfig(
      "http::addr=host:9000;protocol_version=2;auto_flush=on;",
    );
    expect(options.protocol).toBe("http");
    expect(options.host).toBe("host");
    expect(options.port).toBe(9000);
    expect(options.auto_flush).toBe(true);

    options = await SenderOptions.fromConfig(
      "http::addr=host:9000;protocol_version=2;auto_flush=off;",
    );
    expect(options.protocol).toBe("http");
    expect(options.host).toBe("host");
    expect(options.port).toBe(9000);
    expect(options.auto_flush).toBe(false);

    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;auto_flush=ON;",
        ),
    ).rejects.toThrow("Invalid auto flush option: 'ON'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;auto_flush=On;",
        ),
    ).rejects.toThrow("Invalid auto flush option: 'On'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;auto_flush=true;",
        ),
    ).rejects.toThrow("Invalid auto flush option: 'true'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;auto_flush=OFF;",
        ),
    ).rejects.toThrow("Invalid auto flush option: 'OFF'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;auto_flush=Off;",
        ),
    ).rejects.toThrow("Invalid auto flush option: 'Off'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;auto_flush=false;",
        ),
    ).rejects.toThrow("Invalid auto flush option: 'false'");
  });

  it("can parse auto_flush_rows config", async function () {
    let options = await SenderOptions.fromConfig(
      "http::addr=host:9000;protocol_version=2;auto_flush_rows=123;",
    );
    expect(options.protocol).toBe("http");
    expect(options.auto_flush_rows).toBe(123);

    options = await SenderOptions.fromConfig(
      "http::addr=host:9000;protocol_version=2;auto_flush_rows=0;",
    );
    expect(options.protocol).toBe("http");
    expect(options.auto_flush_rows).toBe(0);

    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;auto_flush_rows=-123;",
        ),
    ).rejects.toThrow("Invalid auto flush rows option: -123");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;auto_flush_rows=1.23;",
        ),
    ).rejects.toThrow("Invalid auto flush rows option: 1.23");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;auto_flush_rows=123x;",
        ),
    ).rejects.toThrow("Invalid auto flush rows option, not a number: '123x'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;auto_flush_rows=a123;",
        ),
    ).rejects.toThrow("Invalid auto flush rows option, not a number: 'a123'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;auto_flush_rows=1w23;",
        ),
    ).rejects.toThrow("Invalid auto flush rows option, not a number: '1w23'");
  });

  it("can parse auto_flush_interval config", async function () {
    let options = await SenderOptions.fromConfig(
      "http::addr=host:9000;protocol_version=2;auto_flush_interval=30",
    );
    expect(options.protocol).toBe("http");
    expect(options.auto_flush_interval).toBe(30);

    options = await SenderOptions.fromConfig(
      "http::addr=host:9000;protocol_version=2;auto_flush_interval=0",
    );
    expect(options.protocol).toBe("http");
    expect(options.auto_flush_interval).toBe(0);

    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;auto_flush_interval=-60",
        ),
    ).rejects.toThrow("Invalid auto flush interval option: -60");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;auto_flush_interval=-6.0",
        ),
    ).rejects.toThrow("Invalid auto flush interval option: -6");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;auto_flush_interval=60x",
        ),
    ).rejects.toThrow(
      "Invalid auto flush interval option, not a number: '60x'",
    );
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;auto_flush_interval=a60",
        ),
    ).rejects.toThrow(
      "Invalid auto flush interval option, not a number: 'a60'",
    );
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;auto_flush_interval=6w0",
        ),
    ).rejects.toThrow(
      "Invalid auto flush interval option, not a number: '6w0'",
    );
  });

  it("can parse tls_verify config", async function () {
    let options = await SenderOptions.fromConfig(
      "http::addr=host:9000;protocol_version=2;tls_verify=on",
    );
    expect(options.protocol).toBe("http");
    expect(options.host).toBe("host");
    expect(options.port).toBe(9000);
    expect(options.tls_verify).toBe(true);

    options = await SenderOptions.fromConfig(
      "http::addr=host:9000;protocol_version=2;tls_verify=unsafe_off",
    );
    expect(options.protocol).toBe("http");
    expect(options.host).toBe("host");
    expect(options.port).toBe(9000);
    expect(options.tls_verify).toBe(false);

    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;tls_verify=ON",
        ),
    ).rejects.toThrow("Invalid TLS verify option: 'ON'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;tls_verify=On",
        ),
    ).rejects.toThrow("Invalid TLS verify option: 'On'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;tls_verify=true",
        ),
    ).rejects.toThrow("Invalid TLS verify option: 'true'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;tls_verify=OFF",
        ),
    ).rejects.toThrow("Invalid TLS verify option: 'OFF'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;tls_verify=Off",
        ),
    ).rejects.toThrow("Invalid TLS verify option: 'Off'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;tls_verify=UNSAFE_OFF",
        ),
    ).rejects.toThrow("Invalid TLS verify option: 'UNSAFE_OFF'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;tls_verify=Unsafe_Off",
        ),
    ).rejects.toThrow("Invalid TLS verify option: 'Unsafe_Off'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;tls_verify=false",
        ),
    ).rejects.toThrow("Invalid TLS verify option: 'false'");
  });

  it("fails with tls_roots or tls_roots_password config", async function () {
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;tls_roots=/whatever/path",
        ),
    ).rejects.toThrow(
      "'tls_roots' and 'tls_roots_password' options are not supported, please, use the 'tls_ca' option or the NODE_EXTRA_CA_CERTS environment variable instead",
    );
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;tls_roots_password=pwd",
        ),
    ).rejects.toThrow(
      "'tls_roots' and 'tls_roots_password' options are not supported, please, use the 'tls_ca' option or the NODE_EXTRA_CA_CERTS environment variable instead",
    );
  });

  it("can parse request_min_throughput config", async function () {
    const options = await SenderOptions.fromConfig(
      "http::addr=host:9000;protocol_version=2;request_min_throughput=300",
    );
    expect(options.protocol).toBe("http");
    expect(options.request_min_throughput).toBe(300);

    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;request_min_throughput=0",
        ),
    ).rejects.toThrow("Invalid request min throughput option: 0");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;request_min_throughput=0.5",
        ),
    ).rejects.toThrow("Invalid request min throughput option: 0.5");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;request_min_throughput=-60",
        ),
    ).rejects.toThrow("Invalid request min throughput option: -60");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;request_min_throughput=60x",
        ),
    ).rejects.toThrow(
      "Invalid request min throughput option, not a number: '60x'",
    );
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;request_min_throughput=a60",
        ),
    ).rejects.toThrow(
      "Invalid request min throughput option, not a number: 'a60'",
    );
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;request_min_throughput=6w0",
        ),
    ).rejects.toThrow(
      "Invalid request min throughput option, not a number: '6w0'",
    );
  });

  it("can parse request_timeout config", async function () {
    const options = await SenderOptions.fromConfig(
      "http::addr=host:9000;protocol_version=2;request_timeout=30",
    );
    expect(options.protocol).toBe("http");
    expect(options.request_timeout).toBe(30);

    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;request_timeout=0",
        ),
    ).rejects.toThrow("Invalid request timeout option: 0");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;request_timeout=10.32",
        ),
    ).rejects.toThrow("Invalid request timeout option: 10.32");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;request_timeout=-60",
        ),
    ).rejects.toThrow("Invalid request timeout option: -60");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;request_timeout=60x",
        ),
    ).rejects.toThrow("Invalid request timeout option, not a number: '60x'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;request_timeout=a60",
        ),
    ).rejects.toThrow("Invalid request timeout option, not a number: 'a60'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;request_timeout=6w0",
        ),
    ).rejects.toThrow("Invalid request timeout option, not a number: '6w0'");
  });

  it("can parse retry_timeout config", async function () {
    let options = await SenderOptions.fromConfig(
      "http::addr=host:9000;protocol_version=2;retry_timeout=60",
    );
    expect(options.protocol).toBe("http");
    expect(options.retry_timeout).toBe(60);

    options = await SenderOptions.fromConfig(
      "http::addr=host:9000;protocol_version=2;retry_timeout=0",
    );
    expect(options.protocol).toBe("http");
    expect(options.retry_timeout).toBe(0);

    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;retry_timeout=-60",
        ),
    ).rejects.toThrow("Invalid retry timeout option: -60");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;retry_timeout=-60.444",
        ),
    ).rejects.toThrow("Invalid retry timeout option: -60.444");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;retry_timeout=60x",
        ),
    ).rejects.toThrow("Invalid retry timeout option, not a number: '60x'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;retry_timeout=a60",
        ),
    ).rejects.toThrow("Invalid retry timeout option, not a number: 'a60'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;retry_timeout=6w0",
        ),
    ).rejects.toThrow("Invalid retry timeout option, not a number: '6w0'");
  });

  it("can parse max_name_len config", async function () {
    const options = await SenderOptions.fromConfig(
      "http::addr=host:9000;protocol_version=2;max_name_len=30",
    );
    expect(options.protocol).toBe("http");
    expect(options.max_name_len).toBe(30);

    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;max_name_len=0",
        ),
    ).rejects.toThrow("Invalid max name length option: 0");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;max_name_len=10.32",
        ),
    ).rejects.toThrow("Invalid max name length option: 10.32");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;max_name_len=-60",
        ),
    ).rejects.toThrow("Invalid max name length option: -60");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;max_name_len=60x",
        ),
    ).rejects.toThrow("Invalid max name length option, not a number: '60x'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;max_name_len=a60",
        ),
    ).rejects.toThrow("Invalid max name length option, not a number: 'a60'");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2;max_name_len=6w0",
        ),
    ).rejects.toThrow("Invalid max name length option, not a number: '6w0'");
  });

  it("can take a custom logger", async function () {
    const options = await SenderOptions.fromConfig(
      "http::addr=host:9000;protocol_version=2",
      {
        log: console.log,
      },
    );
    expect(options.protocol).toBe("http");
    expect(options.log).toBe(console.log);

    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2",
          // @ts-expect-error - Testing invalid input
          { log: 1234 },
        ),
    ).rejects.toThrow("Invalid logging function");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2",
          {
            // @ts-expect-error - Testing invalid input
            log: "hoppa",
          },
        ),
    ).rejects.toThrow("Invalid logging function");
  });

  it("can take a custom agent", async function () {
    const agent = new Agent({ connect: { keepAlive: true } });

    const options = await SenderOptions.fromConfig(
      "http::addr=host:9000;protocol_version=2",
      {
        agent: agent,
      },
    );
    expect(options.protocol).toBe("http");
    const symbols = Object.getOwnPropertySymbols(options.agent);
    expect(agent[symbols[6]]).toEqual({ connect: { keepAlive: true } });

    await agent.destroy();

    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2",
          {
            // @ts-expect-error - Testing invalid input
            agent: { keepAlive: true },
          },
        ),
    ).rejects.toThrow("Invalid HTTP agent");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2",
          // @ts-expect-error - Testing invalid input
          { agent: 4567 },
        ),
    ).rejects.toThrow("Invalid HTTP agent");
    await expect(
      async () =>
        await SenderOptions.fromConfig(
          "http::addr=host:9000;protocol_version=2",
          {
            // @ts-expect-error - Testing invalid input
            agent: "hopp",
          },
        ),
    ).rejects.toThrow("Invalid HTTP agent");
  });
});
