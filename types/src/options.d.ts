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
 * <li> max_name_len: <i>integer</i> - The maximum length of a table or column name, the Sender defaults this parameter to 127. <br>
 * Recommended to use the same setting as the server, which also uses 127 by default.
 * </li>
 * <li> copy_buffer: <i>enum, accepted values: on, off</i> - By default, the Sender creates a new buffer for every flush() call,
 * and the data to be sent to the server is copied into this new buffer.
 * Setting the flag to <i>off</i> results in reusing the same buffer instance for each flush() call. <br>
 * Use this flag only if calls to the client are serialised.
 * </li>
 * </ul>
 */
export class SenderOptions {
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
    static fromConfig(configurationString: string, extraOptions?: object): SenderOptions;
    /**
     * Creates a Sender options object by parsing the configuration string set in the <b>QDB_CLIENT_CONF</b> environment variable.
     *
     * @param {object} extraOptions - Optional extra configuration. <br>
     * - 'log' is a logging function used by the <a href="Sender.html">Sender</a>. <br>
     * Prototype: <i>(level: 'error'|'warn'|'info'|'debug', message: string) => void</i>. <br>
     * - 'agent' is a custom http/https agent used by the <a href="Sender.html">Sender</a> when http/https transport is used. <br>
     * A <i>http.Agent</i> or <i>https.Agent</i> object is expected.
     *
     * @return {SenderOptions} A Sender configuration object initialized from the <b>QDB_CLIENT_CONF</b> environment variable.
     */
    static fromEnv(extraOptions?: object): SenderOptions;
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
    constructor(configurationString: string, extraOptions?: object);
    protocol: any;
    addr: any;
    host: any;
    port: any;
    username: any;
    password: any;
    token: any;
    token_x: any;
    token_y: any;
    auto_flush: any;
    auto_flush_rows: any;
    auto_flush_interval: any;
    copy_buffer: any;
    request_min_throughput: any;
    request_timeout: any;
    retry_timeout: any;
    init_buf_size: any;
    max_buf_size: any;
    tls_verify: any;
    tls_ca: any;
    tls_roots: any;
    tls_roots_password: any;
    max_name_len: any;
    log: any;
    agent: any;
}
export const HTTP: "http";
export const HTTPS: "https";
export const TCP: "tcp";
export const TCPS: "tcps";
//# sourceMappingURL=options.d.ts.map