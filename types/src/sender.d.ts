/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/** @classdesc
 * The QuestDB client's API provides methods to connect to the database, ingest data, and close the connection.
 * The supported protocols are HTTP and TCP. HTTP is preferred as it provides feedback in the HTTP response. <br>
 * Based on benchmarks HTTP also provides higher throughput, if configured to ingest data in bigger batches.
 * <p>
 * The client supports authentication. <br>
 * Authentication details can be passed to the Sender in its configuration options. <br>
 * The client support Basic username/password and Bearer token authentication methods when used with HTTP protocol,
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
 * <i>Sender.fromConfig(configString)</i> or <i>Sender.fromEnv()</i>).
 * If the Sender is created via its constructor, at least the SenderOptions configuration object should be
 * initialized from a configuration string to make sure that the parameters are validated. <br>
 * Detailed description of the Sender's configuration options can be found in
 * the <a href="SenderOptions.html">SenderOptions</a> documentation.
 * </p>
 */
export class Sender {
    /** @private */ private static DEFAULT_HTTP_AGENT;
    /** @private */ private static DEFAULT_HTTPS_AGENT;
    /** @private */ private static numOfSenders;
    /**
     * Creates a Sender options object by parsing the provided configuration string.
     *
     * @param {string} configurationString - Configuration string. <br>
     * @param {object} extraOptions - Optional extra configuration. <br>
     * 'log' is a logging function used by the <a href="Sender.html">Sender</a>.
     * Prototype: <i>(level: 'error'|'warn'|'info'|'debug', message: string) => void</i>. <br>
     * 'agent' is a custom http/https agent used by the <a href="Sender.html">Sender</a> when http/https transport is used. <br>
     * A <i>http.Agent</i> or <i>https.Agent</i> object is expected.
     *
     * @return {Sender} A Sender object initialized from the provided configuration string.
     */
    static fromConfig(configurationString: string, extraOptions?: object): Sender;
    /**
     * Creates a Sender options object by parsing the configuration string set in the <b>QDB_CLIENT_CONF</b> environment variable.
     *
     * @param {object} extraOptions - Optional extra configuration. <br>
     * 'log' is a logging function used by the <a href="Sender.html">Sender</a>.
     * Prototype: <i>(level: 'error'|'warn'|'info'|'debug', message: string) => void</i>. <br>
     * 'agent' is a custom http/https agent used by the <a href="Sender.html">Sender</a> when http/https transport is used. <br>
     * A <i>http.Agent</i> or <i>https.Agent</i> object is expected.
     *
     * @return {Sender} A Sender object initialized from the <b>QDB_CLIENT_CONF</b> environment variable.
     */
    static fromEnv(extraOptions?: object): Sender;
    /**
     * Creates an instance of Sender.
     *
     * @param {SenderOptions} options - Sender configuration object. <br>
     * See SenderOptions documentation for detailed description of configuration options. <br>
     */
    constructor(options?: SenderOptions);
    /** @private */ private http;
    /** @private */ private secure;
    /** @private */ private host;
    /** @private */ private port;
    /** @private */ private socket;
    /** @private */ private username;
    /** @private */ private password;
    /** @private */ private token;
    /** @private */ private tlsVerify;
    /** @private */ private tlsCA;
    /** @private */ private bufferSize;
    /** @private */ private maxBufferSize;
    /** @private */ private buffer;
    /** @private */ private toBuffer;
    /** @private */ private doResolve;
    /** @private */ private position;
    /** @private */ private endOfLastRow;
    /** @private */ private autoFlush;
    /** @private */ private autoFlushRows;
    /** @private */ private autoFlushInterval;
    /** @private */ private lastFlushTime;
    /** @private */ private pendingRowCount;
    /** @private */ private requestMinThroughput;
    /** @private */ private requestTimeout;
    /** @private */ private retryTimeout;
    /** @private */ private hasTable;
    /** @private */ private hasSymbols;
    /** @private */ private hasColumns;
    /** @private */ private maxNameLength;
    /** @private */ private log;
    /** @private */ private agent;
    jwk: any;
    /**
     * Extends the size of the sender's buffer. <br>
     * Can be used to increase the size of buffer if overflown.
     * The buffer's content is copied into the new buffer.
     *
     * @param {number} bufferSize - New size of the buffer used by the sender, provided in bytes.
     */
    resize(bufferSize: number): void;
    /**
     * Resets the buffer, data added to the buffer will be lost. <br>
     * In other words it clears the buffer and sets the writing position to the beginning of the buffer.
     *
     * @return {Sender} Returns with a reference to this sender.
     */
    reset(): Sender;
    /**
     * Creates a TCP connection to the database.
     *
     * @param {net.NetConnectOpts | tls.ConnectionOptions} connectOptions - Connection options, host and port are required.
     * @param {boolean} [secure = false] - If true connection will use TLS encryption.
     *
     * @return {Promise<boolean>} Resolves to true if client is connected.
     */
    connect(connectOptions?: net.NetConnectOpts | tls.ConnectionOptions, secure?: boolean): Promise<boolean>;
    /**
     * @ignore
     * @return {http.Agent} Returns the default http agent.
     */
    getDefaultHttpAgent(): http.Agent;
    /**
     * @ignore
     * @return {https.Agent} Returns the default https agent.
     */
    getDefaultHttpsAgent(): https.Agent;
    /**
     * Closes the TCP connection to the database. <br>
     * Data sitting in the Sender's buffer will be lost unless flush() is called before close().
     */
    close(): Promise<void>;
    /**
     * Sends the buffer's content to the database and compacts the buffer.
     * If the last row is not finished it stays in the sender's buffer.
     *
     * @return {Promise<boolean>} Resolves to true when there was data in the buffer to send.
     */
    flush(): Promise<boolean>;
    /**
     * @ignore
     * @return {Buffer} Returns a cropped buffer ready to send to the server or null if there is nothing to send.
     * The returned buffer is backed by the sender's buffer.
     */
    toBufferView(pos?: any): Buffer;
    /**
     * @ignore
     * @return {Buffer} Returns a cropped buffer ready to send to the server or null if there is nothing to send.
     * The returned buffer is a copy of the sender's buffer.
     */
    toBufferNew(pos?: any): Buffer;
    /**
     * Write the table name into the buffer of the sender.
     *
     * @param {string} table - Table name.
     * @return {Sender} Returns with a reference to this sender.
     */
    table(table: string): Sender;
    /**
     * Write a symbol name and value into the buffer of the sender.
     *
     * @param {string} name - Symbol name.
     * @param {any} value - Symbol value, toString() will be called to extract the actual symbol value from the parameter.
     * @return {Sender} Returns with a reference to this sender.
     */
    symbol(name: string, value: any): Sender;
    /**
     * Write a string column with its value into the buffer of the sender.
     *
     * @param {string} name - Column name.
     * @param {string} value - Column value, accepts only string values.
     * @return {Sender} Returns with a reference to this sender.
     */
    stringColumn(name: string, value: string): Sender;
    /**
     * Write a boolean column with its value into the buffer of the sender.
     *
     * @param {string} name - Column name.
     * @param {boolean} value - Column value, accepts only boolean values.
     * @return {Sender} Returns with a reference to this sender.
     */
    booleanColumn(name: string, value: boolean): Sender;
    /**
     * Write a float column with its value into the buffer of the sender.
     *
     * @param {string} name - Column name.
     * @param {number} value - Column value, accepts only number values.
     * @return {Sender} Returns with a reference to this sender.
     */
    floatColumn(name: string, value: number): Sender;
    /**
     * Write an integer column with its value into the buffer of the sender.
     *
     * @param {string} name - Column name.
     * @param {number} value - Column value, accepts only number values.
     * @return {Sender} Returns with a reference to this sender.
     */
    intColumn(name: string, value: number): Sender;
    /**
     * Write a timestamp column with its value into the buffer of the sender.
     *
     * @param {string} name - Column name.
     * @param {number | bigint} value - Epoch timestamp, accepts numbers or BigInts.
     * @param {string} [unit=us] - Timestamp unit. Supported values: 'ns' - nanoseconds, 'us' - microseconds, 'ms' - milliseconds. Defaults to 'us'.
     * @return {Sender} Returns with a reference to this sender.
     */
    timestampColumn(name: string, value: number | bigint, unit?: string): Sender;
    /**
     * Closing the row after writing the designated timestamp into the buffer of the sender.
     *
     * @param {number | bigint} timestamp - Designated epoch timestamp, accepts numbers or BigInts.
     * @param {string} [unit=us] - Timestamp unit. Supported values: 'ns' - nanoseconds, 'us' - microseconds, 'ms' - milliseconds. Defaults to 'us'.
     */
    at(timestamp: number | bigint, unit?: string): Promise<void>;
    /**
     * Closing the row without writing designated timestamp into the buffer of the sender. <br>
     * Designated timestamp will be populated by the server on this record.
     */
    atNow(): Promise<void>;
}
export const DEFAULT_BUFFER_SIZE: 65536;
export const DEFAULT_MAX_BUFFER_SIZE: 104857600;
import net = require("net");
import tls = require("tls");
import http = require("http");
import https = require("https");
import { Buffer } from "buffer";
import { SenderOptions } from "./options";
//# sourceMappingURL=sender.d.ts.map