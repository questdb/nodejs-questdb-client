import { PathOrFileDescriptor } from "fs";
import { Agent } from "undici";
import http from "http";
import https from "https";

import { Logger } from "./logging";
import { fetchJson } from "./utils";

const HTTP_PORT = 9000;
const TCP_PORT = 9009;

const HTTP = "http";
const HTTPS = "https";
const TCP = "tcp";
const TCPS = "tcps";

const ON = "on";
const OFF = "off";
const UNSAFE_OFF = "unsafe_off";

const PROTOCOL_VERSION_AUTO = "auto";
const PROTOCOL_VERSION_V1 = "1";
const PROTOCOL_VERSION_V2 = "2";

const LINE_PROTO_SUPPORT_VERSION = "line.proto.support.versions";

type ExtraOptions = {
  log?: Logger;
  agent?: Agent | http.Agent | https.Agent;
};

type DeprecatedOptions = {
  /** @deprecated */
  copy_buffer?: boolean;
  /** @deprecated */
  copyBuffer?: boolean;
  /** @deprecated */
  bufferSize?: number;
};

/** @classdesc
 * <a href="Sender.html">Sender</a> configuration options. <br>
 * <br>
 * Properties of the object are initialized through a configuration string. <br>
 * The configuration string has the following format: <i>&ltprotocol&gt::&ltkey&gt=&ltvalue&gt;&ltkey&gt=&ltvalue&gt;...;</i> <br>
 * The keys are case-sensitive, the trailing semicolon is optional. <br>
 * The values are validated, and an error is thrown if the format is invalid. <br>
 * <br>
 * Connection and protocol options
 * <ul>
 * <li> <b>protocol</b>: <i>enum, accepted values: http, https, tcp, tcps</i> - The protocol used to communicate with the server. <br>
 * When <i>https</i> or <i>tcps</i> used, the connection is secured with TLS encryption.
 * </li>
 * <li> <b>protocol_version</b>: <i>enum, accepted values: auto, 1, 2</i> - The protocol version used for data serialization. <br>
 * Version 1 uses text-based serialization for all data types. Version 2 uses binary encoding for doubles. <br>
 * When set to 'auto' (default for HTTP/HTTPS), the client automatically negotiates the highest supported version with the server. <br>
 * TCP/TCPS connections default to version 1.
 * </li>
 * <li> addr: <i>string</i> - Hostname and port, separated by colon. This key is mandatory, but the port part is optional. <br>
 * If no port is specified, a default will be used. <br>
 * When the protocol is HTTP/HTTPS, the port defaults to 9000. When the protocol is TCP/TCPS, the port defaults to 9009. <br>
 * <br>
 * Examples: <i>http::addr=localhost:9000</i>, <i>https::addr=localhost:9000</i>, <i>http::addr=localhost</i>, <i>tcp::addr=localhost:9009</i>
 * </li>
 * </ul>
 * <br>
 * Authentication options
 * <ul>
 * <li> username: <i>string</i> - Used for authentication. <br>
 * For HTTP, Basic Authentication requires the <i>password</i> option. <br>
 * For TCP with JWK token authentication, <i>token</i> option is required.
 * </li>
 * <li> password: <i>string</i> - Password for HTTP Basic authentication, should be accompanied by the <i>username</i> option.
 * </li>
 * <li> token: <i>string</i> - For HTTP with Bearer authentication, this is the bearer token. <br>
 * For TCP with JWK token authentication, this is the private key part of the JWK token,
 * and must be accompanied by the <i>username</i> option.
 * </li>
 * </ul>
 * <br>
 * TLS options
 * <ul>
 * <li> tls_verify: <i>enum, accepted values: on, unsafe_off</i> - When the HTTPS or TCPS protocols are selected, TLS encryption is used. <br>
 * By default, the Sender will verify the server's certificate, but this check can be disabled by setting this option to <i>off</i>. This is useful
 * non-production environments where self-signed certificates might be used, but should be avoided in production if possible.
 * </li>
 * <li> tls_ca: <i>string</i> - Path to a file containing the root CA's certificate in PEM format. <br>
 * Can be useful when self-signed certificates are used, otherwise should not be set.
 * </li>
 * </ul>
 * <br>
 * Auto flush options
 * <ul>
 * <li> auto_flush: <i>enum, accepted values: on, off</i> - The Sender automatically flushes the buffer by default. This can be switched off
 * by setting this option to <i>off</i>. <br>
 * When disabled, the flush() method of the Sender has to be called explicitly to make sure data is sent to the server. <br>
 * Manual buffer flushing can be useful, especially when we want to use transactions. When the HTTP protocol is used, each flush results in a single HTTP
 * request, which becomes a single transaction on the server side. The transaction either succeeds, and all rows sent in the request are
 * inserted; or it fails, and none of the rows make it into the database.
 * </li>
 * <li> auto_flush_rows: <i>integer</i> - The number of rows that will trigger a flush. When set to 0, row-based flushing is disabled. <br>
 * The Sender will default this parameter to 75000 rows when HTTP protocol is used, and to 600 in case of TCP protocol.
 * </li>
 * <li> auto_flush_interval: <i>integer</i> - The number of milliseconds that will trigger a flush, default value is 1000.
 * When set to 0, interval-based flushing is disabled. <br>
 * Note that the setting is checked only when a new row is added to the buffer. There is no timer registered to flush the buffer automatically.
 * </li>
 * </ul>
 * <br>
 * Buffer sizing options
 * <ul>
 * <li> init_buf_size: <i>integer</i> - Initial buffer size, defaults to 64 KiB in the Sender.
 * </li>
 * <li> max_buf_size: <i>integer</i> - Maximum buffer size, defaults to 100 MiB in the Sender. <br>
 * If the buffer would need to be extended beyond the maximum size, an error is thrown.
 * </li>
 * </ul>
 * <br>
 * HTTP request specific options
 * <ul>
 * <li> request_timeout: <i>integer</i> - The time in milliseconds to wait for a response from the server, set to 10 seconds by default. <br>
 * This is in addition to the calculation derived from the <i>request_min_throughput</i> parameter.
 * </li>
 * <li> request_min_throughput: <i>integer</i> - Minimum expected throughput in bytes per second for HTTP requests, set to 100 KiB/s seconds by default. <br>
 * If the throughput is lower than this value, the connection will time out. This is used to calculate an additional
 * timeout on top of <i>request_timeout</i>. This is useful for large requests. You can set this value to 0 to disable this logic.
 * </li>
 * <li> retry_timeout: <i>integer</i> - The time in milliseconds to continue retrying after a failed HTTP request, set to 10 seconds by default. <br>
 * The interval between retries is an exponential backoff starting at 10ms and doubling after each failed attempt up to a maximum of 1 second.
 * </li>
 * </ul>
 * <br>
 * Other options
 * <ul>
 * <li> stdlib_http: <i>enum, accepted values: on, off</i> - With HTTP protocol the Undici library is used by default. By setting this option
 * to <i>on</i> the client switches to node's core http and https modules.
 * </li>
 * <li> max_name_len: <i>integer</i> - The maximum length of a table or column name, the Sender defaults this parameter to 127. <br>
 * Recommended to use the same setting as the server, which also uses 127 by default.
 * </li>
 * </ul>
 */
class SenderOptions {
  protocol: string;
  protocol_version?: string;

  addr?: string;
  host?: string; // derived from addr
  port?: number; // derived from addr

  // replaces `auth` and `jwk` options
  username?: string;
  password?: string;
  token?: string;
  token_x?: string; // allowed, but ignored
  token_y?: string; // allowed, but ignored

  auto_flush?: boolean;
  auto_flush_rows?: number;
  auto_flush_interval?: number;

  request_min_throughput?: number;
  request_timeout?: number;
  retry_timeout?: number;

  // replaces `bufferSize` option
  init_buf_size?: number | null;
  max_buf_size?: number | null;

  tls_verify?: boolean;
  tls_ca?: PathOrFileDescriptor;
  tls_roots?: never; // not supported
  tls_roots_password?: never; // not supported

  max_name_len?: number;

  log?: Logger;
  agent?: Agent | http.Agent | https.Agent;

  stdlib_http?: boolean;

  auth?: {
    username?: string;
    keyId?: string;
    password?: string;
    token?: string;
  };
  jwk?: Record<string, string>;

  /**
   * Creates a Sender options object by parsing the provided configuration string.
   *
   * @param {string} configurationString - Configuration string. <br>
   * @param {object} extraOptions - Optional extra configuration. <br>
   * - 'log' is a logging function used by the <a href="Sender.html">Sender</a>. <br>
   * Prototype: <i>(level: 'error'|'warn'|'info'|'debug', message: string) => void</i>. <br>
   * - 'agent' is a custom http/https agent used by the <a href="Sender.html">Sender</a> when http/https transport is used. <br>
   * A <i>http.Agent</i> or <i>https.Agent</i> object is expected.
   */
  constructor(configurationString: string, extraOptions?: ExtraOptions) {
    parseConfigurationString(this, configurationString);

    if (extraOptions) {
      if (extraOptions.log && typeof extraOptions.log !== "function") {
        throw new Error("Invalid logging function");
      }
      this.log = extraOptions.log;

      if (
        extraOptions.agent &&
        !(extraOptions.agent instanceof Agent) &&
        !(extraOptions.agent instanceof http.Agent) &&
        // @ts-expect-error - Not clear what the problem is, the two lines above have no issues
        !(extraOptions.agent instanceof https.Agent)
      ) {
        throw new Error("Invalid HTTP agent");
      }
      this.agent = extraOptions.agent;
    }
  }

  /**
   * Resolves the protocol version, if it is set to 'auto'. <br>
   * If TCP transport is used, the protocol version will default to 1.
   * In case of HTTP transport the /settings endpoint of the database is used to find the protocol versions
   * supported by the server, and the highest will be selected.
   * @param options SenderOptions instance needs resolving protocol version
   */
  static async resolveAuto(options: SenderOptions) {
    parseProtocolVersion(options);
    if (options.protocol_version !== PROTOCOL_VERSION_AUTO) {
      return options;
    }

    const url = `${options.protocol}://${options.host}:${options.port}/settings`;
    const settings: {
      config: { LINE_PROTO_SUPPORT_VERSION: number[] };
    } = await fetchJson(url);
    const supportedVersions: string[] = (
      settings.config[LINE_PROTO_SUPPORT_VERSION] ?? []
    ).map((version: unknown) => String(version));

    if (supportedVersions.length === 0) {
      options.protocol_version = PROTOCOL_VERSION_V1;
    } else if (supportedVersions.includes(PROTOCOL_VERSION_V2)) {
      options.protocol_version = PROTOCOL_VERSION_V2;
    } else if (supportedVersions.includes(PROTOCOL_VERSION_V1)) {
      options.protocol_version = PROTOCOL_VERSION_V1;
    } else {
      throw new Error(
        "Unsupported protocol versions received from server: " +
          supportedVersions,
      );
    }
    return options;
  }

  static resolveDeprecated(
    options: SenderOptions & DeprecatedOptions,
    log: Logger,
  ) {
    if (!options) {
      return;
    }

    // deal with deprecated options
    if (options.copy_buffer !== undefined) {
      log(
        "warn",
        `Option 'copy_buffer' is not supported anymore, please, remove it`,
      );
      options.copy_buffer = undefined;
    }
    if (options.copyBuffer !== undefined) {
      log(
        "warn",
        `Option 'copyBuffer' is not supported anymore, please, remove it`,
      );
      options.copyBuffer = undefined;
    }
    if (options.bufferSize !== undefined) {
      log(
        "warn",
        `Option 'bufferSize' is not supported anymore, please, replace it with 'init_buf_size'`,
      );
      options.init_buf_size = options.bufferSize;
      options.bufferSize = undefined;
    }
  }

  /**
   * Creates a Sender options object by parsing the provided configuration string.
   *
   * @param {string} configurationString - Configuration string. <br>
   * @param {object} extraOptions - Optional extra configuration. <br>
   * - 'log' is a logging function used by the <a href="Sender.html">Sender</a>. <br>
   * Prototype: <i>(level: 'error'|'warn'|'info'|'debug', message: string) => void</i>. <br>
   * - 'agent' is a custom http/https agent used by the <a href="Sender.html">Sender</a> when http/https transport is used. <br>
   * A <i>http.Agent</i> or <i>https.Agent</i> object is expected.
   *
   * @return {SenderOptions} A Sender configuration object initialized from the provided configuration string.
   */
  static async fromConfig(
    configurationString: string,
    extraOptions?: ExtraOptions,
  ): Promise<SenderOptions> {
    const options = new SenderOptions(configurationString, extraOptions);
    await SenderOptions.resolveAuto(options);
    return options;
  }

  /**
   * Creates a Sender options object by parsing the configuration string set in the <b>QDB_CLIENT_CONF</b> environment variable.
   *
   * @param {object} extraOptions - Optional extra configuration. <br>
   * - 'log' is a logging function used by the <a href="Sender.html">Sender</a>. <br>
  }in  /**br>
   * - 'agent' is a custom http/https agent used by the <a href="Sender.html">Sender</a> when http/https transport is used. <br>
   * A <i>http.Agent</i> or <i>https.Agent</i> object is expected.
   *
   * @return {SenderOptions} A Sender configuration object initialized from the <b>QDB_CLIENT_CONF</b> environment variable.
   */
  static async fromEnv(extraOptions?: ExtraOptions): Promise<SenderOptions> {
    return await SenderOptions.fromConfig(
      process.env.QDB_CLIENT_CONF,
      extraOptions,
    );
  }
}

function parseConfigurationString(
  options: SenderOptions,
  configString: string,
) {
  if (!configString) {
    throw new Error("Configuration string is missing or empty");
  }

  const position = parseProtocol(options, configString);
  parseSettings(options, configString, position);
  parseProtocolVersion(options);
  parseAddress(options);
  parseBufferSizes(options);
  parseAutoFlushOptions(options);
  parseTlsOptions(options);
  parseRequestTimeoutOptions(options);
  parseMaxNameLength(options);
  parseStdlibTransport(options);
}

function parseSettings(
  options: SenderOptions,
  configString: string,
  position: number,
) {
  let index = configString.indexOf(";", position);
  while (index > -1) {
    if (
      index + 1 < configString.length &&
      configString.charAt(index + 1) === ";"
    ) {
      index = configString.indexOf(";", index + 2);
      continue;
    }

    parseSetting(options, configString, position, index);

    position = index + 1;
    index = configString.indexOf(";", position);
  }
  if (position < configString.length) {
    parseSetting(options, configString, position, configString.length);
  }
}

function parseSetting(
  options: SenderOptions,
  configString: string,
  position: number,
  index: number,
) {
  const setting = configString.slice(position, index).replaceAll(";;", ";");
  const equalsIndex = setting.indexOf("=");
  if (equalsIndex < 0) {
    throw new Error(`Missing '=' sign in '${setting}'`);
  }
  const key = setting.slice(0, equalsIndex);
  const value = setting.slice(equalsIndex + 1);
  validateConfigKey(key);
  validateConfigValue(key, value);
  options[key] = value;
}

const ValidConfigKeys = [
  "protocol_version",
  "addr",
  "username",
  "password",
  "token",
  "token_x",
  "token_y",
  "auto_flush",
  "auto_flush_rows",
  "auto_flush_interval",
  "request_min_throughput",
  "request_timeout",
  "retry_timeout",
  "init_buf_size",
  "max_buf_size",
  "max_name_len",
  "stdlib_http",
  "tls_verify",
  "tls_ca",
  "tls_roots",
  "tls_roots_password",
];

function validateConfigKey(key: string) {
  if (!ValidConfigKeys.includes(key)) {
    throw new Error(`Unknown configuration key: '${key}'`);
  }
}

function validateConfigValue(key: string, value: string) {
  if (!value) {
    throw new Error(`Invalid configuration, value is not set for '${key}'`);
  }
  for (let i = 0; i < value.length; i++) {
    const unicode = value.codePointAt(i);
    if (unicode < 0x20 || (unicode > 0x7e && unicode < 0xa0)) {
      throw new Error(
        `Invalid configuration, control characters are not allowed: '${value}'`,
      );
    }
  }
}

function parseProtocol(options: SenderOptions, configString: string) {
  const index = configString.indexOf("::");
  if (index < 0) {
    throw new Error(
      "Missing protocol, configuration string format: 'protocol::key1=value1;key2=value2;key3=value3;'",
    );
  }

  options.protocol = configString.slice(0, index) as string;
  switch (options.protocol) {
    case HTTP:
    case HTTPS:
    case TCP:
    case TCPS:
      break;
    default:
      throw new Error(
        `Invalid protocol: '${options.protocol}', accepted protocols: 'http', 'https', 'tcp', 'tcps'`,
      );
  }
  return index + 2;
}

function parseProtocolVersion(options: SenderOptions) {
  const protocol_version = options.protocol_version ?? PROTOCOL_VERSION_AUTO;
  switch (protocol_version) {
    case PROTOCOL_VERSION_AUTO:
      switch (options.protocol) {
        case HTTP:
        case HTTPS:
          options.protocol_version = PROTOCOL_VERSION_AUTO;
          break;
        default:
          options.protocol_version = PROTOCOL_VERSION_V1;
      }
      break;
    case PROTOCOL_VERSION_V1:
    case PROTOCOL_VERSION_V2:
      break;
    default:
      throw new Error(
        `Invalid protocol version: '${protocol_version}', accepted values: 'auto', '1', '2'`,
      );
  }
  return;
}

function parseAddress(options: SenderOptions) {
  if (!options.addr) {
    throw new Error("Invalid configuration, 'addr' is required");
  }

  const index = options.addr.indexOf(":");
  if (index < 0) {
    options.host = options.addr;
    switch (options.protocol) {
      case HTTP:
      case HTTPS:
        options.port = HTTP_PORT;
        return;
      case TCP:
      case TCPS:
        options.port = TCP_PORT;
        return;
      default:
        throw new Error(
          `Invalid protocol: '${options.protocol}', accepted protocols: 'http', 'https', 'tcp', 'tcps'`,
        );
    }
  }

  options.host = options.addr.slice(0, index);
  if (!options.host) {
    throw new Error(`Host name is required`);
  }

  const portStr = options.addr.slice(index + 1);
  if (!portStr) {
    throw new Error(`Port is required`);
  }
  options.port = Number(portStr);
  if (isNaN(options.port)) {
    throw new Error(`Invalid port: '${portStr}'`);
  }
  if (!Number.isInteger(options.port) || options.port < 1) {
    throw new Error(`Invalid port: ${options.port}`);
  }
}

function parseBufferSizes(options: SenderOptions) {
  parseInteger(options, "init_buf_size", "initial buffer size", 1);
  parseInteger(options, "max_buf_size", "max buffer size", 1);
}

function parseAutoFlushOptions(options: SenderOptions) {
  parseBoolean(options, "auto_flush", "auto flush");
  parseInteger(options, "auto_flush_rows", "auto flush rows", 0);
  parseInteger(options, "auto_flush_interval", "auto flush interval", 0);
}

function parseTlsOptions(options: SenderOptions) {
  parseBoolean(options, "tls_verify", "TLS verify", UNSAFE_OFF);

  if (options.tls_roots || options.tls_roots_password) {
    throw new Error(
      "'tls_roots' and 'tls_roots_password' options are not supported, please, " +
        "use the 'tls_ca' option or the NODE_EXTRA_CA_CERTS environment variable instead",
    );
  }
}

function parseRequestTimeoutOptions(options: SenderOptions) {
  parseInteger(options, "request_min_throughput", "request min throughput", 1);
  parseInteger(options, "request_timeout", "request timeout", 1);
  parseInteger(options, "retry_timeout", "retry timeout", 0);
}

function parseMaxNameLength(options: SenderOptions) {
  parseInteger(options, "max_name_len", "max name length", 1);
}

function parseStdlibTransport(options: SenderOptions) {
  parseBoolean(options, "stdlib_http", "stdlib http");
}

function parseBoolean(
  options: SenderOptions,
  property: string,
  description: string,
  offValue = OFF,
) {
  if (options[property]) {
    const property_str = options[property];
    switch (property_str) {
      case ON:
        options[property] = true;
        break;
      case offValue:
        options[property] = false;
        break;
      default:
        throw new Error(`Invalid ${description} option: '${property_str}'`);
    }
  }
}

function parseInteger(
  options: SenderOptions,
  property: string,
  description: string,
  lowerBound: number,
) {
  if (options[property]) {
    const property_str = options[property];
    options[property] = Number(property_str);
    if (isNaN(options[property])) {
      throw new Error(
        `Invalid ${description} option, not a number: '${property_str}'`,
      );
    }
    if (
      !Number.isInteger(options[property]) ||
      options[property] < lowerBound
    ) {
      throw new Error(`Invalid ${description} option: ${options[property]}`);
    }
  }
}

export {
  SenderOptions,
  ExtraOptions,
  HTTP,
  HTTPS,
  TCP,
  TCPS,
  PROTOCOL_VERSION_AUTO,
  PROTOCOL_VERSION_V1,
  PROTOCOL_VERSION_V2,
};
