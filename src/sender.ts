// @ts-check
import { log, Logger } from "./logging";
import { SenderOptions, ExtraOptions } from "./options";
import { SenderTransport, createTransport } from "./transport";
import { SenderBuffer, createBuffer } from "./buffer";
import { isBoolean, isInteger, TimestampUnit } from "./utils";

const DEFAULT_AUTO_FLUSH_INTERVAL = 1000; // 1 sec

/** @classdesc
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
 * the <a href="SenderOptions.html">SenderOptions</a> documentation.
 * </p>
 * <p>
 * <b>Transport Configuration Examples:</b>
 * <ul>
 * <li>HTTP: <i>Sender.fromConfig("http::addr=localhost:9000")</i></li>
 * <li>HTTPS with authentication: <i>Sender.fromConfig("https::addr=localhost:9000;username=admin;password=secret")</i></li>
 * <li>TCP: <i>Sender.fromConfig("tcp::addr=localhost:9009")</i></li>
 * <li>TCPS with authentication: <i>Sender.fromConfig("tcps::addr=localhost:9009;username=user;token=private_key")</i></li>
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
  private readonly transport: SenderTransport;

  private readonly buffer: SenderBuffer;

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
    this.transport = createTransport(options);
    this.buffer = createBuffer(options);

    this.log = typeof options.log === "function" ? options.log : log;

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
   * - 'log' is a logging function used by the <a href="Sender.html">Sender</a>. <br>
   * Prototype: <i>(level: 'error'|'warn'|'info'|'debug', message: string) => void</i>. <br>
   * - 'agent' is a custom http/https agent used by the <a href="Sender.html">Sender</a> when http/https transport is used. <br>
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
   * - 'log' is a logging function used by the <a href="Sender.html">Sender</a>. <br>
   * Prototype: <i>(level: 'error'|'warn'|'info'|'debug', message: string) => void</i>. <br>
   * - 'agent' is a custom http/https agent used by the <a href="Sender.html">Sender</a> when http/https transport is used. <br>
   * Depends on which transport implementation and protocol used, one of the followings expected: <i>undici.Agent</i>, <i>http.Agent</i> or <i>https.Agent</i>.
   *
   * @return {Sender} A Sender object initialized from the <b>QDB_CLIENT_CONF</b> environment variable.
   */
  static async fromEnv(extraOptions?: ExtraOptions): Promise<Sender> {
    return new Sender(
      await SenderOptions.fromConfig(process.env.QDB_CLIENT_CONF, extraOptions),
    );
  }

  /**
   * Resets the sender's buffer, data sitting in the buffer will be lost. <br>
   * In other words it clears the buffer, and sets the writing position to the beginning of the buffer.
   *
   * @return {Sender} Returns with a reference to this sender.
   */
  reset(): Sender {
    this.buffer.reset();
    this.resetAutoFlush();
    return this;
  }

  /**
   * Creates a TCP connection to the database.
   *
   * @return {Promise<boolean>} Resolves to true if the client is connected.
   */
  connect(): Promise<boolean> {
    return this.transport.connect();
  }

  /**
   * Sends the content of the sender's buffer to the database and compacts the buffer.
   * If the last row is not finished it stays in the sender's buffer.
   *
   * @return {Promise<boolean>} Resolves to true when there was data in the buffer to send, and it was sent successfully.
   */
  async flush(): Promise<boolean> {
    const dataToSend: Buffer = this.buffer.toBufferNew();
    if (!dataToSend) {
      return false; // Nothing to send
    }

    this.log(
      "debug",
      `Flushing, number of flushed rows: ${this.pendingRowCount}`,
    );
    this.resetAutoFlush();

    await this.transport.send(dataToSend);
    return true;
  }

  /**
   * Closes the connection to the database. <br>
   * Data sitting in the Sender's buffer will be lost unless flush() is called before close().
   */
  async close(): Promise<void> {
    const pos = this.buffer.currentPosition();
    if (pos > 0) {
      this.log(
        "warn",
        `Buffer contains data which has not been flushed before closing the sender, and it will be lost [position=${pos}]`,
      );
    }
    return this.transport.close();
  }

  /**
   * Writes the table name into the buffer of the sender of the sender.
   *
   * @param {string} table - Table name.
   * @return {Sender} Returns with a reference to this sender.
   */
  table(table: string): Sender {
    this.buffer.table(table);
    return this;
  }

  /**
   * Writes a symbol name and value into the buffer of the sender. <br>
   * Use it to insert into SYMBOL columns.
   *
   * @param {string} name - Symbol name.
   * @param {unknown} value - Symbol value, toString() is called to extract the actual symbol value from the parameter.
   * @return {Sender} Returns with a reference to this sender.
   */
  symbol(name: string, value: unknown): Sender {
    this.buffer.symbol(name, value);
    return this;
  }

  /**
   * Writes a string column with its value into the buffer of the sender. <br>
   * Use it to insert into VARCHAR and STRING columns.
   *
   * @param {string} name - Column name.
   * @param {string} value - Column value, accepts only string values.
   * @return {Sender} Returns with a reference to this sender.
   */
  stringColumn(name: string, value: string): Sender {
    this.buffer.stringColumn(name, value);
    return this;
  }

  /**
   * Writes a boolean column with its value into the buffer of the sender. <br>
   * Use it to insert into BOOLEAN columns.
   *
   * @param {string} name - Column name.
   * @param {boolean} value - Column value, accepts only boolean values.
   * @return {Sender} Returns with a reference to this sender.
   */
  booleanColumn(name: string, value: boolean): Sender {
    this.buffer.booleanColumn(name, value);
    return this;
  }

  /**
   * Writes a 64-bit floating point value into the buffer of the sender. <br>
   * Use it to insert into DOUBLE or FLOAT database columns.
   *
   * @param {string} name - Column name.
   * @param {number} value - Column value, accepts only number values.
   * @return {Sender} Returns with a reference to this sender.
   */
  floatColumn(name: string, value: number): Sender {
    this.buffer.floatColumn(name, value);
    return this;
  }

  /**
   * Writes an array column with its values into the buffer of the sender.
   *
   * @param {string} name - Column name
   * @param {unknown[]} value - Array values to write (currently supports double arrays)
   * @returns {Sender} Returns with a reference to this sender.
   * @throws Error if arrays are not supported by the buffer implementation, or array validation fails:
   * - value is not an array
   * - or the shape of the array is irregular: the length of sub-arrays are different
   * - or the array is not homogeneous: its elements are not all the same type
   */
  arrayColumn(name: string, value: unknown[]): Sender {
    this.buffer.arrayColumn(name, value);
    return this;
  }

  /**
   * Writes a 64-bit signed integer into the buffer of the sender. <br>
   * Use it to insert into LONG, INT, SHORT and BYTE columns.
   *
   * @param {string} name - Column name.
   * @param {number} value - Column value, accepts only number values.
   * @return {Sender} Returns with a reference to this sender.
   * @throws Error if the value is not an integer
   */
  intColumn(name: string, value: number): Sender {
    this.buffer.intColumn(name, value);
    return this;
  }

  /**
   * Writes a timestamp column with its value into the buffer of the sender. <br>
   * Use it to insert into TIMESTAMP columns.
   *
   * @param {string} name - Column name.
   * @param {number | bigint} value - Epoch timestamp, accepts numbers or BigInts.
   * @param {string} [unit=us] - Timestamp unit. Supported values: 'ns' - nanoseconds, 'us' - microseconds, 'ms' - milliseconds. Defaults to 'us'.
   * @return {Sender} Returns with a reference to this sender.
   */
  timestampColumn(
    name: string,
    value: number | bigint,
    unit: TimestampUnit = "us",
  ): Sender {
    this.buffer.timestampColumn(name, value, unit);
    return this;
  }

  /**
   * Closes the row after writing the designated timestamp into the buffer of the sender.
   *
   * @param {number | bigint} timestamp - Designated epoch timestamp, accepts numbers or BigInts.
   * @param {string} [unit=us] - Timestamp unit. Supported values: 'ns' - nanoseconds, 'us' - microseconds, 'ms' - milliseconds. Defaults to 'us'.
   */
  async at(
    timestamp: number | bigint,
    unit: TimestampUnit = "us",
  ): Promise<void> {
    this.buffer.at(timestamp, unit);
    this.pendingRowCount++;
    this.log("debug", `Pending row count: ${this.pendingRowCount}`);
    await this.tryFlush();
  }

  /**
   * Closes the row without writing designated timestamp into the buffer of the sender. <br>
   * Designated timestamp will be populated by the server on this record.
   */
  async atNow(): Promise<void> {
    this.buffer.atNow();
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

export { Sender };
