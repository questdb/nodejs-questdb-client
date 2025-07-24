// @ts-check
import { describe, it, expect } from "vitest";

import { Sender } from "../src";
import { DEFAULT_BUFFER_SIZE, DEFAULT_MAX_BUFFER_SIZE } from "../src/buffer";
import { log } from "../src/logging";

describe("Sender configuration options suite", function () {
  it("creates a sender from a configuration string", async function () {
    const sender = await Sender.fromConfig("tcps::addr=hostname;");
    await sender.close();
  });

  it("creates a sender from a configuration string picked up from env", async function () {
    process.env.QDB_CLIENT_CONF = "https::addr=hostname;protocol_version=1";
    await (await Sender.fromEnv()).close();
  });

  it("throws exception if the username or the token is missing when TCP transport is used", async function () {
    await expect(async () => {
      const sender = await Sender.fromConfig(
        "tcp::addr=hostname;username=bobo;",
      );
      await sender.close();
    }).rejects.toThrow(
      "TCP transport requires a username and a private key for authentication, please, specify the 'username' and 'token' config options",
    );

    await expect(async () => {
      const sender = await Sender.fromConfig(
        "tcp::addr=hostname;token=bobo_token;",
      );
      await sender.close();
    }).rejects.toThrow(
      "TCP transport requires a username and a private key for authentication, please, specify the 'username' and 'token' config options",
    );
  });

  it("throws exception if tls_roots or tls_roots_password is used", async function () {
    await expect(async () => {
      const sender = await Sender.fromConfig(
        "tcps::addr=hostname;username=bobo;tls_roots=bla;",
      );
      await sender.close();
    }).rejects.toThrow(
      "'tls_roots' and 'tls_roots_password' options are not supported, please, use the 'tls_ca' option or the NODE_EXTRA_CA_CERTS environment variable instead",
    );

    await expect(async () => {
      const sender = await Sender.fromConfig(
        "tcps::addr=hostname;token=bobo_token;tls_roots_password=bla;",
      );
      await sender.close();
    }).rejects.toThrow(
      "'tls_roots' and 'tls_roots_password' options are not supported, please, use the 'tls_ca' option or the NODE_EXTRA_CA_CERTS environment variable instead",
    );
  });

  it("throws exception if connect() is called when http transport is used", async function () {
    let sender: Sender;
    await expect(async () => {
      sender = await Sender.fromConfig(
        "http::addr=hostname;protocol_version=2",
      );
      await sender.connect();
    }).rejects.toThrow("'connect()' is not required for HTTP transport");
    await sender.close();
  });
});

describe("Sender options test suite", function () {
  it("fails if no options defined", async function () {
    await expect(
      async () =>
        // @ts-expect-error - Testing invalid options
        await new Sender().close(),
    ).rejects.toThrow("The 'protocol' option is mandatory");
  });

  it("fails if options are null", async function () {
    await expect(async () => await new Sender(null).close()).rejects.toThrow(
      "The 'protocol' option is mandatory",
    );
  });

  it("fails if options are undefined", async function () {
    await expect(
      async () => await new Sender(undefined).close(),
    ).rejects.toThrow("The 'protocol' option is mandatory");
  });

  it("fails if options are empty", async function () {
    await expect(
      async () =>
        // @ts-expect-error - Testing invalid options
        await new Sender({}).close(),
    ).rejects.toThrow("The 'protocol' option is mandatory");
  });

  it("fails if protocol option is missing", async function () {
    await expect(
      async () =>
        // @ts-expect-error - Testing invalid options
        await new Sender({ host: "host" }).close(),
    ).rejects.toThrow("The 'protocol' option is mandatory");
  });

  it("fails if protocol option is invalid", async function () {
    await expect(
      async () =>
        await new Sender({ protocol: "abcd", host: "hostname" }).close(),
    ).rejects.toThrow("Invalid protocol: 'abcd'");
  });

  it("sets default buffer size if init_buf_size is not set", async function () {
    const sender = new Sender({
      protocol: "http",
      protocol_version: "1",
      host: "host",
    });
    expect(bufferSize(sender)).toBe(DEFAULT_BUFFER_SIZE);
    await sender.close();
  });

  it("sets the requested buffer size if init_buf_size is set", async function () {
    const sender = new Sender({
      protocol: "http",
      protocol_version: "1",
      host: "host",
      init_buf_size: 1024,
    });
    expect(bufferSize(sender)).toBe(1024);
    await sender.close();
  });

  it("sets default buffer size if init_buf_size is set to null", async function () {
    const sender = new Sender({
      protocol: "http",
      protocol_version: "1",
      host: "host",
      init_buf_size: null,
    });
    expect(bufferSize(sender)).toBe(DEFAULT_BUFFER_SIZE);
    await sender.close();
  });

  it("sets default buffer size if init_buf_size is set to undefined", async function () {
    const sender = new Sender({
      protocol: "http",
      protocol_version: "1",
      host: "host",
      init_buf_size: undefined,
    });
    expect(bufferSize(sender)).toBe(DEFAULT_BUFFER_SIZE);
    await sender.close();
  });

  it("sets default buffer size if init_buf_size is not a number", async function () {
    const sender = new Sender({
      protocol: "http",
      protocol_version: "1",
      host: "host",
      // @ts-expect-error - Testing invalid options
      init_buf_size: "1024",
    });
    expect(bufferSize(sender)).toBe(DEFAULT_BUFFER_SIZE);
    await sender.close();
  });

  it("sets the requested buffer size if 'bufferSize' is set, but warns that it is deprecated", async function () {
    const log = (
      level: "error" | "warn" | "info" | "debug",
      message: string | Error,
    ) => {
      if (level !== "debug") {
        expect(level).toBe("warn");
        expect(message).toMatch(
          "Option 'bufferSize' is not supported anymore, please, replace it with 'init_buf_size'",
        );
      }
    };
    const sender = new Sender({
      protocol: "http",
      protocol_version: "1",
      host: "host",
      // @ts-expect-error - Testing deprecated option
      bufferSize: 2048,
      log: log,
    });
    expect(bufferSize(sender)).toBe(2048);
    await sender.close();
  });

  it("warns about deprecated option 'copy_buffer'", async function () {
    const log = (
      level: "error" | "warn" | "info" | "debug",
      message: string,
    ) => {
      if (level !== "debug") {
        expect(level).toBe("warn");
        expect(message).toMatch(
          "Option 'copy_buffer' is not supported anymore, please, remove it",
        );
      }
    };
    const sender = new Sender({
      protocol: "http",
      protocol_version: "1",
      host: "host",
      // @ts-expect-error - Testing deprecated option
      copy_buffer: false,
      log: log,
    });
    await sender.close();
  });

  it("warns about deprecated option 'copyBuffer'", async function () {
    const log = (
      level: "error" | "warn" | "info" | "debug",
      message: string,
    ) => {
      if (level !== "debug") {
        expect(level).toBe("warn");
        expect(message).toMatch(
          "Option 'copyBuffer' is not supported anymore, please, remove it",
        );
      }
    };
    const sender = new Sender({
      protocol: "http",
      protocol_version: "1",
      host: "host",
      // @ts-expect-error - Testing deprecated option
      copyBuffer: false,
      log: log,
    });
    await sender.close();
  });

  it("sets default max buffer size if max_buf_size is not set", async function () {
    const sender = new Sender({
      protocol: "http",
      protocol_version: "2",
      host: "host",
    });
    expect(maxBufferSize(sender)).toBe(DEFAULT_MAX_BUFFER_SIZE);
    await sender.close();
  });

  it("sets the requested max buffer size if max_buf_size is set", async function () {
    const sender = new Sender({
      protocol: "http",
      protocol_version: "1",
      host: "host",
      max_buf_size: 131072,
    });
    expect(maxBufferSize(sender)).toBe(131072);
    await sender.close();
  });

  it("throws error if initial buffer size is greater than max_buf_size", async function () {
    await expect(
      async () =>
        await new Sender({
          protocol: "http",
          protocol_version: "1",
          host: "host",
          max_buf_size: 8192,
          init_buf_size: 16384,
        }).close(),
    ).rejects.toThrow(
      "Max buffer size is 8192 bytes, requested buffer size: 16384",
    );
  });

  it("sets default max buffer size if max_buf_size is set to null", async function () {
    const sender = new Sender({
      protocol: "http",
      protocol_version: "1",
      host: "host",
      max_buf_size: null,
    });
    expect(maxBufferSize(sender)).toBe(DEFAULT_MAX_BUFFER_SIZE);
    await sender.close();
  });

  it("sets default max buffer size if max_buf_size is set to undefined", async function () {
    const sender = new Sender({
      protocol: "http",
      protocol_version: "1",
      host: "host",
      max_buf_size: undefined,
    });
    expect(maxBufferSize(sender)).toBe(DEFAULT_MAX_BUFFER_SIZE);
    await sender.close();
  });

  it("sets default max buffer size if max_buf_size is not a number", async function () {
    const sender = new Sender({
      protocol: "http",
      protocol_version: "1",
      host: "host",
      // @ts-expect-error - Testing invalid value
      max_buf_size: "1024",
    });
    expect(maxBufferSize(sender)).toBe(DEFAULT_MAX_BUFFER_SIZE);
    await sender.close();
  });

  it("uses default logger if log function is not set", async function () {
    const sender = new Sender({
      protocol: "http",
      protocol_version: "1",
      host: "host",
    });
    expect(logger(sender)).toBe(log);
    await sender.close();
  });

  it("uses the required log function if it is set", async function () {
    const testFunc = () => {};
    const sender = new Sender({
      protocol: "http",
      protocol_version: "1",
      host: "host",
      log: testFunc,
    });
    expect(logger(sender)).toBe(testFunc);
    await sender.close();
  });

  it("uses default logger if log is set to null", async function () {
    const sender = new Sender({
      protocol: "http",
      protocol_version: "1",
      host: "host",
      log: null,
    });
    expect(logger(sender)).toBe(log);
    await sender.close();
  });

  it("uses default logger if log is set to undefined", async function () {
    const sender = new Sender({
      protocol: "http",
      protocol_version: "2",
      host: "host",
      log: undefined,
    });
    expect(logger(sender)).toBe(log);
    await sender.close();
  });

  it("uses default logger if log is not a function", async function () {
    const sender = new Sender({
      protocol: "http",
      protocol_version: "2",
      host: "host",
      // @ts-expect-error - Testing invalid options
      log: "",
    });
    expect(logger(sender)).toBe(log);
    await sender.close();
  });
});

describe("Sender auth config checks suite", function () {
  it("requires a username for authentication", async function () {
    await expect(
      async () =>
        await new Sender({
          protocol: "tcp",
          protocol_version: "2",
          host: "host",
          auth: {
            token: "privateKey",
          },
        }).close(),
    ).rejects.toThrow(
      "Missing username, please, specify the 'keyId' property of the 'auth' config option. " +
        "For example: new Sender({protocol: 'tcp', host: 'host', auth: {keyId: 'username', token: 'private key'}})",
    );
  });

  it("requires a non-empty username", async function () {
    await expect(
      async () =>
        await new Sender({
          protocol: "tcp",
          protocol_version: "2",
          host: "host",
          auth: {
            keyId: "",
            token: "privateKey",
          },
        }).close(),
    ).rejects.toThrow(
      "Missing username, please, specify the 'keyId' property of the 'auth' config option. " +
        "For example: new Sender({protocol: 'tcp', host: 'host', auth: {keyId: 'username', token: 'private key'}})",
    );
  });

  it("requires that the username is a string", async function () {
    await expect(
      async () =>
        await new Sender({
          protocol: "tcp",
          host: "host",
          auth: {
            // @ts-expect-error - Testing invalid options
            keyId: 23,
            token: "privateKey",
          },
        }).close(),
    ).rejects.toThrow(
      "Please, specify the 'keyId' property of the 'auth' config option as a string. " +
        "For example: new Sender({protocol: 'tcp', host: 'host', auth: {keyId: 'username', token: 'private key'}})",
    );
  });

  it("requires a private key for authentication", async function () {
    await expect(
      async () =>
        await new Sender({
          protocol: "tcp",
          host: "host",
          auth: {
            keyId: "username",
          },
        }).close(),
    ).rejects.toThrow(
      "Missing private key, please, specify the 'token' property of the 'auth' config option. " +
        "For example: new Sender({protocol: 'tcp', host: 'host', auth: {keyId: 'username', token: 'private key'}})",
    );
  });

  it("requires a non-empty private key", async function () {
    await expect(
      async () =>
        await new Sender({
          protocol: "tcp",
          host: "host",
          auth: {
            keyId: "username",
            token: "",
          },
        }).close(),
    ).rejects.toThrow(
      "Missing private key, please, specify the 'token' property of the 'auth' config option. " +
        "For example: new Sender({protocol: 'tcp', host: 'host', auth: {keyId: 'username', token: 'private key'}})",
    );
  });

  it("requires that the private key is a string", async function () {
    await expect(
      async () =>
        await new Sender({
          protocol: "tcp",
          host: "host",
          auth: {
            keyId: "username",
            // @ts-expect-error - Testing invalid options
            token: true,
          },
        }).close(),
    ).rejects.toThrow(
      "Please, specify the 'token' property of the 'auth' config option as a string. " +
        "For example: new Sender({protocol: 'tcp', host: 'host', auth: {keyId: 'username', token: 'private key'}})",
    );
  });
});

function bufferSize(sender: Sender) {
  // @ts-expect-error - Accessing private field
  return sender.buffer.bufferSize;
}

function maxBufferSize(sender: Sender) {
  // @ts-expect-error - Accessing private field
  return sender.buffer.maxBufferSize;
}

function logger(sender: Sender) {
  // @ts-expect-error - Accessing private field
  return sender.log;
}
