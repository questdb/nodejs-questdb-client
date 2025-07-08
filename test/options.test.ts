import { describe, it, expect } from "vitest";
import { SenderOptions } from "../src/options";
import { Agent } from "undici";

describe("Configuration string parser suite", function () {
  it("can parse a basic config string", function () {
    const options = SenderOptions.fromConfig(
      "https::addr=host;username=user1;password=pwd;",
    );
    expect(options.protocol).toBe("https");
    expect(options.addr).toBe("host");
    expect(options.username).toBe("user1");
    expect(options.password).toBe("pwd");
  });

  it("can parse a config string from environment variable", async function () {
    process.env.QDB_CLIENT_CONF = "tcp::addr=host;";
    const options = SenderOptions.fromEnv();
    expect(options.protocol).toBe("tcp");
    expect(options.addr).toBe("host");
  });

  it("accepts only lowercase protocols", function () {
    let options = SenderOptions.fromConfig("tcp::addr=host;");
    expect(options.protocol).toBe("tcp");

    options = SenderOptions.fromConfig("tcps::addr=host;");
    expect(options.protocol).toBe("tcps");

    options = SenderOptions.fromConfig("http::addr=host;");
    expect(options.protocol).toBe("http");

    options = SenderOptions.fromConfig("https::addr=host;");
    expect(options.protocol).toBe("https");

    expect(() => SenderOptions.fromConfig("HTTP::")).toThrow(
      "Invalid protocol: 'HTTP', accepted protocols: 'http', 'https', 'tcp', 'tcps'",
    );
    expect(() => SenderOptions.fromConfig("Http::")).toThrow(
      "Invalid protocol: 'Http', accepted protocols: 'http', 'https', 'tcp', 'tcps'",
    );
    expect(() => SenderOptions.fromConfig("HtTps::")).toThrow(
      "Invalid protocol: 'HtTps', accepted protocols: 'http', 'https', 'tcp', 'tcps'",
    );

    expect(() => SenderOptions.fromConfig("TCP::")).toThrow(
      "Invalid protocol: 'TCP', accepted protocols: 'http', 'https', 'tcp', 'tcps'",
    );
    expect(() => SenderOptions.fromConfig("TcP::")).toThrow(
      "Invalid protocol: 'TcP', accepted protocols: 'http', 'https', 'tcp', 'tcps'",
    );
    expect(() => SenderOptions.fromConfig("Tcps::")).toThrow(
      "Invalid protocol: 'Tcps', accepted protocols: 'http', 'https', 'tcp', 'tcps'",
    );
  });

  it("considers that keys and values are case-sensitive", function () {
    const options = SenderOptions.fromConfig(
      "tcps::addr=Host;username=useR1;token=TOKEN;",
    );
    expect(options.protocol).toBe("tcps");
    expect(options.addr).toBe("Host");
    expect(options.username).toBe("useR1");
    expect(options.token).toBe("TOKEN");

    expect(() =>
      SenderOptions.fromConfig("tcps::addr=Host;UserNAME=useR1;PaSswOrD=pWd;"),
    ).toThrow("Unknown configuration key: 'UserNAME'");
    expect(() =>
      SenderOptions.fromConfig("tcps::addr=Host;PaSswOrD=pWd;"),
    ).toThrow("Unknown configuration key: 'PaSswOrD'");
  });

  it("can parse with or without the last semicolon", function () {
    let options = SenderOptions.fromConfig("https::addr=host:9002");
    expect(options.protocol).toBe("https");
    expect(options.addr).toBe("host:9002");

    options = SenderOptions.fromConfig("https::addr=host:9002;");
    expect(options.protocol).toBe("https");
    expect(options.addr).toBe("host:9002");

    options = SenderOptions.fromConfig("https::addr=host:9002;token=abcde");
    expect(options.protocol).toBe("https");
    expect(options.addr).toBe("host:9002");
    expect(options.token).toBe("abcde");

    options = SenderOptions.fromConfig("https::addr=host:9002;token=abcde;");
    expect(options.protocol).toBe("https");
    expect(options.addr).toBe("host:9002");
    expect(options.token).toBe("abcde");

    options = SenderOptions.fromConfig("https::addr=host:9002;token=abcde;;");
    expect(options.protocol).toBe("https");
    expect(options.addr).toBe("host:9002");
    expect(options.token).toBe("abcde;");

    options = SenderOptions.fromConfig("https::addr=host:9002;token=abcde;;;");
    expect(options.protocol).toBe("https");
    expect(options.addr).toBe("host:9002");
    expect(options.token).toBe("abcde;");
  });

  it("can parse escaped config string values", function () {
    const options = SenderOptions.fromConfig(
      "https::addr=host:9002;username=us;;;;;;er;;1;;;password=p;;wd;",
    );
    expect(options.protocol).toBe("https");
    expect(options.addr).toBe("host:9002");
    expect(options.username).toBe("us;;;er;1;");
    expect(options.password).toBe("p;wd");
  });

  it("can parse the address", function () {
    let options = SenderOptions.fromConfig(
      "https::addr=host1:9002;token=resttoken123;",
    );
    expect(options.protocol).toBe("https");
    expect(options.addr).toBe("host1:9002");
    expect(options.host).toBe("host1");
    expect(options.port).toBe(9002);
    expect(options.token).toBe("resttoken123");

    options = SenderOptions.fromConfig(
      "tcps::addr=host2:9005;username=user1;token=jwkprivkey123;",
    );
    expect(options.protocol).toBe("tcps");
    expect(options.addr).toBe("host2:9005");
    expect(options.host).toBe("host2");
    expect(options.port).toBe(9005);
    expect(options.username).toBe("user1");
    expect(options.token).toBe("jwkprivkey123");
  });

  it("can default the port", function () {
    let options = SenderOptions.fromConfig(
      "https::addr=hostname;token=resttoken123;",
    );
    expect(options.protocol).toBe("https");
    expect(options.addr).toBe("hostname");
    expect(options.host).toBe("hostname");
    expect(options.port).toBe(9000);
    expect(options.token).toBe("resttoken123");

    options = SenderOptions.fromConfig(
      "http::addr=hostname;token=resttoken123;",
    );
    expect(options.protocol).toBe("http");
    expect(options.addr).toBe("hostname");
    expect(options.host).toBe("hostname");
    expect(options.port).toBe(9000);
    expect(options.token).toBe("resttoken123");

    options = SenderOptions.fromConfig(
      "tcps::addr=hostname;username=user1;token=jwkprivkey123;",
    );
    expect(options.protocol).toBe("tcps");
    expect(options.addr).toBe("hostname");
    expect(options.host).toBe("hostname");
    expect(options.port).toBe(9009);
    expect(options.username).toBe("user1");
    expect(options.token).toBe("jwkprivkey123");

    options = SenderOptions.fromConfig(
      "tcp::addr=hostname;username=user1;token=jwkprivkey123;",
    );
    expect(options.protocol).toBe("tcp");
    expect(options.addr).toBe("hostname");
    expect(options.host).toBe("hostname");
    expect(options.port).toBe(9009);
    expect(options.username).toBe("user1");
    expect(options.token).toBe("jwkprivkey123");
  });

  it("fails if port is not a positive integer", function () {
    expect(() => SenderOptions.fromConfig("tcp::addr=host:;")).toThrow(
      "Port is required",
    );
    expect(() => SenderOptions.fromConfig("tcp::addr=host:0")).toThrow(
      "Invalid port: 0",
    );
    expect(() => SenderOptions.fromConfig("tcp::addr=host:0.2")).toThrow(
      "Invalid port: 0.2",
    );
    expect(() => SenderOptions.fromConfig("tcp::addr=host:-2")).toThrow(
      "Invalid port: -2",
    );
    expect(() => SenderOptions.fromConfig("tcp::addr=host:!;")).toThrow(
      "Invalid port: '!'",
    );
    expect(() => SenderOptions.fromConfig("tcp::addr=host:9009x;")).toThrow(
      "Invalid port: '9009x'",
    );
    expect(() => SenderOptions.fromConfig("tcp::addr=host:900 9;")).toThrow(
      "Invalid port: '900 9'",
    );
  });

  it("fails if init_buf_size is not a positive integer", function () {
    expect(() =>
      SenderOptions.fromConfig("tcp::addr=host;init_buf_size=;"),
    ).toThrow("Invalid configuration, value is not set for 'init_buf_size'");
    expect(() =>
      SenderOptions.fromConfig("tcp::addr=host;init_buf_size=1024a;"),
    ).toThrow("Invalid initial buffer size option, not a number: '1024a'");
    expect(() =>
      SenderOptions.fromConfig("tcp::addr=host;init_buf_size=102 4;"),
    ).toThrow("Invalid initial buffer size option, not a number: '102 4'");
    expect(() =>
      SenderOptions.fromConfig("tcp::addr=host;init_buf_size=0;"),
    ).toThrow("Invalid initial buffer size option: 0");
  });

  it("fails if max_buf_size is not a positive integer", function () {
    expect(() =>
      SenderOptions.fromConfig("tcp::addr=host;max_buf_size=;"),
    ).toThrow("Invalid configuration, value is not set for 'max_buf_size'");
    expect(() =>
      SenderOptions.fromConfig("tcp::addr=host;max_buf_size=1024a;"),
    ).toThrow("Invalid max buffer size option, not a number: '1024a'");
    expect(() =>
      SenderOptions.fromConfig("tcp::addr=host;max_buf_size=102 4;"),
    ).toThrow("Invalid max buffer size option, not a number: '102 4'");
    expect(() =>
      SenderOptions.fromConfig("tcp::addr=host;max_buf_size=0;"),
    ).toThrow("Invalid max buffer size option: 0");
  });

  it("rejects missing or empty hostname", function () {
    expect(() => SenderOptions.fromConfig("http::")).toThrow(
      "Invalid configuration, 'addr' is required",
    );
    expect(() => SenderOptions.fromConfig("http::;")).toThrow(
      "Missing '=' sign in ''",
    );
    expect(() => SenderOptions.fromConfig("http::addr=;")).toThrow(
      "Invalid configuration, value is not set for 'addr'",
    );
    expect(() =>
      SenderOptions.fromConfig("http::addr=;username=user1;"),
    ).toThrow("Invalid configuration, value is not set for 'addr'");
    expect(() =>
      SenderOptions.fromConfig("http::username=user1;addr=;"),
    ).toThrow("Invalid configuration, value is not set for 'addr'");
    expect(() => SenderOptions.fromConfig("http::addr=:9000;")).toThrow(
      "Host name is required",
    );

    const options = SenderOptions.fromConfig("http::addr=x;");
    expect(options.protocol).toBe("http");
    expect(options.host).toBe("x");
    expect(options.host).toBe("x");
  });

  it("does not default optional fields", function () {
    const options = SenderOptions.fromConfig(
      "https::addr=host:9000;token=abcdef123;",
    );
    expect(options.protocol).toBe("https");
    expect(options.token).toBe("abcdef123");
    expect(options.username).toBe(undefined);
    expect(options.password).toBe(undefined);
  });

  it("rejects invalid config value", function () {
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;username=;"),
    ).toThrow("Invalid configuration, value is not set for 'username'");

    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;username=user\t;"),
    ).toThrow(
      "Invalid configuration, control characters are not allowed: 'user\t'",
    );
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;username=user\n;"),
    ).toThrow(
      "Invalid configuration, control characters are not allowed: 'user\n'",
    );

    let options = SenderOptions.fromConfig(
      "http::addr=host:9000;username=us\x7Eer;",
    );
    expect(options.protocol).toBe("http");
    expect(options.addr).toBe("host:9000");
    expect(options.username).toBe("us\x7Eer");

    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;username=us\x7Fer;"),
    ).toThrow(
      "Invalid configuration, control characters are not allowed: 'us\x7Fer'",
    );
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;username=us\x9Fer;"),
    ).toThrow(
      "Invalid configuration, control characters are not allowed: 'us\x9Fer'",
    );

    options = SenderOptions.fromConfig(
      "http::addr=host:9000;username=us\xA0er;",
    );
    expect(options.protocol).toBe("http");
    expect(options.addr).toBe("host:9000");
    expect(options.username).toBe("us\xA0er");
  });

  it("reject invalid config keys", function () {
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;username=user1;pass=pwd;"),
    ).toThrow("Unknown configuration key: 'pass'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;user=user1;password=pwd;"),
    ).toThrow("Unknown configuration key: 'user'");
    expect(() =>
      SenderOptions.fromConfig(
        "http::addr=host:9000;username =user1;password=pwd;",
      ),
    ).toThrow("Unknown configuration key: 'username '");
    expect(() =>
      SenderOptions.fromConfig(
        "http::addr=host:9000; username=user1;password=pwd;",
      ),
    ).toThrow("Unknown configuration key: ' username'");
    expect(() =>
      SenderOptions.fromConfig(
        "http::addr=host:9000;user name=user1;password=pwd;",
      ),
    ).toThrow("Unknown configuration key: 'user name'");
  });

  it("rejects keys without value", function () {
    expect(() => SenderOptions.fromConfig("http::addr;username=user1")).toThrow(
      "Missing '=' sign in 'addr'",
    );
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;username;"),
    ).toThrow("Missing '=' sign in 'username'");
  });

  it("throws error if protocol is invalid", function () {
    expect(() =>
      SenderOptions.fromConfig("::addr=host;username=user1;password=pwd;"),
    ).toThrow(
      "Invalid protocol: '', accepted protocols: 'http', 'https', 'tcp', 'tcps'",
    );
    expect(() =>
      SenderOptions.fromConfig("htt::addr=host;username=user1;password=pwd;"),
    ).toThrow(
      "Invalid protocol: 'htt', accepted protocols: 'http', 'https', 'tcp', 'tcps'",
    );
  });

  it("throws error if protocol is missing", function () {
    expect(() =>
      SenderOptions.fromConfig("addr=host;username=user1;password=pwd;"),
    ).toThrow(
      "Missing protocol, configuration string format: 'protocol::key1=value1;key2=value2;key3=value3;'",
    );
    expect(() =>
      SenderOptions.fromConfig("https:addr=host;username=user1;password=pwd;"),
    ).toThrow(
      "Missing protocol, configuration string format: 'protocol::key1=value1;key2=value2;key3=value3;'",
    );
    expect(() =>
      SenderOptions.fromConfig("https addr=host;username=user1;password=pwd;"),
    ).toThrow(
      "Missing protocol, configuration string format: 'protocol::key1=value1;key2=value2;key3=value3;'",
    );
  });

  it("throws error if configuration string is missing", function () {
    // @ts-expect-error - Testing invalid input
    expect(() => SenderOptions.fromConfig()).toThrow(
      "Configuration string is missing",
    );
    expect(() => SenderOptions.fromConfig("")).toThrow(
      "Configuration string is missing",
    );
    expect(() => SenderOptions.fromConfig(null)).toThrow(
      "Configuration string is missing",
    );
    expect(() => SenderOptions.fromConfig(undefined)).toThrow(
      "Configuration string is missing",
    );
  });

  it("can parse auto_flush config", function () {
    let options = SenderOptions.fromConfig(
      "http::addr=host:9000;auto_flush=on;",
    );
    expect(options.protocol).toBe("http");
    expect(options.host).toBe("host");
    expect(options.port).toBe(9000);
    expect(options.auto_flush).toBe(true);

    options = SenderOptions.fromConfig("http::addr=host:9000;auto_flush=off;");
    expect(options.protocol).toBe("http");
    expect(options.host).toBe("host");
    expect(options.port).toBe(9000);
    expect(options.auto_flush).toBe(false);

    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;auto_flush=ON;"),
    ).toThrow("Invalid auto flush option: 'ON'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;auto_flush=On;"),
    ).toThrow("Invalid auto flush option: 'On'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;auto_flush=true;"),
    ).toThrow("Invalid auto flush option: 'true'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;auto_flush=OFF;"),
    ).toThrow("Invalid auto flush option: 'OFF'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;auto_flush=Off;"),
    ).toThrow("Invalid auto flush option: 'Off'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;auto_flush=false;"),
    ).toThrow("Invalid auto flush option: 'false'");
  });

  it("can parse auto_flush_rows config", function () {
    let options = SenderOptions.fromConfig(
      "http::addr=host:9000;auto_flush_rows=123;",
    );
    expect(options.protocol).toBe("http");
    expect(options.auto_flush_rows).toBe(123);

    options = SenderOptions.fromConfig(
      "http::addr=host:9000;auto_flush_rows=0;",
    );
    expect(options.protocol).toBe("http");
    expect(options.auto_flush_rows).toBe(0);

    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;auto_flush_rows=-123;"),
    ).toThrow("Invalid auto flush rows option: -123");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;auto_flush_rows=1.23;"),
    ).toThrow("Invalid auto flush rows option: 1.23");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;auto_flush_rows=123x;"),
    ).toThrow("Invalid auto flush rows option, not a number: '123x'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;auto_flush_rows=a123;"),
    ).toThrow("Invalid auto flush rows option, not a number: 'a123'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;auto_flush_rows=1w23;"),
    ).toThrow("Invalid auto flush rows option, not a number: '1w23'");
  });

  it("can parse auto_flush_interval config", function () {
    let options = SenderOptions.fromConfig(
      "http::addr=host:9000;auto_flush_interval=30",
    );
    expect(options.protocol).toBe("http");
    expect(options.auto_flush_interval).toBe(30);

    options = SenderOptions.fromConfig(
      "http::addr=host:9000;auto_flush_interval=0",
    );
    expect(options.protocol).toBe("http");
    expect(options.auto_flush_interval).toBe(0);

    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;auto_flush_interval=-60"),
    ).toThrow("Invalid auto flush interval option: -60");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;auto_flush_interval=-6.0"),
    ).toThrow("Invalid auto flush interval option: -6");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;auto_flush_interval=60x"),
    ).toThrow("Invalid auto flush interval option, not a number: '60x'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;auto_flush_interval=a60"),
    ).toThrow("Invalid auto flush interval option, not a number: 'a60'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;auto_flush_interval=6w0"),
    ).toThrow("Invalid auto flush interval option, not a number: '6w0'");
  });

  it("can parse tls_verify config", function () {
    let options = SenderOptions.fromConfig(
      "http::addr=host:9000;tls_verify=on",
    );
    expect(options.protocol).toBe("http");
    expect(options.host).toBe("host");
    expect(options.port).toBe(9000);
    expect(options.tls_verify).toBe(true);

    options = SenderOptions.fromConfig(
      "http::addr=host:9000;tls_verify=unsafe_off",
    );
    expect(options.protocol).toBe("http");
    expect(options.host).toBe("host");
    expect(options.port).toBe(9000);
    expect(options.tls_verify).toBe(false);

    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;tls_verify=ON"),
    ).toThrow("Invalid TLS verify option: 'ON'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;tls_verify=On"),
    ).toThrow("Invalid TLS verify option: 'On'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;tls_verify=true"),
    ).toThrow("Invalid TLS verify option: 'true'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;tls_verify=OFF"),
    ).toThrow("Invalid TLS verify option: 'OFF'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;tls_verify=Off"),
    ).toThrow("Invalid TLS verify option: 'Off'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;tls_verify=UNSAFE_OFF"),
    ).toThrow("Invalid TLS verify option: 'UNSAFE_OFF'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;tls_verify=Unsafe_Off"),
    ).toThrow("Invalid TLS verify option: 'Unsafe_Off'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;tls_verify=false"),
    ).toThrow("Invalid TLS verify option: 'false'");
  });

  it("fails with tls_roots or tls_roots_password config", function () {
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;tls_roots=/whatever/path"),
    ).toThrow(
      "'tls_roots' and 'tls_roots_password' options are not supported, please, use the 'tls_ca' option or the NODE_EXTRA_CA_CERTS environment variable instead",
    );
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;tls_roots_password=pwd"),
    ).toThrow(
      "'tls_roots' and 'tls_roots_password' options are not supported, please, use the 'tls_ca' option or the NODE_EXTRA_CA_CERTS environment variable instead",
    );
  });

  it("can parse request_min_throughput config", function () {
    const options = SenderOptions.fromConfig(
      "http::addr=host:9000;request_min_throughput=300",
    );
    expect(options.protocol).toBe("http");
    expect(options.request_min_throughput).toBe(300);

    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;request_min_throughput=0"),
    ).toThrow("Invalid request min throughput option: 0");
    expect(() =>
      SenderOptions.fromConfig(
        "http::addr=host:9000;request_min_throughput=0.5",
      ),
    ).toThrow("Invalid request min throughput option: 0.5");
    expect(() =>
      SenderOptions.fromConfig(
        "http::addr=host:9000;request_min_throughput=-60",
      ),
    ).toThrow("Invalid request min throughput option: -60");
    expect(() =>
      SenderOptions.fromConfig(
        "http::addr=host:9000;request_min_throughput=60x",
      ),
    ).toThrow("Invalid request min throughput option, not a number: '60x'");
    expect(() =>
      SenderOptions.fromConfig(
        "http::addr=host:9000;request_min_throughput=a60",
      ),
    ).toThrow("Invalid request min throughput option, not a number: 'a60'");
    expect(() =>
      SenderOptions.fromConfig(
        "http::addr=host:9000;request_min_throughput=6w0",
      ),
    ).toThrow("Invalid request min throughput option, not a number: '6w0'");
  });

  it("can parse request_timeout config", function () {
    const options = SenderOptions.fromConfig(
      "http::addr=host:9000;request_timeout=30",
    );
    expect(options.protocol).toBe("http");
    expect(options.request_timeout).toBe(30);

    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;request_timeout=0"),
    ).toThrow("Invalid request timeout option: 0");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;request_timeout=10.32"),
    ).toThrow("Invalid request timeout option: 10.32");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;request_timeout=-60"),
    ).toThrow("Invalid request timeout option: -60");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;request_timeout=60x"),
    ).toThrow("Invalid request timeout option, not a number: '60x'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;request_timeout=a60"),
    ).toThrow("Invalid request timeout option, not a number: 'a60'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;request_timeout=6w0"),
    ).toThrow("Invalid request timeout option, not a number: '6w0'");
  });

  it("can parse retry_timeout config", function () {
    let options = SenderOptions.fromConfig(
      "http::addr=host:9000;retry_timeout=60",
    );
    expect(options.protocol).toBe("http");
    expect(options.retry_timeout).toBe(60);

    options = SenderOptions.fromConfig("http::addr=host:9000;retry_timeout=0");
    expect(options.protocol).toBe("http");
    expect(options.retry_timeout).toBe(0);

    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;retry_timeout=-60"),
    ).toThrow("Invalid retry timeout option: -60");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;retry_timeout=-60.444"),
    ).toThrow("Invalid retry timeout option: -60.444");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;retry_timeout=60x"),
    ).toThrow("Invalid retry timeout option, not a number: '60x'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;retry_timeout=a60"),
    ).toThrow("Invalid retry timeout option, not a number: 'a60'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;retry_timeout=6w0"),
    ).toThrow("Invalid retry timeout option, not a number: '6w0'");
  });

  it("can parse copy_buffer config", function () {
    let options = SenderOptions.fromConfig(
      "http::addr=host:9000;copy_buffer=on;",
    );
    expect(options.protocol).toBe("http");
    expect(options.host).toBe("host");
    expect(options.port).toBe(9000);
    expect(options.copy_buffer).toBe(true);

    options = SenderOptions.fromConfig("http::addr=host:9000;copy_buffer=off;");
    expect(options.protocol).toBe("http");
    expect(options.host).toBe("host");
    expect(options.port).toBe(9000);
    expect(options.copy_buffer).toBe(false);

    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;copy_buffer=ON;"),
    ).toThrow("Invalid copy buffer option: 'ON'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;copy_buffer=On;"),
    ).toThrow("Invalid copy buffer option: 'On'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;copy_buffer=true;"),
    ).toThrow("Invalid copy buffer option: 'true'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;copy_buffer=OFF;"),
    ).toThrow("Invalid copy buffer option: 'OFF'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;copy_buffer=Off;"),
    ).toThrow("Invalid copy buffer option: 'Off'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;copy_buffer=false;"),
    ).toThrow("Invalid copy buffer option: 'false'");
  });

  it("can parse max_name_len config", function () {
    const options = SenderOptions.fromConfig(
      "http::addr=host:9000;max_name_len=30",
    );
    expect(options.protocol).toBe("http");
    expect(options.max_name_len).toBe(30);

    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;max_name_len=0"),
    ).toThrow("Invalid max name length option: 0");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;max_name_len=10.32"),
    ).toThrow("Invalid max name length option: 10.32");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;max_name_len=-60"),
    ).toThrow("Invalid max name length option: -60");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;max_name_len=60x"),
    ).toThrow("Invalid max name length option, not a number: '60x'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;max_name_len=a60"),
    ).toThrow("Invalid max name length option, not a number: 'a60'");
    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000;max_name_len=6w0"),
    ).toThrow("Invalid max name length option, not a number: '6w0'");
  });

  it("can take a custom logger", function () {
    const options = SenderOptions.fromConfig("http::addr=host:9000", {
      log: console.log,
    });
    expect(options.protocol).toBe("http");
    expect(options.log).toBe(console.log);

    expect(() =>
      // @ts-expect-error - Testing invalid input
      SenderOptions.fromConfig("http::addr=host:9000", { log: 1234 }),
    ).toThrow("Invalid logging function");
    expect(() =>
      // @ts-expect-error - Testing invalid input
      SenderOptions.fromConfig("http::addr=host:9000", { log: "hoppa" }),
    ).toThrow("Invalid logging function");
  });

  it("can take a custom agent", function () {
    const agent = new Agent({ connect: { keepAlive: true } });

    const options = SenderOptions.fromConfig("http::addr=host:9000", {
      agent: agent,
    });
    expect(options.protocol).toBe("http");
    const symbols = Object.getOwnPropertySymbols(options.agent);
    expect(agent[symbols[6]]).toEqual({ connect: { keepAlive: true } });

    agent.destroy();

    expect(() =>
      SenderOptions.fromConfig("http::addr=host:9000", {
        // @ts-expect-error - Testing invalid input
        agent: { keepAlive: true },
      }),
    ).toThrow("Invalid http/https agent");
    expect(() =>
      // @ts-expect-error - Testing invalid input
      SenderOptions.fromConfig("http::addr=host:9000", { agent: 4567 }),
    ).toThrow("Invalid http/https agent");
    expect(() =>
      // @ts-expect-error - Testing invalid input
      SenderOptions.fromConfig("http::addr=host:9000", { agent: "hopp" }),
    ).toThrow("Invalid http/https agent");
  });
});
