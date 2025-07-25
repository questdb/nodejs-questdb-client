// @ts-check
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import { Agent, RetryAgent } from "undici";

import { log } from "./logging";
import { validateColumnName, validateTableName } from "./validation";
import { SenderOptions, HTTP, HTTPS, TCP, TCPS } from "./options";

const HTTP_NO_CONTENT = 204; // success

const DEFAULT_HTTP_AUTO_FLUSH_ROWS = 75000;
const DEFAULT_TCP_AUTO_FLUSH_ROWS = 600;
const DEFAULT_AUTO_FLUSH_INTERVAL = 1000; // 1 sec

const DEFAULT_MAX_NAME_LENGTH = 127;

const DEFAULT_REQUEST_MIN_THROUGHPUT = 102400; // 100 KB/sec
const DEFAULT_REQUEST_TIMEOUT = 10000; // 10 sec
const DEFAULT_RETRY_TIMEOUT = 10000; // 10 sec

const DEFAULT_BUFFER_SIZE = 65536; //  64 KB
const DEFAULT_MAX_BUFFER_SIZE = 104857600; // 100 MB

/** @type {Agent.Options} */
const DEFAULT_HTTP_OPTIONS: Agent.Options = {
  connect: {
    keepAlive: true,
  },
  pipelining: 1,
  keepAliveTimeout: 60000, // 1 minute
};
// an arbitrary public key, not used in authentication
// only used to construct a valid JWK token which is accepted by the crypto API
const PUBLIC_KEY = {
  x: "aultdA0PjhD_cWViqKKyL5chm6H1n-BiZBo_48T-uqc",
  y: "__ptaol41JWSpTTL525yVEfzmY8A6Vi_QrW1FjKcHMg",
};

/*
We are retrying on the following response codes (copied from the Rust client):
500:  Internal Server Error
503:  Service Unavailable
504:  Gateway Timeout

// Unofficial extensions
507:  Insufficient Storage
509:  Bandwidth Limit Exceeded
523:  Origin is Unreachable
524:  A Timeout Occurred
529:  Site is overloaded
599:  Network Connect Timeout Error
*/
const RETRIABLE_STATUS_CODES = [500, 503, 504, 507, 509, 523, 524, 529, 599];

/** @classdesc
 * The QuestDB client's API provides methods to connect to the database, ingest data, and close the connection.
 * The supported protocols are HTTP and TCP. HTTP is preferred as it provides feedback in the HTTP response. <br>
 * Based on benchmarks HTTP also provides higher throughput, if configured to ingest data in bigger batches.
 * <p>
 * The client supports authentication. <br>
 * Authentication details can be passed to the Sender in its configuration options. <br>
 * The client supports Basic username/password and Bearer token authentication methods when used with HTTP protocol,
 * and JWK token authentication when ingesting data via TCP. <br>
 * Please, note that authentication is enabled by default in QuestDB Enterprise only. <br>
 * Details on how to configure authentication in the open source version of
 * QuestDB: {@link https://questdb.io/docs/reference/api/ilp/authenticate}
 * </p>
 * <p>
 * The client also supports TLS encryption for both, HTTP and TCP transports to provide a secure connection. <br>
 * Please, note that the open source version of QuestDB does not support TLS, and requires an external reverse-proxy,
 * such as Nginx to enable encryption.
 * </p>
 * <p>
 * The client uses a buffer to store data. It automatically flushes the buffer by sending its content to the server.
 * Auto flushing can be disabled via configuration options to gain control over transactions. Initial and maximum
 * buffer sizes can also be set.
 * </p>
 * <p>
 * It is recommended that the Sender is created by using one of the static factory methods,
 * <i>Sender.fromConfig(configString, extraOptions)</i> or <i>Sender.fromEnv(extraOptions)</i>.
 * If the Sender is created via its constructor, at least the SenderOptions configuration object should be
 * initialized from a configuration string to make sure that the parameters are validated. <br>
 * Detailed description of the Sender's configuration options can be found in
 * the <a href="SenderOptions.html">SenderOptions</a> documentation.
 * </p>
 * <p>
 * Extra options can be provided to the Sender in the <i>extraOptions</i> configuration object. <br>
 * A custom logging function and a custom HTTP(S) agent can be passed to the Sender in this object. <br>
 * The logger implementation provides the option to direct log messages to the same place where the host application's
 * log is saved. The default logger writes to the console. <br>
 * The custom HTTP(S) agent option becomes handy if there is a need to modify the default options set for the
 * HTTP(S) connections. A popular setting would be disabling persistent connections, in this case an agent can be
 * passed to the Sender with <i>keepAlive</i> set to <i>false</i>. <br>
 * For example: <i>Sender.fromConfig(`http::addr=host:port`, { agent: new undici.Agent({ connect: { keepAlive: false } })})</i> <br>
 * If no custom agent is configured, the Sender will use its own agent which overrides some default values
 * of <i>undici.Agent</i>. The Sender's own agent uses persistent connections with 1 minute idle timeout, pipelines requests default to 1.
 * </p>
 */
class Sender {
  /** @private */ static DEFAULT_HTTP_AGENT;
  /** @private */ static DEFAULT_HTTPS_AGENT;

  /** @private */ http; // true if the protocol is HTTP/HTTPS, false if it is TCP/TCPS
  /** @private */ secure; // true if the protocol is HTTPS or TCPS, false otherwise
  /** @private */ host;
  /** @private */ port;

  /** @private */ socket;

  /** @private */ username;
  /** @private */ password;
  /** @private */ token;

  /** @private */ tlsVerify;
  /** @private */ tlsCA;

  /** @private */ bufferSize;
  /** @private */ maxBufferSize;
  /** @private */ buffer;
  /** @private */ position;
  /** @private */ endOfLastRow;

  /** @private */ autoFlush;
  /** @private */ autoFlushRows;
  /** @private */ autoFlushInterval;
  /** @private */ lastFlushTime;
  /** @private */ pendingRowCount;

  /** @private */ requestMinThroughput;
  /** @private */ requestTimeout;
  /** @private */ retryTimeout;

  /** @private */ hasTable;
  /** @private */ hasSymbols;
  /** @private */ hasColumns;

  /** @private */ maxNameLength;

  /** @private */ log;
  /** @private */ agent;
  /** @private */ jwk;

  /**
   * Creates an instance of Sender.
   *
   * @param {SenderOptions} options - Sender configuration object. <br>
   * See SenderOptions documentation for detailed description of configuration options. <br>
   */
  constructor(options: SenderOptions) {
    if (!options || !options.protocol) {
      throw new Error("The 'protocol' option is mandatory");
    }
    this.log = typeof options.log === "function" ? options.log : log;
    replaceDeprecatedOptions(options, this.log);

    switch (options.protocol) {
      case HTTP:
        this.http = true;
        this.secure = false;
        this.agent =
          options.agent instanceof Agent
            ? options.agent
            : Sender.getDefaultHttpAgent();
        break;
      case HTTPS:
        this.http = true;
        this.secure = true;
        if (options.agent instanceof Agent) {
          this.agent = options.agent;
        } else {
          // Create a new agent with instance-specific TLS options
          this.agent = new Agent({
            ...DEFAULT_HTTP_OPTIONS,
            connect: {
              ...DEFAULT_HTTP_OPTIONS.connect,
              requestCert: isBoolean(options.tls_verify) ? options.tls_verify : true,
              rejectUnauthorized: isBoolean(options.tls_verify) ? options.tls_verify : true,
              ca: options.tls_ca ? readFileSync(options.tls_ca) : undefined,
            },
          });
        }
        break;
      case TCP:
        this.http = false;
        this.secure = false;
        break;
      case TCPS:
        this.http = false;
        this.secure = true;
        break;
      default:
        throw new Error(`Invalid protocol: '${options.protocol}'`);
    }

    if (this.http) {
      this.username = options.username;
      this.password = options.password;
      this.token = options.token;
      if (!options.port) {
        options.port = 9000;
      }
    } else {
      if (!options.auth && !options.jwk) {
        constructAuth(options);
      }
      this.jwk = constructJwk(options);
      if (!options.port) {
        options.port = 9009;
      }
    }

    this.host = options.host;
    this.port = options.port;

    this.tlsVerify = isBoolean(options.tls_verify) ? options.tls_verify : true;
    this.tlsCA = options.tls_ca ? readFileSync(options.tls_ca) : undefined;

    this.autoFlush = isBoolean(options.auto_flush) ? options.auto_flush : true;
    this.autoFlushRows = isInteger(options.auto_flush_rows, 0)
      ? options.auto_flush_rows
      : this.http
        ? DEFAULT_HTTP_AUTO_FLUSH_ROWS
        : DEFAULT_TCP_AUTO_FLUSH_ROWS;
    this.autoFlushInterval = isInteger(options.auto_flush_interval, 0)
      ? options.auto_flush_interval
      : DEFAULT_AUTO_FLUSH_INTERVAL;

    this.maxNameLength = isInteger(options.max_name_len, 1)
      ? options.max_name_len
      : DEFAULT_MAX_NAME_LENGTH;

    this.requestMinThroughput = isInteger(options.request_min_throughput, 0)
      ? options.request_min_throughput
      : DEFAULT_REQUEST_MIN_THROUGHPUT;
    this.requestTimeout = isInteger(options.request_timeout, 1)
      ? options.request_timeout
      : DEFAULT_REQUEST_TIMEOUT;
    this.retryTimeout = isInteger(options.retry_timeout, 0)
      ? options.retry_timeout
      : DEFAULT_RETRY_TIMEOUT;

    this.maxBufferSize = isInteger(options.max_buf_size, 1)
      ? options.max_buf_size
      : DEFAULT_MAX_BUFFER_SIZE;
    this.resize(
      isInteger(options.init_buf_size, 1)
        ? options.init_buf_size
        : DEFAULT_BUFFER_SIZE,
    );
    this.reset();
  }

  /**
   * Creates a Sender options object by parsing the provided configuration string.
   *
   * @param {string} configurationString - Configuration string. <br>
   * @param {object} extraOptions - Optional extra configuration. <br>
   * - 'log' is a logging function used by the <a href="Sender.html">Sender</a>. <br>
   * Prototype: <i>(level: 'error'|'warn'|'info'|'debug', message: string) => void</i>. <br>
   * - 'agent' is a custom Undici agent used by the <a href="Sender.html">Sender</a> when http/https transport is used. <br>
   * A <i>undici.Agent</i>  object is expected.
   *
   * @return {Sender} A Sender object initialized from the provided configuration string.
   */
  static fromConfig(
    configurationString: string,
    extraOptions: object = undefined,
  ): Sender {
    return new Sender(
      SenderOptions.fromConfig(configurationString, extraOptions),
    );
  }

  /**
   * Creates a Sender options object by parsing the configuration string set in the <b>QDB_CLIENT_CONF</b> environment variable.
   *
   * @param {object} extraOptions - Optional extra configuration. <br>
   * - 'log' is a logging function used by the <a href="Sender.html">Sender</a>. <br>
   * Prototype: <i>(level: 'error'|'warn'|'info'|'debug', message: string) => void</i>. <br>
   * - 'agent' is a custom Undici agent used by the <a href="Sender.html">Sender</a> when http/https transport is used. <br>
   * A <i>undici.Agent</i>  object is expected.
   *
   * @return {Sender} A Sender object initialized from the <b>QDB_CLIENT_CONF</b> environment variable.
   */
  static fromEnv(extraOptions: object = undefined): Sender {
    return new Sender(
      SenderOptions.fromConfig(process.env.QDB_CLIENT_CONF, extraOptions),
    );
  }

  /**
   * Extends the size of the sender's buffer. <br>
   * Can be used to increase the size of buffer if overflown.
   * The buffer's content is copied into the new buffer.
   *
   * @param {number} bufferSize - New size of the buffer used by the sender, provided in bytes.
   */
  resize(bufferSize: number) {
    if (bufferSize > this.maxBufferSize) {
      throw new Error(
        `Max buffer size is ${this.maxBufferSize} bytes, requested buffer size: ${bufferSize}`,
      );
    }
    this.bufferSize = bufferSize;
    // Allocating an extra byte because Buffer.write() does not fail if the length of the data to be written is
    // longer than the size of the buffer. It simply just writes whatever it can, and returns.
    // If we can write into the extra byte, that indicates buffer overflow.
    // See the check in our write() function.
    const newBuffer = Buffer.alloc(this.bufferSize + 1, 0, "utf8");
    if (this.buffer) {
      this.buffer.copy(newBuffer);
    }
    this.buffer = newBuffer;
  }

  /**
   * Resets the buffer, data added to the buffer will be lost. <br>
   * In other words it clears the buffer and sets the writing position to the beginning of the buffer.
   *
   * @return {Sender} Returns with a reference to this sender.
   */
  reset(): Sender {
    this.position = 0;
    this.lastFlushTime = Date.now();
    this.pendingRowCount = 0;
    startNewRow(this);
    return this;
  }

  /**
   * Creates a TCP connection to the database.
   *
   * @param {net.NetConnectOpts | tls.ConnectionOptions} connectOptions - Connection options, host and port are required.
   *
   * @return {Promise<boolean>} Resolves to true if the client is connected.
   */
  connect(
    connectOptions: net.NetConnectOpts | tls.ConnectionOptions = undefined,
  ): Promise<boolean> {
    if (this.http) {
      throw new Error(
        "'connect()' should be called only if the sender connects via TCP",
      );
    }

    if (!connectOptions) {
      connectOptions = {
        host: this.host,
        port: this.port,
        ca: this.tlsCA,
      };
    }
    if (!(connectOptions as tls.ConnectionOptions).host) {
      throw new Error("Hostname is not set");
    }
    if (!(connectOptions as tls.ConnectionOptions).port) {
      throw new Error("Port is not set");
    }

    return new Promise((resolve, reject) => {
      if (this.socket) {
        throw new Error("Sender connected already");
      }

      let authenticated: boolean = false;
      let data;

      this.socket = !this.secure
        ? net.connect(connectOptions as net.NetConnectOpts)
        : tls.connect(connectOptions, () => {
          if (authenticated) {
            resolve(true);
          }
        });
      this.socket.setKeepAlive(true);

      this.socket
        .on("data", async (raw) => {
          data = !data ? raw : Buffer.concat([data, raw]);
          if (!authenticated) {
            authenticated = await authenticate(this, data);
            if (authenticated) {
              resolve(true);
            }
          } else {
            this.log("warn", `Received unexpected data: ${data}`);
          }
        })
        .on("ready", async () => {
          this.log(
            "info",
            `Successfully connected to ${(connectOptions as tls.ConnectionOptions).host}:${(connectOptions as tls.ConnectionOptions).port}`,
          );
          if (this.jwk) {
            this.log(
              "info",
              `Authenticating with ${(connectOptions as tls.ConnectionOptions).host}:${(connectOptions as tls.ConnectionOptions).port}`,
            );
            await this.socket.write(`${this.jwk.kid}\n`, (err: Error) => {
              if (err) {
                reject(err);
              }
            });
          } else {
            authenticated = true;
            if (!this.secure || !this.tlsVerify) {
              resolve(true);
            }
          }
        })
        .on("error", (err) => {
          this.log("error", err);
          if (err.code !== "SELF_SIGNED_CERT_IN_CHAIN" || this.tlsVerify) {
            reject(err);
          }
        });
    });
  }

  /**
   * @ignore
   * @return {Agent} Returns the default http agent.
   */
  static getDefaultHttpAgent(): Agent {
    if (!Sender.DEFAULT_HTTP_AGENT) {
      Sender.DEFAULT_HTTP_AGENT = new Agent(DEFAULT_HTTP_OPTIONS);
    }
    return Sender.DEFAULT_HTTP_AGENT;
  }

  /**
   * Sends the buffer's content to the database and compacts the buffer.
   * If the last row is not finished it stays in the sender's buffer.
   *
   * @return {Promise<boolean>} Resolves to true when there was data in the buffer to send, and it was sent successfully.
   */
  async flush(): Promise<boolean> {
    const dataToSend = this.toBufferNew(this.endOfLastRow);
    if (!dataToSend) {
      return false; // Nothing to send
    }

    try {
      if (this.http) {
        const { timeout: calculatedTimeoutMillis } = createRequestOptions(this, dataToSend);
        const retryBegin = Date.now();
        const headers: Record<string, string> = {};

        const dispatcher = new RetryAgent(this.agent, {
          maxRetries: Infinity,
          minTimeout: 10,
          maxTimeout: 1000,
          timeoutFactor: 2,
          retryAfter: true,
          methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
          statusCodes: RETRIABLE_STATUS_CODES,
          errorCodes: [
            "ECONNRESET",
            "EAI_AGAIN",
            "ECONNREFUSED",
            "ETIMEDOUT",
            "EPIPE",
            "UND_ERR_CONNECT_TIMEOUT",
            "UND_ERR_HEADERS_TIMEOUT",
            "UND_ERR_BODY_TIMEOUT",
          ],
          retry: (err, context, callback) => {
            const elapsed = Date.now() - retryBegin;
            if (elapsed > this.retryTimeout) {
              return callback(err);
            }
            return callback(null);
          },
        });

        if (this.token) {
          headers["Authorization"] = "Bearer " + this.token;
        } else if (this.username && this.password) {
          headers["Authorization"] =
            "Basic " +
            Buffer.from(this.username + ":" + this.password).toString("base64");
        }

        const { statusCode, body } = await dispatcher.request({
          origin: `${this.secure ? "https" : "http"}://${this.host}:${this.port}`,
          path: "/write?precision=n",
          method: "POST",
          headers,
          body: dataToSend,
          headersTimeout: this.requestTimeout,
          bodyTimeout: calculatedTimeoutMillis,
        });

        const responseBody = await body.arrayBuffer();
        if (statusCode === HTTP_NO_CONTENT) {
          if (responseBody.byteLength > 0) {
            this.log(
              "warn",
              `Unexpected message from server: ${Buffer.from(responseBody).toString()}`,
            );
          }
          return true;
        } else {
          throw new Error(
            `HTTP request failed, statusCode=${statusCode}, error=${Buffer.from(responseBody).toString()}`,
          );
        }
      } else { // TCP
        if (!this.socket || this.socket.destroyed) {
          throw new Error("Sender is not connected");
        }
        return new Promise((resolve, reject) => {
          this.socket.write(dataToSend, (err: Error) => { // Use the copied dataToSend
            if (err) {
              reject(err);
            } else {
              resolve(true);
            }
          });
        });
      }
    } catch (err) {
      // Log the error and then throw a new, standardized error
      if (this.http && err.code === "UND_ERR_HEADERS_TIMEOUT") {
        this.log("error", `HTTP request timeout, no response from server in time. Original error: ${err.message}`);
        throw new Error(`HTTP request timeout, statusCode=${err.statusCode}, error=${err.message}`);
      } else if (this.http) {
        this.log("error", `HTTP request failed, statusCode=${err.statusCode || 'unknown'}, error=${err.message}`);
        throw new Error(`HTTP request failed, statusCode=${err.statusCode || 'unknown'}, error=${err.message}`);
      } else { // TCP
        this.log("error", `TCP send failed: ${err.message}`);
        throw new Error(`TCP send failed, error=${err.message}`);
      }
    }
  }

  /**
   * Closes the TCP connection to the database. <br>
   * Data sitting in the Sender's buffer will be lost unless flush() is called before close().
   */
  async close() {
    if (this.socket) {
      const address = this.socket.remoteAddress;
      const port = this.socket.remotePort;
      this.socket.destroy();
      this.socket = null;
      this.log("info", `Connection to ${address}:${port} is closed`);
    }
  }

  /**
   * @ignore
   * @return {Buffer} Returns a cropped buffer, or null if there is nothing to send.
   * The returned buffer is backed by the sender's buffer.
   * Used only in tests.
   */
  toBufferView(pos = this.position): Buffer {
    return pos > 0 ? this.buffer.subarray(0, pos) : null;
  }

  /**
   * @ignore
   * @return {Buffer|null} Returns a cropped buffer ready to send to the server, or null if there is nothing to send.
   * The returned buffer is a copy of the sender's buffer.
   * It also compacts the Sender's buffer.
   */
  toBufferNew(pos = this.position): Buffer | null {
    if (pos > 0) {
      const data = Buffer.allocUnsafe(pos);
      this.buffer.copy(data, 0, 0, pos);
      compact(this);
      return data;
    }
    return null;
  }

  /**
   * Write the table name into the buffer of the sender.
   *
   * @param {string} table - Table name.
   * @return {Sender} Returns with a reference to this sender.
   */
  table(table: string): Sender {
    if (typeof table !== "string") {
      throw new Error(`Table name must be a string, received ${typeof table}`);
    }
    if (this.hasTable) {
      throw new Error("Table name has already been set");
    }
    validateTableName(table, this.maxNameLength);
    checkCapacity(this, [table]);
    writeEscaped(this, table);
    this.hasTable = true;
    return this;
  }

  /**
   * Write a symbol name and value into the buffer of the sender.
   *
   * @param {string} name - Symbol name.
   * @param {any} value - Symbol value, toString() will be called to extract the actual symbol value from the parameter.
   * @return {Sender} Returns with a reference to this sender.
   */
  symbol<T = unknown>(name: string, value: T): Sender {
    if (typeof name !== "string") {
      throw new Error(`Symbol name must be a string, received ${typeof name}`);
    }
    if (!this.hasTable || this.hasColumns) {
      throw new Error(
        "Symbol can be added only after table name is set and before any column added",
      );
    }
    const valueStr = value.toString();
    checkCapacity(this, [name, valueStr], 2 + name.length + valueStr.length);
    write(this, ",");
    validateColumnName(name, this.maxNameLength);
    writeEscaped(this, name);
    write(this, "=");
    writeEscaped(this, valueStr);
    this.hasSymbols = true;
    return this;
  }

  /**
   * Write a string column with its value into the buffer of the sender.
   *
   * @param {string} name - Column name.
   * @param {string} value - Column value, accepts only string values.
   * @return {Sender} Returns with a reference to this sender.
   */
  stringColumn(name: string, value: string): Sender {
    writeColumn(
      this,
      name,
      value,
      () => {
        checkCapacity(this, [value], 2 + value.length);
        write(this, '"');
        writeEscaped(this, value, true);
        write(this, '"');
      },
      "string",
    );
    return this;
  }

  /**
   * Write a boolean column with its value into the buffer of the sender.
   *
   * @param {string} name - Column name.
   * @param {boolean} value - Column value, accepts only boolean values.
   * @return {Sender} Returns with a reference to this sender.
   */
  booleanColumn(name: string, value: boolean): Sender {
    writeColumn(
      this,
      name,
      value,
      () => {
        checkCapacity(this, [], 1);
        write(this, value ? "t" : "f");
      },
      "boolean",
    );
    return this;
  }

  /**
   * Write a float column with its value into the buffer of the sender.
   *
   * @param {string} name - Column name.
   * @param {number} value - Column value, accepts only number values.
   * @return {Sender} Returns with a reference to this sender.
   */
  floatColumn(name: string, value: number): Sender {
    writeColumn(
      this,
      name,
      value,
      () => {
        const valueStr = value.toString();
        checkCapacity(this, [valueStr], valueStr.length);
        write(this, valueStr);
      },
      "number",
    );
    return this;
  }

  /**
   * Write an integer column with its value into the buffer of the sender.
   *
   * @param {string} name - Column name.
   * @param {number} value - Column value, accepts only number values.
   * @return {Sender} Returns with a reference to this sender.
   */
  intColumn(name: string, value: number): Sender {
    if (!Number.isInteger(value)) {
      throw new Error(`Value must be an integer, received ${value}`);
    }
    writeColumn(this, name, value, () => {
      const valueStr = value.toString();
      checkCapacity(this, [valueStr], 1 + valueStr.length);
      write(this, valueStr);
      write(this, "i");
    });
    return this;
  }

  /**
   * Write a timestamp column with its value into the buffer of the sender.
   *
   * @param {string} name - Column name.
   * @param {number | bigint} value - Epoch timestamp, accepts numbers or BigInts.
   * @param {string} [unit=us] - Timestamp unit. Supported values: 'ns' - nanoseconds, 'us' - microseconds, 'ms' - milliseconds. Defaults to 'us'.
   * @return {Sender} Returns with a reference to this sender.
   */
  timestampColumn(
    name: string,
    value: number | bigint,
    unit: "ns" | "us" | "ms" = "us",
  ): Sender {
    if (typeof value !== "bigint" && !Number.isInteger(value)) {
      throw new Error(`Value must be an integer or BigInt, received ${value}`);
    }
    writeColumn(this, name, value, () => {
      const valueMicros = timestampToMicros(BigInt(value), unit);
      const valueStr = valueMicros.toString();
      checkCapacity(this, [valueStr], 1 + valueStr.length);
      write(this, valueStr);
      write(this, "t");
    });
    return this;
  }

  /**
   * Closing the row after writing the designated timestamp into the buffer of the sender.
   *
   * @param {number | bigint} timestamp - Designated epoch timestamp, accepts numbers or BigInts.
   * @param {string} [unit=us] - Timestamp unit. Supported values: 'ns' - nanoseconds, 'us' - microseconds, 'ms' - milliseconds. Defaults to 'us'.
   */
  async at(timestamp: number | bigint, unit: "ns" | "us" | "ms" = "us") {
    if (!this.hasSymbols && !this.hasColumns) {
      throw new Error(
        "The row must have a symbol or column set before it is closed",
      );
    }
    if (typeof timestamp !== "bigint" && !Number.isInteger(timestamp)) {
      throw new Error(
        `Designated timestamp must be an integer or BigInt, received ${timestamp}`,
      );
    }
    const timestampNanos = timestampToNanos(BigInt(timestamp), unit);
    const timestampStr = timestampNanos.toString();
    checkCapacity(this, [], 2 + timestampStr.length);
    write(this, " ");
    write(this, timestampStr);
    write(this, "\n");
    this.pendingRowCount++;
    startNewRow(this);
    await autoFlush(this);
  }

  /**
   * Closing the row without writing designated timestamp into the buffer of the sender. <br>
   * Designated timestamp will be populated by the server on this record.
   */
  async atNow() {
    if (!this.hasSymbols && !this.hasColumns) {
      throw new Error(
        "The row must have a symbol or column set before it is closed",
      );
    }
    checkCapacity(this, [], 1);
    write(this, "\n");
    this.pendingRowCount++;
    startNewRow(this);
    await autoFlush(this);
  }
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isInteger(value: unknown, lowerBound: number): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= lowerBound
  );
}

async function authenticate(
  sender: Sender,
  challenge: Buffer,
): Promise<boolean> {
  // Check for trailing \n which ends the challenge
  if (challenge.subarray(-1).readInt8() === 10) {
    const keyObject = crypto.createPrivateKey({
      key: sender.jwk,
      format: "jwk",
    });
    const signature = crypto.sign(
      "RSA-SHA256",
      challenge.subarray(0, challenge.length - 1),
      keyObject,
    );

    return new Promise((resolve, reject) => {
      sender.socket.write(
        `${Buffer.from(signature).toString("base64")}\n`,
        (err: Error) => {
          if (err) {
            reject(err);
          } else {
            resolve(true);
          }
        },
      );
    });
  }
  return false;
}

function startNewRow(sender: Sender) {
  sender.endOfLastRow = sender.position;
  sender.hasTable = false;
  sender.hasSymbols = false;
  sender.hasColumns = false;
}

type InternalHttpOptions = {
  hostname: string;
  port: number;
  agent: Agent;
  protocol: string;
  path: string;
  method: string;
  timeout: number;
};
function createRequestOptions(
  sender: Sender,
  data: Buffer,
): InternalHttpOptions {
  const timeoutMillis =
    (data.length / sender.requestMinThroughput) * 1000 + sender.requestTimeout;
  return {
    hostname: sender.host,
    port: sender.port,
    agent: sender.agent,
    protocol: sender.secure ? "https" : "http",
    path: "/write?precision=n",
    method: "POST",
    timeout: timeoutMillis,
  };
}

async function autoFlush(sender: Sender) {
  if (
    sender.autoFlush &&
    sender.pendingRowCount > 0 &&
    ((sender.autoFlushRows > 0 &&
      sender.pendingRowCount >= sender.autoFlushRows) ||
      (sender.autoFlushInterval > 0 &&
        Date.now() - sender.lastFlushTime >= sender.autoFlushInterval))
  ) {
    await sender.flush();
  }
}

function checkCapacity(sender: Sender, data: string[], base = 0) {
  let length = base;
  for (const str of data) {
    length += Buffer.byteLength(str, "utf8");
  }
  if (sender.position + length > sender.bufferSize) {
    let newSize = sender.bufferSize;
    do {
      newSize += sender.bufferSize;
    } while (sender.position + length > newSize);
    sender.resize(newSize);
  }
}

function compact(sender: Sender) {
  if (sender.endOfLastRow > 0) {
    sender.buffer.copy(sender.buffer, 0, sender.endOfLastRow, sender.position);
    sender.position = sender.position - sender.endOfLastRow;
    sender.endOfLastRow = 0;

    sender.lastFlushTime = Date.now();
    sender.pendingRowCount = 0;
  }
}

function writeColumn(
  sender: Sender,
  name: string,
  value: unknown,
  writeValue: () => void,
  valueType?: string | null,
) {
  if (typeof name !== "string") {
    throw new Error(`Column name must be a string, received ${typeof name}`);
  }
  if (valueType != null && typeof value !== valueType) {
    throw new Error(
      `Column value must be of type ${valueType}, received ${typeof value}`,
    );
  }
  if (!sender.hasTable) {
    throw new Error("Column can be set only after table name is set");
  }
  checkCapacity(sender, [name], 2 + name.length);
  write(sender, sender.hasColumns ? "," : " ");
  validateColumnName(name, sender.maxNameLength);
  writeEscaped(sender, name);
  write(sender, "=");
  writeValue();
  sender.hasColumns = true;
}

function write(sender: Sender, data: string) {
  sender.position += sender.buffer.write(data, sender.position);
  if (sender.position > sender.bufferSize) {
    throw new Error(
      `Buffer overflow [position=${sender.position}, bufferSize=${sender.bufferSize}]`,
    );
  }
}

function writeEscaped(sender: Sender, data: string, quoted = false) {
  for (const ch of data) {
    if (ch > "\\") {
      write(sender, ch);
      continue;
    }

    switch (ch) {
      case " ":
      case ",":
      case "=":
        if (!quoted) {
          write(sender, "\\");
        }
        write(sender, ch);
        break;
      case "\n":
      case "\r":
        write(sender, "\\");
        write(sender, ch);
        break;
      case '"':
        if (quoted) {
          write(sender, "\\");
        }
        write(sender, ch);
        break;
      case "\\":
        write(sender, "\\\\");
        break;
      default:
        write(sender, ch);
        break;
    }
  }
}

function timestampToMicros(timestamp: bigint, unit: "ns" | "us" | "ms") {
  switch (unit) {
    case "ns":
      return timestamp / 1000n;
    case "us":
      return timestamp;
    case "ms":
      return timestamp * 1000n;
    default:
      throw new Error("Unknown timestamp unit: " + unit);
  }
}

function timestampToNanos(timestamp: bigint, unit: "ns" | "us" | "ms") {
  switch (unit) {
    case "ns":
      return timestamp;
    case "us":
      return timestamp * 1000n;
    case "ms":
      return timestamp * 1000_000n;
    default:
      throw new Error("Unknown timestamp unit: " + unit);
  }
}

type DeprecatedOptions = {
  /** @deprecated */
  copy_buffer?: boolean;
  /** @deprecated */
  copyBuffer?: boolean;
  /** @deprecated */
  bufferSize?: number;
};
function replaceDeprecatedOptions(
    options: SenderOptions & DeprecatedOptions,
    log: (level: "error" | "warn" | "info" | "debug", message: string) => void
) {
  // deal with deprecated options
  if (options.copy_buffer !== undefined) {
    log("warn", `Option 'copy_buffer' is not supported anymore, please, remove it`);
  }
  if (options.copyBuffer !== undefined) {
    log("warn", `Option 'copyBuffer' is not supported anymore, please, remove it`);
  }
  if (options.bufferSize !== undefined) {
    log("warn", `Option 'bufferSize' is not supported anymore, please, replace it with 'init_buf_size'`);
    options.init_buf_size = options.bufferSize;
    options.bufferSize = undefined;
  }
}

function constructAuth(options: SenderOptions) {
  if (!options.username && !options.token && !options.password) {
    // no intention to authenticate
    return;
  }
  if (!options.username || !options.token) {
    throw new Error(
      "TCP transport requires a username and a private key for authentication, " +
      "please, specify the 'username' and 'token' config options",
    );
  }

  options.auth = {
    keyId: options.username,
    token: options.token,
  };
}

function constructJwk(options: SenderOptions) {
  if (options.auth) {
    if (!options.auth.keyId) {
      throw new Error(
        "Missing username, please, specify the 'keyId' property of the 'auth' config option. " +
        "For example: new Sender({protocol: 'tcp', host: 'host', auth: {keyId: 'username', token: 'private key'}})",
      );
    }
    if (typeof options.auth.keyId !== "string") {
      throw new Error(
        "Please, specify the 'keyId' property of the 'auth' config option as a string. " +
        "For example: new Sender({protocol: 'tcp', host: 'host', auth: {keyId: 'username', token: 'private key'}})",
      );
    }
    if (!options.auth.token) {
      throw new Error(
        "Missing private key, please, specify the 'token' property of the 'auth' config option. " +
        "For example: new Sender({protocol: 'tcp', host: 'host', auth: {keyId: 'username', token: 'private key'}})",
      );
    }
    if (typeof options.auth.token !== "string") {
      throw new Error(
        "Please, specify the 'token' property of the 'auth' config option as a string. " +
        "For example: new Sender({protocol: 'tcp', host: 'host', auth: {keyId: 'username', token: 'private key'}})",
      );
    }

    return {
      kid: options.auth.keyId,
      d: options.auth.token,
      ...PUBLIC_KEY,
      kty: "EC",
      crv: "P-256",
    };
  } else {
    return options.jwk;
  }
}

export { Sender, DEFAULT_BUFFER_SIZE, DEFAULT_MAX_BUFFER_SIZE };
