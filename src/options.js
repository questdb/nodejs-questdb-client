'use strict';

const HTTP_PORT = 9000;
const TCP_PORT = 9009;

const HTTP = 'http';
const HTTPS = 'https';
const TCP = 'tcp';
const TCPS = 'tcps';

const ON = 'on';
const OFF = 'off';
const UNSAFE_OFF = 'unsafe_off';

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
 * If the TCP transport used with JWK token authentication, then should be accompanied by the <i>token</i> option.
 * </li>
 * <li> password: <i>string</i> - Password for HTTP Basic authentication, should be accompanied by the <i>username</i> option.
 * </li>
 * <li> token: <i>string</i> - In case of HTTP Bearer token authentication it contains the bearer token. <br>
 * If the TCP transport used with JWK token authentication, then it contains the private key part of the JWK token,
 * and it should be accompanied by the <i>username</i> option.
 * </li>
 * </ul>
 * <br>
 * TLS options
 * <ul>
 * <li> tls_verify: <i>enum, accepted values: on, unsafe_off</i> - When the HTTPS or TCPS protocols are selected, TLS encryption is used. <br>
 * The Sender verifies the server's certificate, this check can be disabled by setting this option to <i>off</i>. Can be useful in
 * non-production environments where self-signed certificates might be used, but generally not recommended to use.
 * </li>
 * <li> tls_ca: <i>string</i> - Path to a file containing the root CA's certificate in PEM format. <br>
 * Can be useful when self-signed certificates are used, otherwise should not be set.
 * </li>
 * </ul>
 * <br>
 * Auto flush options
 * <ul>
 * <li> auto_flush: <i>enum, accepted values: on, off</i> - The Sender automatically flushes the buffer by default, this can be switched off
 * by setting this option to <i>off</i>. <br>
 * When disabled, the flush() method of the Sender has to be called explicitly to make sure data is sent to the server. <br>
 * Manual buffer flushing can be useful, when we want to use transactions. When the HTTP protocol is used, each flush results in a single HTTP
 * request, which in turn is a single transaction on the server side. The transaction either succeeds, and all rows sent in the request are
 * inserted, or it fails, and none of the rows makes into the database.
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
 * <li> copy_buffer: <i>enum, accepted values: on, off</i> - By default the Sender creates a new buffer for every flush() call,
 * and the data to be sent to the server is copied into this new buffer.
 * Setting the flag to <i>off</i> results in reusing the same buffer instance for each flush() call. <br>
 * Use this flag only if calls to the client are serialised.
 * </li>
 * </ul>
 */
class SenderOptions {

    protocol;
    addr;
    host; // derived from addr
    port; // derived from addr

    // replaces `auth` and `jwk` options
    username;
    password;
    token;
    token_x; // allowed, but ignored
    token_y; // allowed, but ignored

    auto_flush;
    auto_flush_rows;
    auto_flush_interval;

    // replaces `copyBuffer` option
    copy_buffer;

    request_min_throughput;
    request_timeout;
    retry_timeout;

    // replaces `bufferSize` option
    init_buf_size;
    max_buf_size;

    tls_verify;
    tls_ca;
    tls_roots;          // not supported
    tls_roots_password; // not supported

    max_name_len;

    log;

    /**
     * Creates a Sender options object by parsing the provided configuration string.
     *
     * @param {string} configurationString - Configuration string. <br>
     * @param {function} log - Optional logging function used by the <a href="Sender.html">Sender</a>. <br>
     * Prototype: <i>(level: 'error'|'warn'|'info'|'debug', message: string) => void</i>.
     */
    constructor(configurationString, log = undefined) {
        parseConfigurationString(this, configurationString);

        if (log && typeof log !== 'function') {
            throw new Error('Invalid logging function');
        }
        this.log = log;
    }

    /**
     * Creates a Sender options object by parsing the provided configuration string.
     *
     * @param {string} configurationString - Configuration string. <br>
     * @param {function} log - Optional logging function used by the <a href="Sender.html">Sender</a>. <br>
     * Prototype: <i>(level: 'error'|'warn'|'info'|'debug', message: string) => void</i>.
     *
     * @return {SenderOptions} A Sender configuration object initialized from the provided configuration string.
     */
    static fromConfig(configurationString, log = undefined) {
        return new SenderOptions(configurationString, log);
    }

    /**
     * Creates a Sender options object by parsing the configuration string set in the <b>QDB_CLIENT_CONF</b> environment variable.
     *
     * @param {function} log - Optional logging function used by the <a href="Sender.html">Sender</a>. <br>
     * Prototype: <i>(level: 'error'|'warn'|'info'|'debug', message: string) => void</i>.
     *
     * @return {SenderOptions} A Sender configuration object initialized from the <b>QDB_CLIENT_CONF</b> environment variable.
     */
    static fromEnv(log = undefined) {
        return SenderOptions.fromConfig(process.env.QDB_CLIENT_CONF, log);
    }
}

function parseConfigurationString(options, configString) {
    if (!configString) {
        throw new Error('Configuration string is missing or empty');
    }

    const position = parseProtocol(options, configString);
    parseSettings(options, configString, position);
    parseAddress(options);
    parseBufferSizes(options);
    parseAutoFlushOptions(options);
    parseTlsOptions(options);
    parseRequestTimeoutOptions(options);
    parseMaxNameLength(options);
    parseCopyBuffer(options);
}

function parseSettings(options, configString, position) {
    let index = configString.indexOf(';', position);
    while (index > -1) {
        if (index + 1 < configString.length && configString.charAt(index + 1) === ';') {
            index = configString.indexOf(';', index + 2);
            continue;
        }

        parseSetting(options, configString, position, index);

        position = index + 1;
        index = configString.indexOf(';', position);
    }
    if (position < configString.length) {
        parseSetting(options, configString, position, configString.length);
    }
}

function parseSetting(options, configString, position, index) {
    const setting = configString.slice(position, index).replaceAll(';;', ';');
    const equalsIndex = setting.indexOf('=');
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
    'addr',
    'username', 'password', 'token', 'token_x', 'token_y',
    'auto_flush', 'auto_flush_rows', 'auto_flush_interval',
    'copy_buffer',
    'request_min_throughput', 'request_timeout', 'retry_timeout',
    'init_buf_size', 'max_buf_size',
    'max_name_len',
    'tls_verify', 'tls_ca', 'tls_roots', 'tls_roots_password'
];

function validateConfigKey(key) {
    if (!ValidConfigKeys.includes(key)) {
        throw new Error(`Unknown configuration key: '${key}'`);
    }
}

function validateConfigValue(key, value) {
    if (!value) {
        throw new Error(`Invalid configuration, value is not set for '${key}'`);
    }
    for (let i = 0; i < value.length; i++) {
        const unicode = value.codePointAt(i);
        if (unicode < 0x20 || (unicode > 0x7E && unicode < 0xA0)) {
            throw new Error(`Invalid configuration, control characters are not allowed: '${value}'`);
        }
    }
}

function parseProtocol(options, configString) {
    let index = configString.indexOf('::');
    if (index < 0) {
        throw new Error('Missing protocol, configuration string format: \'protocol::key1=value1;key2=value2;key3=value3;\'');
    }

    options.protocol = configString.slice(0, index);
    switch (options.protocol) {
        case HTTP:
        case HTTPS:
        case TCP:
        case TCPS:
            break;
        default:
            throw new Error(`Invalid protocol: '${options.protocol}', accepted protocols: 'http', 'https', 'tcp', 'tcps'`);
    }
    return index + 2;
}

function parseAddress(options) {
    if (!options.addr) {
        throw new Error('Invalid configuration, \'addr\' is required');
    }

    const index = options.addr.indexOf(':');
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
                throw new Error(`Invalid protocol: '${options.protocol}', accepted protocols: 'http', 'https', 'tcp', 'tcps'`);
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

function parseBufferSizes(options) {
    parseInteger(options, 'init_buf_size', 'initial buffer size', 1);
    parseInteger(options, 'max_buf_size', 'max buffer size', 1);
}

function parseAutoFlushOptions(options) {
    parseBoolean(options, 'auto_flush', 'auto flush');
    parseInteger(options, 'auto_flush_rows', 'auto flush rows', 0);
    parseInteger(options, 'auto_flush_interval', 'auto flush interval', 0);
}

function parseTlsOptions(options) {
    parseBoolean(options, 'tls_verify', 'TLS verify', UNSAFE_OFF);

    if (options.tls_roots || options.tls_roots_password) {
        throw new Error('\'tls_roots\' and \'tls_roots_password\' options are not supported, please, ' +
            'use the \'tls_ca\' option or the NODE_EXTRA_CA_CERTS environment variable instead');
    }
}

function parseRequestTimeoutOptions(options) {
    parseInteger(options, 'request_min_throughput', 'request min throughput', 1);
    parseInteger(options, 'request_timeout', 'request timeout', 1);
    parseInteger(options, 'retry_timeout', 'retry timeout', 0);
}

function parseMaxNameLength(options) {
    parseInteger(options, 'max_name_len', 'max name length', 1);
}

function parseCopyBuffer(options) {
    parseBoolean(options, 'copy_buffer', 'copy buffer');
}

function parseBoolean(options, property, description, offValue = OFF) {
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

function parseInteger(options, property, description, lowerBound) {
    if (options[property]) {
        const property_str = options[property];
        options[property] = Number(property_str);
        if (isNaN(options[property])) {
            throw new Error(`Invalid ${description} option, not a number: '${property_str}'`);
        }
        if (!Number.isInteger(options[property]) || options[property] < lowerBound) {
            throw new Error(`Invalid ${description} option: ${options[property]}`);
        }
    }
}

exports.SenderOptions = SenderOptions;
exports.HTTP = HTTP;
exports.HTTPS = HTTPS;
exports.TCP = TCP;
exports.TCPS = TCPS;
