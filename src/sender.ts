// @ts-check
import { Buffer } from "node:buffer";

import { log, Logger } from "./logging";
import { validateColumnName, validateTableName } from "./validation";
import { SenderOptions, ExtraOptions } from "./options";
import { SenderTransport, createTransport } from "./transport";
import { isBoolean, isInteger, timestampToMicros, timestampToNanos } from "./utils";

const DEFAULT_AUTO_FLUSH_INTERVAL = 1000; // 1 sec

const DEFAULT_MAX_NAME_LENGTH = 127;

const DEFAULT_BUFFER_SIZE = 65536; //  64 KB
const DEFAULT_MAX_BUFFER_SIZE = 104857600; // 100 MB

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

  private bufferSize: number;
  private readonly maxBufferSize: number;
  private buffer: Buffer<ArrayBuffer>;
  private position: number;
  private endOfLastRow: number;

  private readonly autoFlush: boolean;
  private readonly autoFlushRows: number;
  private readonly autoFlushInterval: number;
  private lastFlushTime: number;
  private pendingRowCount: number;

  private hasTable: boolean;
  private hasSymbols: boolean;
  private hasColumns: boolean;

  private readonly maxNameLength: number;

  private readonly log: Logger;

  /**
   * Creates an instance of Sender.
   *
   * @param {SenderOptions} options - Sender configuration object. <br>
   * See SenderOptions documentation for detailed description of configuration options. <br>
   */
  constructor(options: SenderOptions) {
    this.transport = createTransport(options);

    this.log = typeof options.log === "function" ? options.log : log;
    SenderOptions.resolveDeprecated(options, this.log);

    this.autoFlush = isBoolean(options.auto_flush) ? options.auto_flush : true;
    this.autoFlushRows = isInteger(options.auto_flush_rows, 0)
      ? options.auto_flush_rows
      : this.transport.getDefaultAutoFlushRows();
    this.autoFlushInterval = isInteger(options.auto_flush_interval, 0)
      ? options.auto_flush_interval
      : DEFAULT_AUTO_FLUSH_INTERVAL;

    this.maxNameLength = isInteger(options.max_name_len, 1)
      ? options.max_name_len
      : DEFAULT_MAX_NAME_LENGTH;

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
   * Extends the size of the sender's buffer. <br>
   * Can be used to increase the size of buffer if overflown.
   * The buffer's content is copied into the new buffer.
   *
   * @param {number} bufferSize - New size of the buffer used by the sender, provided in bytes.
   */
  private resize(bufferSize: number) {
    if (bufferSize > this.maxBufferSize) {
      throw new Error(`Max buffer size is ${this.maxBufferSize} bytes, requested buffer size: ${bufferSize}`);
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
    this.startNewRow();
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
    const dataToSend: Buffer = this.toBufferNew();
    if (!dataToSend) {
      return false; // Nothing to send
    }

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
   * @ignore
   * @return {Buffer} Returns a cropped buffer, or null if there is nothing to send.
   * The returned buffer is backed by the sender's buffer.
   * Used only in tests.
   */
  toBufferView(pos = this.endOfLastRow): Buffer {
    return pos > 0 ? this.buffer.subarray(0, pos) : null;
  }

  /**
   * @ignore
   * @return {Buffer|null} Returns a cropped buffer ready to send to the server, or null if there is nothing to send.
   * The returned buffer is a copy of the sender's buffer.
   * It also compacts the Sender's buffer.
   */
  toBufferNew(pos = this.endOfLastRow): Buffer | null {
    if (pos > 0) {
      const data = Buffer.allocUnsafe(pos);
      this.buffer.copy(data, 0, 0, pos);
      this.compact();
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
    this.checkCapacity([table]);
    this.writeEscaped(table);
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
      throw new Error("Symbol can be added only after table name is set and before any column added");
    }
    const valueStr = value.toString();
    this.checkCapacity([name, valueStr], 2 + name.length + valueStr.length);
    this.write(",");
    validateColumnName(name, this.maxNameLength);
    this.writeEscaped(name);
    this.write("=");
    this.writeEscaped(valueStr);
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
    this.writeColumn(
      name,
      value,
      () => {
        this.checkCapacity([value], 2 + value.length);
        this.write('"');
        this.writeEscaped(value, true);
        this.write('"');
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
    this.writeColumn(
      name,
      value,
      () => {
        this.checkCapacity([], 1);
        this.write(value ? "t" : "f");
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
    this.writeColumn(
      name,
      value,
      () => {
        const valueStr = value.toString();
        this.checkCapacity([valueStr], valueStr.length);
        this.write(valueStr);
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
    this.writeColumn(name, value, () => {
      const valueStr = value.toString();
      this.checkCapacity([valueStr], 1 + valueStr.length);
      this.write(valueStr);
      this.write("i");
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
    this.writeColumn(name, value, () => {
      const valueMicros = timestampToMicros(BigInt(value), unit);
      const valueStr = valueMicros.toString();
      this.checkCapacity([valueStr], 1 + valueStr.length);
      this.write(valueStr);
      this.write("t");
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
      throw new Error("The row must have a symbol or column set before it is closed");
    }
    if (typeof timestamp !== "bigint" && !Number.isInteger(timestamp)) {
      throw new Error(`Designated timestamp must be an integer or BigInt, received ${timestamp}`);
    }
    const timestampNanos = timestampToNanos(BigInt(timestamp), unit);
    const timestampStr = timestampNanos.toString();
    this.checkCapacity([], 2 + timestampStr.length);
    this.write(" ");
    this.write(timestampStr);
    this.write("\n");
    this.pendingRowCount++;
    this.startNewRow();
    await this.automaticFlush();
  }

  /**
   * Closing the row without writing designated timestamp into the buffer of the sender. <br>
   * Designated timestamp will be populated by the server on this record.
   */
  async atNow() {
    if (!this.hasSymbols && !this.hasColumns) {
      throw new Error("The row must have a symbol or column set before it is closed");
    }
    this.checkCapacity([], 1);
    this.write("\n");
    this.pendingRowCount++;
    this.startNewRow();
    await this.automaticFlush();
  }

  private startNewRow() {
    this.endOfLastRow = this.position;
    this.hasTable = false;
    this.hasSymbols = false;
    this.hasColumns = false;
  }

  private async automaticFlush() {
    if (
        this.autoFlush &&
        this.pendingRowCount > 0 &&
        ((this.autoFlushRows > 0 &&
                this.pendingRowCount >= this.autoFlushRows) ||
            (this.autoFlushInterval > 0 &&
                Date.now() - this.lastFlushTime >= this.autoFlushInterval))
    ) {
      await this.flush();
    }
  }

  private checkCapacity(data: string[], base = 0) {
    let length = base;
    for (const str of data) {
      length += Buffer.byteLength(str, "utf8");
    }
    if (this.position + length > this.bufferSize) {
      let newSize = this.bufferSize;
      do {
        newSize += this.bufferSize;
      } while (this.position + length > newSize);
      this.resize(newSize);
    }
  }

  private compact() {
    if (this.endOfLastRow > 0) {
      this.buffer.copy(this.buffer, 0, this.endOfLastRow, this.position);
      this.position = this.position - this.endOfLastRow;
      this.endOfLastRow = 0;

      this.lastFlushTime = Date.now();
      this.pendingRowCount = 0;
    }
  }

  private writeColumn(
      name: string,
      value: unknown,
      writeValue: () => void,
      valueType?: string
  ) {
    if (typeof name !== "string") {
      throw new Error(`Column name must be a string, received ${typeof name}`);
    }
    if (valueType && typeof value !== valueType) {
      throw new Error(
          `Column value must be of type ${valueType}, received ${typeof value}`,
      );
    }
    if (!this.hasTable) {
      throw new Error("Column can be set only after table name is set");
    }
    this.checkCapacity([name], 2 + name.length);
    this.write(this.hasColumns ? "," : " ");
    validateColumnName(name, this.maxNameLength);
    this.writeEscaped(name);
    this.write("=");
    writeValue();
    this.hasColumns = true;
  }

  private write(data: string) {
    this.position += this.buffer.write(data, this.position);
    if (this.position > this.bufferSize) {
      throw new Error(
          `Buffer overflow [position=${this.position}, bufferSize=${this.bufferSize}]`,
      );
    }
  }

  private writeEscaped(data: string, quoted = false) {
    for (const ch of data) {
      if (ch > "\\") {
        this.write(ch);
        continue;
      }

      switch (ch) {
        case " ":
        case ",":
        case "=":
          if (!quoted) {
            this.write("\\");
          }
          this.write(ch);
          break;
        case "\n":
        case "\r":
          this.write("\\");
          this.write(ch);
          break;
        case '"':
          if (quoted) {
            this.write("\\");
          }
          this.write(ch);
          break;
        case "\\":
          this.write("\\\\");
          break;
        default:
          this.write(ch);
          break;
      }
    }
  }
}

export { Sender, DEFAULT_BUFFER_SIZE, DEFAULT_MAX_BUFFER_SIZE };
