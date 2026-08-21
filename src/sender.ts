// @ts-check
import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { log, Logger } from "./logging";
import {
  SenderOptions,
  ExtraOptions,
  qwpConfig,
  UDP,
  WS,
  WSS,
} from "./options";
import { SenderTransport, createTransport } from "./transport";
import { SenderBuffer, createBuffer } from "./buffer";
import { isBoolean, isInteger, TimestampUnit } from "./utils";
import { QWP_INGRESS_PATH } from "./_qwp/_core";
import {
  createQwpNodeSender,
  createQwpNodeUdpSender,
  QwpSender,
} from "./qwp/node";
import type { QwpTableWriter } from "./_qwp/sender";
import type { QwpWriterSchema } from "./_qwp/writer";

const DEFAULT_AUTO_FLUSH_INTERVAL = 1000; // 1 sec

/**
 * The QuestDB client's API provides methods to connect to the database, ingest data, and close the connection. <br>
 * The client supports multiple transport protocols.
 * <p>
 * <b>Transport Options:</b>
 * <ul>
 * <li><b>HTTP</b>: Uses standard HTTP requests for data ingestion. Provides immediate feedback via HTTP response codes.
 * Recommended for most use cases due to superior error handling and debugging capabilities. Uses Undici library by default for high performance.</li>
 * <li><b>HTTPS</b>: Secure HTTP transport with TLS encryption. Same benefits as HTTP but with encrypted communication.
 * Supports certificate validation and custom CA certificates.</li>
 * <li><b>TCP</b>: Direct TCP connection, provides persistent connections. Uses JWK token-based authentication.</li>
 * <li><b>TCPS</b>: Secure TCP transport with TLS encryption.</li>
 * <li><b>WS/WSS</b>: QWP ingress over WebSocket, including browser-compatible wire encoding and QWP ACKs.</li>
 * <li><b>UDP</b>: Node-only fire-and-forget QWP ingress in self-contained datagrams.</li>
 * </ul>
 * </p>
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
 * The client supports multiple protocol versions for data serialization. Protocol version 1 uses text-based
 * serialization, while version 2 uses binary encoding for doubles and supports array columns for improved
 * performance. The client can automatically negotiate the protocol version with the server when using HTTP/HTTPS
 * by setting the protocol_version to 'auto' (default behavior).
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
 * the {@link SenderOptions} documentation.
 * </p>
 * <p>
 * <b>Transport Configuration Examples:</b>
 * <ul>
 * <li>HTTP: <i>Sender.fromConfig("http::addr=localhost:9000")</i></li>
 * <li>HTTPS with authentication: <i>Sender.fromConfig("https::addr=localhost:9000;username=admin;password=secret")</i></li>
 * <li>TCP: <i>Sender.fromConfig("tcp::addr=localhost:9009")</i></li>
 * <li>TCPS with authentication: <i>Sender.fromConfig("tcps::addr=localhost:9009;username=user;token=private_key")</i></li>
 * <li>QWP: <i>Sender.fromConfig("ws::addr=localhost:9000")</i></li>
 * <li>QWP UDP: <i>Sender.fromConfig("udp::addr=localhost:9007;max_datagram_size=1400")</i></li>
 * </ul>
 * </p>
 * <p>
 * <b>HTTP Transport Implementation:</b><br>
 * By default, HTTP/HTTPS transport uses the high-performance Undici library for connection management and request handling.
 * For compatibility or specific requirements, you can enable the standard HTTP transport using Node.js built-in modules
 * by setting <i>stdlib_http=on</i> in the configuration string. The standard HTTP transport provides the same functionality
 * but uses Node.js http/https modules instead of Undici.
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
  private readonly transport?: SenderTransport;

  private readonly buffer?: SenderBuffer;

  private readonly qwpSender?: QwpSender;

  private readonly autoFlush: boolean;
  private readonly autoFlushRows: number;
  private readonly autoFlushInterval: number;
  private lastFlushTime: number;
  private pendingRowCount: number;

  private readonly log: Logger;

  /**
   * Creates an instance of Sender.
   *
   * @param {SenderOptions} options - Sender configuration object. <br>
   * See SenderOptions documentation for detailed description of configuration options.
   */
  constructor(options: SenderOptions) {
    this.log = options && typeof options.log === "function" ? options.log : log;
    if (
      options?.protocol === WS ||
      options?.protocol === WSS ||
      options?.protocol === UDP
    ) {
      const resolved = qwpConfig(options);
      this.qwpSender = resolved
        ? // SenderOptions already parsed the ws/wss connect string with the
          // QWP schema, so there is one vocabulary and one parser however the
          // sender was constructed.
          createQwpNodeSender(
            resolved.ingress,
            resolved.sender,
            resolved.ingressSession,
          )
        : options.protocol === UDP
          ? createConfiguredQwpUdpSender(options, this.log)
          : createConfiguredQwpSender(options, this.log);
      this.autoFlush = false;
      this.autoFlushRows = 0;
      this.autoFlushInterval = 0;
      this.resetAutoFlush();
      return;
    }
    this.transport = createTransport(options);
    this.buffer = createBuffer(options);

    this.autoFlush = isBoolean(options.auto_flush) ? options.auto_flush : true;
    this.autoFlushRows = isInteger(options.auto_flush_rows, 0)
      ? options.auto_flush_rows
      : this.transport.getDefaultAutoFlushRows();
    this.autoFlushInterval = isInteger(options.auto_flush_interval, 0)
      ? options.auto_flush_interval
      : DEFAULT_AUTO_FLUSH_INTERVAL;

    this.reset();
  }

  /**
   * Creates a Sender object by parsing the provided configuration string.
   *
   * @param {string} configurationString - Configuration string. <br>
   * @param {object} extraOptions - Optional extra configuration. <br>
   * - 'log' is a logging function used by the {@link Sender}.
   * Prototype: <i>(level: 'error'|'warn'|'info'|'debug', message: string) => void</i>. <br>
   * - 'agent' is a custom http/https agent used by the {@link Sender} when http/https transport is used.
   * Depends on which transport implementation and protocol used, one of the followings expected: <i>undici.Agent</i>, <i>http.Agent</i> or <i>https.Agent</i>.
   *
   * @return {Sender} A Sender object initialized from the provided configuration string.
   */
  static async fromConfig(
    configurationString: string,
    extraOptions?: ExtraOptions,
  ): Promise<Sender> {
    return new Sender(
      await SenderOptions.fromConfig(configurationString, extraOptions),
    );
  }

  /**
   * Creates a Sender object by parsing the configuration string set in the <b>QDB_CLIENT_CONF</b> environment variable.
   *
   * @param {object} extraOptions - Optional extra configuration. <br>
   * - 'log' is a logging function used by the {@link Sender}.
   * Prototype: <i>(level: 'error'|'warn'|'info'|'debug', message: string) => void</i>. <br>
   * - 'agent' is a custom http/https agent used by the {@link Sender} when http/https transport is used.
   * Depends on which transport implementation and protocol used, one of the followings expected: <i>undici.Agent</i>, <i>http.Agent</i> or <i>https.Agent</i>.
   *
   * @return {Sender} A Sender object initialized from the <b>QDB_CLIENT_CONF</b> environment variable.
   */
  static async fromEnv(extraOptions?: ExtraOptions): Promise<Sender> {
    return Sender.fromConfig(process.env.QDB_CLIENT_CONF, extraOptions);
  }

  /**
   * Resets the sender's buffer, data sitting in the buffer will be lost. <br>
   * In other words it clears the buffer, and sets the writing position to the beginning of the buffer.
   *
   * @return {Sender} Returns with a reference to this sender.
   */
  reset(): Sender {
    if (this.qwpSender) {
      this.qwpSender.reset();
      return this;
    }
    this.buffer!.reset();
    this.resetAutoFlush();
    return this;
  }

  /**
   * Compiles a table-bound object-row writer for QWP transports.
   * Legacy ILP transports continue to use the fluent row API.
   */
  writer<const Schema extends QwpWriterSchema>(
    tableName: string,
    schema: Schema,
  ): QwpTableWriter<Schema> {
    if (!this.qwpSender) {
      throw new Error(
        "compiled table writers are available only with QWP transports",
      );
    }
    return this.qwpSender.writer(tableName, schema);
  }

  /**
   * Creates a TCP connection to the database.
   *
   * @return {Promise<boolean>} Resolves to true if the client is connected.
   */
  connect(): Promise<boolean> {
    return this.qwpSender
      ? this.qwpSender.connect()
      : this.transport!.connect();
  }

  /**
   * Sends the content of the sender's buffer to the database and compacts the buffer.
   * If the last row is not finished it stays in the sender's buffer.
   *
   * @return {Promise<boolean>} Resolves to true when there was data in the buffer to send, and it was sent successfully.
   */
  async flush(): Promise<boolean> {
    if (this.qwpSender) return this.qwpSender.flush();
    const dataToSend: Buffer = this.buffer!.toBufferNew();
    if (!dataToSend) {
      return false; // Nothing to send
    }

    this.log(
      "debug",
      `Flushing, number of flushed rows: ${this.pendingRowCount}`,
    );
    this.resetAutoFlush();

    await this.transport!.send(dataToSend);
    return true;
  }

  /**
   * Flushes pending rows and returns the highest QWP frame sequence published
   * by this call. Non-QWP transports flush normally and return -1n because
   * they do not expose frame sequences.
   */
  async flushAndGetSequence(): Promise<bigint> {
    if (this.qwpSender) return this.qwpSender.flushAndGetSequence();
    await this.flush();
    return -1n;
  }

  /** Highest stable QWP frame sequence published, or -1n when unavailable. */
  get publishedSequence(): bigint {
    return this.qwpSender?.publishedSequence ?? -1n;
  }

  /** Highest cumulative QWP ACK watermark, or -1n when unavailable. */
  get acknowledgedSequence(): bigint {
    return this.qwpSender?.acknowledgedSequence ?? -1n;
  }

  /** Waits independently for a cumulative QWP ACK watermark. */
  async waitForAcknowledged(
    targetSequence: bigint,
    timeoutMs?: number,
  ): Promise<void> {
    if (this.qwpSender) {
      return this.qwpSender.waitForAcknowledged(targetSequence, timeoutMs);
    }
    if (typeof targetSequence !== "bigint") {
      throw new TypeError("QWP ACK target sequence must be a bigint");
    }
    if (
      timeoutMs !== undefined &&
      (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    ) {
      throw new RangeError(
        "QWP ACK watermark timeout must be positive and finite",
      );
    }
    if (targetSequence < 0n) return;
    throw new Error(
      "ACK sequence watermarks are available only with the QWP WebSocket transport",
    );
  }

  /**
   * Closes the connection to the database. QWP publishes completed rows and
   * performs a bounded acknowledgement drain first. Other transports retain
   * their legacy behavior and require an explicit flush().
   */
  async close(): Promise<void> {
    if (this.qwpSender) return this.qwpSender.close();
    const pos = this.buffer!.currentPosition();
    if (pos > 0) {
      this.log(
        "warn",
        `Buffer contains data which has not been flushed before closing the sender, and it will be lost [position=${pos}]`,
      );
    }
    return this.transport!.close();
  }

  /**
   * Writes the table name into the buffer of the sender of the sender.
   *
   * @param {string} table - Table name.
   * @return {Sender} Returns with a reference to this sender.
   */
  table(table: string): Sender {
    if (this.qwpSender) this.qwpSender.table(table);
    else this.buffer!.table(table);
    return this;
  }

  /**
   * Writes a symbol name and value into the buffer of the sender. <br>
   * Use it to insert into SYMBOL columns.
   *
   * @param {string} name - Symbol name.
   * @param {unknown} value - Symbol value, toString() is called to extract the actual symbol value from the parameter. A null or undefined value omits the symbol entirely (stored as NULL).
   * @return {Sender} Returns with a reference to this sender.
   */
  symbol(name: string, value: unknown): Sender {
    if (this.qwpSender) this.qwpSender.symbol(name, value);
    else this.buffer!.symbol(name, value);
    return this;
  }

  /**
   * Writes a string column with its value into the buffer of the sender. <br>
   * Use it to insert into VARCHAR and STRING columns.
   *
   * @param {string} name - Column name.
   * @param {string | null | undefined} value - Column value, accepts only string values. A null or undefined value omits the column entirely (stored as NULL).
   * @return {Sender} Returns with a reference to this sender.
   */
  stringColumn(name: string, value: string | null | undefined): Sender {
    if (this.qwpSender) this.qwpSender.stringColumn(name, value);
    else this.buffer!.stringColumn(name, value);
    return this;
  }

  /**
   * Writes a boolean column with its value into the buffer of the sender. <br>
   * Use it to insert into BOOLEAN columns.
   *
   * @param {string} name - Column name.
   * @param {boolean | null | undefined} value - Column value, accepts only boolean values. A null or undefined value omits the column entirely (stored as NULL).
   * @return {Sender} Returns with a reference to this sender.
   */
  booleanColumn(name: string, value: boolean | null | undefined): Sender {
    if (this.qwpSender) this.qwpSender.booleanColumn(name, value);
    else this.buffer!.booleanColumn(name, value);
    return this;
  }

  /**
   * Writes a 64-bit floating point value into the buffer of the sender. <br>
   * Use it to insert into DOUBLE or FLOAT database columns.
   *
   * @param {string} name - Column name.
   * @param {number | null | undefined} value - Column value, accepts only number values. A null or undefined value omits the column entirely (stored as NULL).
   * @return {Sender} Returns with a reference to this sender.
   */
  floatColumn(name: string, value: number | null | undefined): Sender {
    if (this.qwpSender) this.qwpSender.floatColumn(name, value);
    else this.buffer!.floatColumn(name, value);
    return this;
  }

  /**
   * Writes an array column with its values into the buffer of the sender.
   *
   * @param {string} name - Column name
   * @param {unknown[] | null | undefined} value - Array values to write (currently supports double arrays). A null or undefined value omits the column entirely, storing NULL.
   * @returns {Sender} Returns with a reference to this sender.
   * @throws Error if arrays are not supported by the buffer implementation, or array validation fails:
   * - value is not an array
   * - or the shape of the array is irregular: the length of sub-arrays are different
   * - or the array is not homogeneous: its elements are not all the same type
   */
  arrayColumn(name: string, value: unknown[] | null | undefined): Sender {
    if (this.qwpSender) this.qwpSender.arrayColumn(name, value);
    else this.buffer!.arrayColumn(name, value);
    return this;
  }

  /**
   * Writes a 64-bit signed integer into the buffer of the sender. <br>
   * Use it to insert into LONG, INT, SHORT and BYTE columns.
   *
   * @param {string} name - Column name.
   * @param {number | null | undefined} value - Column value, accepts only number values. A null or undefined value omits the column entirely (stored as NULL).
   * @return {Sender} Returns with a reference to this sender.
   * @throws Error if the value is not an integer
   */
  intColumn(name: string, value: number | null | undefined): Sender {
    if (this.qwpSender) this.qwpSender.intColumn(name, value);
    else this.buffer!.intColumn(name, value);
    return this;
  }

  /**
   * Writes a timestamp column and its value into the buffer of the sender.
   *
   * Use this method to insert data into `TIMESTAMP` or `TIMESTAMP_NS` columns.
   *
   * **Precision rules**:
   * - **Protocol v2 and higher:**
   *   Timestamps passed with unit `'ns'` (nanoseconds) are sent with full nanosecond precision.
   *   All other timestamps are sent with microsecond precision.
   * - **Protocol v1:**
   *   Always uses microsecond precision, even if the timestamp is specified in nanoseconds.
   *
   * @param {string} name - The column name.
   * @param {number | bigint | null | undefined} value - The epoch timestamp. Must be an integer or a `BigInt`. A null or undefined value omits the column entirely (stored as NULL).
   * @param {'ns' | 'us' | 'ms'} [unit='us'] - The time unit of the timestamp.
   * Supported values:
   *   - `'ns'` — nanoseconds (requires `BigInt`)
   *   - `'us'` — microseconds *(default)*
   *   - `'ms'` — milliseconds
   *
   * @returns {SenderBuffer} Returns with a reference to this buffer.
   *
   * @throws {Error} If `value` is not an integer or `BigInt`.
   * @throws {Error} If `unit` is `'ns'` but `value` is not a `BigInt`.
   */
  timestampColumn(
    name: string,
    value: number | bigint | null | undefined,
    unit: TimestampUnit = "us",
  ): Sender {
    if (this.qwpSender) this.qwpSender.timestampColumn(name, value, unit);
    else this.buffer!.timestampColumn(name, value, unit);
    return this;
  }

  /**
   * Writes a decimal value into the buffer using the text format.
   *
   * Use it to insert into DECIMAL database columns.
   *
   * @param {string} name - Column name.
   * @param {string | number | null | undefined} value - Column value, accepts only number/string values. A null or undefined value omits the column entirely (stored as NULL).
   * @returns {Sender} Returns with a reference to this buffer.
   * @throws Error if decimals are not supported by the buffer implementation, or decimal validation fails:
   * - string value is not a valid decimal representation
   */
  decimalColumnText(
    name: string,
    value: string | number | null | undefined,
  ): Sender {
    if (this.qwpSender) this.qwpSender.decimalColumnText(name, value);
    else this.buffer!.decimalColumnText(name, value);
    return this;
  }

  /**
   * Writes a decimal value into the buffer using the binary format.
   *
   * Use it to insert into DECIMAL database columns.
   *
   * @param {string} name - Column name.
   * @param {Int8Array | bigint | null | undefined} unscaled - The unscaled value of the decimal in two's
   * complement representation and big-endian byte order.
   * A null or undefined value omits the column entirely (stored as NULL).
   * An empty array also represents NULL, but the two are not encoded alike:
   * on the ILP transports an empty array writes an explicit NULL decimal
   * field, while the QWP transports omit the column exactly as they do for
   * null. QuestDB records NULL either way for a column that already exists.
   * @param {number} scale - The scale of the decimal value.
   * @returns {Sender} Returns with a reference to this buffer.
   * @throws Error if decimals are not supported by the buffer implementation, or decimal validation fails:
   * - unscaled value length is not between 0 and 32 bytes
   * - scale is not between 0 and 76
   * - unscaled value contains invalid bytes
   */
  decimalColumn(
    name: string,
    unscaled: Int8Array | bigint | null | undefined,
    scale: number,
  ): Sender {
    if (this.qwpSender) this.qwpSender.decimalColumn(name, unscaled, scale);
    else this.buffer!.decimalColumn(name, unscaled, scale);
    return this;
  }

  /**
   * Closes the row after writing the designated timestamp into the buffer of the sender.
   *
   * **Precision rules**:
   * - **Protocol v2 and higher:**
   *   Timestamps passed with unit `'ns'` (nanoseconds) are sent with full nanosecond precision.
   *   All other timestamps are sent with microsecond precision.
   * - **Protocol v1:**
   *   Always uses microsecond precision, even if the timestamp is specified in nanoseconds.
   *
   * @param {number | bigint} timestamp - Designated epoch timestamp. Must be an integer or a `BigInt`.
   * @param {'ns' | 'us' | 'ms'} [unit='us'] - The time unit of the timestamp.
   * Supported values:
   *   - `'ns'` — nanoseconds (requires `BigInt`)
   *   - `'us'` — microseconds *(default)*
   *   - `'ms'` — milliseconds
   *
   * @returns {SenderBuffer} Returns with a reference to this buffer.
   *
   * @throws {Error} If `value` is not an integer or `BigInt`.
   * @throws {Error} If `unit` is `'ns'` but `value` is not a `BigInt`.
   */
  async at(
    timestamp: number | bigint,
    unit: TimestampUnit = "us",
  ): Promise<void> {
    if (this.qwpSender) return this.qwpSender.at(timestamp, unit);
    this.buffer!.at(timestamp, unit);
    this.pendingRowCount++;
    this.log("debug", `Pending row count: ${this.pendingRowCount}`);
    await this.tryFlush();
  }

  /**
   * Closes the row without writing designated timestamp into the buffer of the sender. <br>
   * Designated timestamp will be populated by the server on this record.
   */
  async atNow(): Promise<void> {
    if (this.qwpSender) return this.qwpSender.atNow();
    this.buffer!.atNow();
    this.pendingRowCount++;
    this.log("debug", `Pending row count: ${this.pendingRowCount}`);
    await this.tryFlush();
  }

  private resetAutoFlush(): void {
    this.lastFlushTime = Date.now();
    this.pendingRowCount = 0;
    this.log("debug", `Pending row count: ${this.pendingRowCount}`);
  }

  private async tryFlush(): Promise<void> {
    if (
      this.autoFlush &&
      this.pendingRowCount > 0 &&
      ((this.autoFlushRows > 0 && this.pendingRowCount >= this.autoFlushRows) ||
        (this.autoFlushInterval > 0 &&
          Date.now() - this.lastFlushTime >= this.autoFlushInterval))
    ) {
      await this.flush();
    }
  }
}

function createConfiguredQwpSender(
  options: SenderOptions,
  logger: Logger,
): QwpSender {
  if (!options.host || !options.port) {
    throw new Error("The 'host' and 'port' options are mandatory for QWP");
  }
  const configuredWebSocket = options.qwp?.webSocket ?? {};
  const configuredSender = options.qwp?.sender ?? {};
  let agent = configuredWebSocket.agent;
  if (!agent && options.agent instanceof http.Agent) agent = options.agent;
  if (!agent && options.protocol === WSS) {
    agent = new https.Agent({
      ca: options.tls_ca ? readFileSync(options.tls_ca) : undefined,
      rejectUnauthorized: options.tls_verify ?? true,
    });
  }
  const authorization =
    configuredWebSocket.authorization ?? qwpAuthorization(options);
  // ws/wss connect-string keys are the QWP schema's, parsed only by
  // resolveQwpNodeClientConfig(). This path builds a sender from a
  // programmatic options object, so it reads options.qwp.* directly.
  const storeAndForward = configuredWebSocket.storeAndForward;
  return createQwpNodeSender(
    {
      ...configuredWebSocket,
      storeAndForward,
      url: `${options.protocol}://${options.host}:${options.port}${QWP_INGRESS_PATH}`,
      agent,
      authorization,
    },
    {
      ...configuredSender,
      autoFlush: isBoolean(options.auto_flush)
        ? options.auto_flush
        : configuredSender.autoFlush,
      autoFlushRows: isInteger(options.auto_flush_rows, 0)
        ? options.auto_flush_rows
        : configuredSender.autoFlushRows,
      autoFlushBytes: configuredSender.autoFlushBytes,
      autoFlushIntervalMs: isInteger(options.auto_flush_interval, 0)
        ? options.auto_flush_interval
        : configuredSender.autoFlushIntervalMs,
      closeFlushTimeoutMs: configuredSender.closeFlushTimeoutMs,
      maxNameLength: isInteger(options.max_name_len, 1)
        ? options.max_name_len
        : configuredSender.maxNameLength,
      log: logger,
    },
    options.qwp?.session,
  );
}

function createConfiguredQwpUdpSender(
  options: SenderOptions,
  logger: Logger,
): QwpSender {
  if (!options.host || !options.port) {
    throw new Error("The 'host' and 'port' options are mandatory for QWP UDP");
  }
  const configuredUdp = options.qwp?.udp ?? {};
  const configuredSender = options.qwp?.sender ?? {};
  const maxDatagramSize =
    options.max_datagram_size ?? configuredUdp.maxDatagramSize ?? 1_400;
  return createQwpNodeUdpSender(
    {
      ...configuredUdp,
      host: options.host,
      port: options.port,
      maxDatagramSize,
      multicastTtl: options.multicast_ttl ?? configuredUdp.multicastTtl,
      onError: configuredUdp.onError ?? ((error) => logger("warn", error)),
    },
    {
      ...configuredSender,
      autoFlush: isBoolean(options.auto_flush)
        ? options.auto_flush
        : configuredSender.autoFlush,
      autoFlushRows: isInteger(options.auto_flush_rows, 0)
        ? options.auto_flush_rows
        : configuredSender.autoFlushRows,
      autoFlushBytes: isInteger(options.auto_flush_bytes, 0)
        ? options.auto_flush_bytes
        : (configuredSender.autoFlushBytes ?? maxDatagramSize),
      autoFlushIntervalMs: isInteger(options.auto_flush_interval, 0)
        ? options.auto_flush_interval
        : configuredSender.autoFlushIntervalMs,
      maxNameLength: isInteger(options.max_name_len, 1)
        ? options.max_name_len
        : configuredSender.maxNameLength,
      log: logger,
    },
  );
}

function qwpAuthorization(options: SenderOptions): string | undefined {
  if (options.token) return `Bearer ${options.token}`;
  if (options.username !== undefined || options.password !== undefined) {
    if (!options.username || options.password === undefined) {
      throw new Error(
        "QWP Basic authentication requires both 'username' and 'password'",
      );
    }
    return `Basic ${Buffer.from(`${options.username}:${options.password}`, "utf8").toString("base64")}`;
  }
  return undefined;
}

export { Sender };
