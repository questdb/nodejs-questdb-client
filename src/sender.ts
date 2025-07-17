// @ts-check
import { log, Logger } from "./logging";
import { SenderOptions, ExtraOptions } from "./options";
import { SenderTransport, createTransport } from "./transport";
import { isBoolean, isInteger } from "./utils";
import { SenderBuffer } from "./buffer";

const DEFAULT_AUTO_FLUSH_INTERVAL = 1000; // 1 sec

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
  private readonly transport: SenderTransport;

  private buffer: SenderBuffer;

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
   * See SenderOptions documentation for detailed description of configuration options. <br>
   */
  constructor(options: SenderOptions) {
    this.transport = createTransport(options);
    this.buffer = new SenderBuffer(options);

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
  static fromConfig(configurationString: string, extraOptions?: ExtraOptions): Sender {
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
  static fromEnv(extraOptions?: ExtraOptions): Sender {
    return new Sender(
      SenderOptions.fromConfig(process.env.QDB_CLIENT_CONF, extraOptions),
    );
  }

  /**
   * Resets the buffer, data added to the buffer will be lost. <br>
   * In other words it clears the buffer and sets the writing position to the beginning of the buffer.
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
   * Sends the buffer's content to the database and compacts the buffer.
   * If the last row is not finished it stays in the sender's buffer.
   *
   * @return {Promise<boolean>} Resolves to true when there was data in the buffer to send, and it was sent successfully.
   */
  async flush(): Promise<boolean> {
    const dataToSend: Buffer = this.buffer.toBufferNew();
    if (!dataToSend) {
      return false; // Nothing to send
    }

    this.log("debug", `Flushing, number of flushed rows: ${this.pendingRowCount}`);
    this.resetAutoFlush();

    await this.transport.send(dataToSend);
  }

  /**
   * Closes the TCP connection to the database. <br>
   * Data sitting in the Sender's buffer will be lost unless flush() is called before close().
   */
  async close() {
    return this.transport.close();
  }

  /**
   * Write the table name into the buffer of the sender.
   *
   * @param {string} table - Table name.
   * @return {Sender} Returns with a reference to this sender.
   */
  table(table: string): Sender {
    this.buffer.table(table);
    return this;
  }

  /**
   * Write a symbol name and value into the buffer of the sender.
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
   * Write a string column with its value into the buffer of the sender.
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
   * Write a boolean column with its value into the buffer of the sender.
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
   * Write a float column with its value into the buffer of the sender.
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
   * Write an integer column with its value into the buffer of the sender.
   *
   * @param {string} name - Column name.
   * @param {number} value - Column value, accepts only number values.
   * @return {Sender} Returns with a reference to this sender.
   */
  intColumn(name: string, value: number): Sender {
    this.buffer.intColumn(name, value);
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
    this.buffer.timestampColumn(name, value, unit);
    return this;
  }

  /**
   * Closing the row after writing the designated timestamp into the buffer of the sender.
   *
   * @param {number | bigint} timestamp - Designated epoch timestamp, accepts numbers or BigInts.
   * @param {string} [unit=us] - Timestamp unit. Supported values: 'ns' - nanoseconds, 'us' - microseconds, 'ms' - milliseconds. Defaults to 'us'.
   */
  async at(timestamp: number | bigint, unit: "ns" | "us" | "ms" = "us") {
    this.buffer.at(timestamp, unit);
    this.pendingRowCount++;
    this.log("debug", `Pending row count: ${this.pendingRowCount}`);
    await this.tryFlush();
  }

  /**
   * Closing the row without writing designated timestamp into the buffer of the sender. <br>
   * Designated timestamp will be populated by the server on this record.
   */
  async atNow() {
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

  private async tryFlush() {
    if (
        this.autoFlush
        && this.pendingRowCount > 0
        && (
            (this.autoFlushRows > 0 && this.pendingRowCount >= this.autoFlushRows)
            || (this.autoFlushInterval > 0 && Date.now() - this.lastFlushTime >= this.autoFlushInterval)
        )
    ) {
      await this.flush();
    }
  }
}

export { Sender };
