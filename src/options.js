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
 * Sender configuration options.
 */
class SenderOptions {

    protocol;
    addr;
    host; // derived from addr
    port; // derived from addr

    // replaces `jwk` and `auth` options
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
    tls_roots; // not supported
    tls_roots_password; // not supported

    max_name_len;

    log;

    /**
     * Creates an instance of the Sender configuration options object.
     *
     * @param {SenderOptions} configurationString - Configuration string. <br>
     * <p>
     * Properties of the object:
     * <ul>
     *   <li>bufferSize: <i>number</i> - Size of the buffer used by the sender to collect rows, provided in bytes. <br>
     *   Optional, defaults to 8192 bytes. <br>
     *   If the value passed is not a number, the setting is ignored. </li>
     *   <li>copyBuffer: <i>boolean</i> - By default a new buffer is created for every flush() call, and the data to be sent to the server is copied into this new buffer.
     *   Setting the flag to <i>false</i> results in reusing the same buffer instance for each flush() call. Use this flag only if calls to the client are serialised. <br>
     *   Optional, defaults to <i>true</i>. <br>
     *   If the value passed is not a boolean, the setting is ignored. </li>
     *   <li>jwk: <i>{x: string, y: string, kid: string, kty: string, d: string, crv: string}</i> - JsonWebKey for authentication. <br>
     *   If not provided, client is not authenticated and server might reject the connection depending on configuration. <br>
     *   No type checks performed on the object passed. <br>
     *   <b>Deprecated</b>, please, use the <i>auth</i> option instead. </li>
     *   <li>auth: <i>{keyId: string, token: string}</i> - Authentication details, `keyId` is the username, `token` is the user's private key. <br>
     *   If not provided, client is not authenticated and server might reject the connection depending on configuration. </li>
     *   <li>log: <i>(level: 'error'|'warn'|'info'|'debug', message: string) => void</i> - logging function. <br>
     *   If not provided, default logging is used which writes to the console with logging level <i>info</i>. <br>
     *   If not a function passed, the setting is ignored. </li>
     * </ul>
     * </p>
     */
    constructor(configurationString = undefined) {
    }

    /**
     * Creates a Sender options object by parsing the provided configuration string.
     *
     * @param {string} configurationString - configuration string.
     *
     * @return {SenderOptions} configurationString - configuration string.
     */
    static fromConfig(configurationString) {
        return new SenderOptions().parseConfigurationString(configurationString);
    }

    static fromEnv() {
        return SenderOptions.fromConfig(process.env.QDB_CLIENT_CONF);
    }

    /**
     * Parses a configuration string. <br>
     * Throws an error if the format is invalid.
     *
     * @param {string} configurationString - Configuration string to parse.
     *
     * @return {SenderOptions} Returns with sender options.
     */
    parseConfigurationString(configurationString) {
        if (!configurationString) {
            throw new Error('Configuration string is missing');
        }

        const position = parseProtocol(this, configurationString);
        parseSettings(this, configurationString, position);
        parseAddress(this);
        parseBufferSizes(this);
        parseAutoFlushOptions(this);
        parseTlsOptions(this);
        parseRequestTimeoutOptions(this);
        parseMaxNameLength(this);
        parseCopyBuffer(this);
        return this;
    }
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
        throw new Error(`Missing \'=\' sign in \'${setting}\'`);
    }
    const key = setting.slice(0, equalsIndex);
    const value = setting.slice(equalsIndex + 1);
    validateConfigKey(key);
    validateConfigValue(key, value);
    options[key] = value;
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
            throw new Error(`Invalid protocol: \'${options.protocol}\', accepted protocols: \'http\', \'https\', \'tcp\', \'tcps\'`);
    }
    return index + 2;
}

const ValidConfigKeys = [
    'addr',
    'username', 'password', 'token', 'token_x', 'token_y',
    'auto_flush', 'auto_flush_rows', 'auto_flush_interval',
    'copy_buffer',
    'request_min_throughput', 'request_timeout', 'retry_timeout',
    'init_buf_size', 'max_buf_size',
    'max_name_len',
    'tls_verify', 'tls_roots', 'tls_ca', 'tls_roots_password'
];

function validateConfigKey(key) {
    if (!ValidConfigKeys.includes(key)) {
        throw new Error(`Unknown configuration key: \'${key}\'`);
    }
}

function validateConfigValue(key, value) {
    if (!value) {
        throw new Error(`Invalid configuration, value is not set for \'${key}\'`);
    }
    for (let i = 0; i < value.length; i++) {
        const unicode = value.codePointAt(i);
        if (unicode < 0x20 || (unicode > 0x7E && unicode < 0xA0)) {
            throw new Error(`Invalid configuration, control characters are not allowed: \'${value}\'`);
        }
    }
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
                throw new Error(`Invalid protocol: \'${options.protocol}\', accepted protocols: \'http\', \'https\', \'tcp\', \'tcps\'`);
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
        throw new Error(`Invalid port: \'${portStr}\'`);
    }
    if (!Number.isInteger(options.port) || options.port < 1) {
        throw new Error(`Invalid port: ${options.port}`);
    }
}

function parseBufferSizes(options) {
    if (options.init_buf_size) {
        const init_buf_size_str = options.init_buf_size;
        options.init_buf_size = Number(init_buf_size_str);
        if (isNaN(options.init_buf_size)) {
            throw new Error(`Invalid initial buffer size, not a number: \'${init_buf_size_str}\'`);
        }
        if (!Number.isInteger(options.init_buf_size) || options.init_buf_size < 1) {
            throw new Error(`Invalid initial buffer size: ${options.init_buf_size}`);
        }
    }

    if (options.max_buf_size) {
        const max_buf_size_str = options.max_buf_size;
        options.max_buf_size = Number(max_buf_size_str);
        if (isNaN(options.max_buf_size)) {
            throw new Error(`Invalid max buffer size, not a number: \'${max_buf_size_str}\'`);
        }
        if (!Number.isInteger(options.max_buf_size) || options.max_buf_size < 1) {
            throw new Error(`Invalid max buffer size: ${options.max_buf_size}`);
        }
    }
}

function parseAutoFlushOptions(options) {
    if (options.auto_flush) {
        const auto_flush_str = options.auto_flush;
        switch (auto_flush_str) {
            case ON:
                options.auto_flush = true;
                break;
            case OFF:
                options.auto_flush = false;
                break;
            default:
                throw new Error(`Invalid auto flush option: \'${auto_flush_str}\'`);
        }
    }

    if (options.auto_flush_rows) {
        const auto_flush_rows_str = options.auto_flush_rows;
        options.auto_flush_rows = Number(auto_flush_rows_str);
        if (isNaN(options.auto_flush_rows)) {
            throw new Error(`Invalid auto flush rows option, not a number: \'${auto_flush_rows_str}\'`);
        }
        if (!Number.isInteger(options.auto_flush_rows) || options.auto_flush_rows < 0) {
            throw new Error(`Invalid auto flush rows option: ${options.auto_flush_rows}`);
        }
    }

    if (options.auto_flush_interval) {
        const auto_flush_interval_str = options.auto_flush_interval;
        options.auto_flush_interval = Number(auto_flush_interval_str);
        if (isNaN(options.auto_flush_interval)) {
            throw new Error(`Invalid auto flush interval option, not a number: \'${auto_flush_interval_str}\'`);
        }
        if (!Number.isInteger(options.auto_flush_interval) || options.auto_flush_interval < 0) {
            throw new Error(`Invalid auto flush interval option: ${options.auto_flush_interval}`);
        }
    }
}

function parseTlsOptions(options) {
    if (options.tls_verify) {
        const tls_verify_str = options.tls_verify;
        switch (tls_verify_str) {
            case ON:
                options.tls_verify = true;
                break;
            case UNSAFE_OFF:
                options.tls_verify = false;
                break;
            default:
                throw new Error(`Invalid TLS verify option: \'${tls_verify_str}\'`);
        }
    }
    if (options.tls_roots || options.tls_roots_password) {
        throw new Error('\'tls_roots\' and \'tls_roots_password\' options are not supported, please, ' +
            'use the \'tls_ca\' option or the NODE_EXTRA_CA_CERTS environment variable instead');
    }
}

function parseRequestTimeoutOptions(options) {
    if (options.request_min_throughput) {
        const request_min_throughput_str = options.request_min_throughput;
        options.request_min_throughput = Number(request_min_throughput_str);
        if (isNaN(options.request_min_throughput)) {
            throw new Error(`Invalid request min throughput option, not a number: \'${request_min_throughput_str}\'`);
        }
        if (!Number.isInteger(options.request_min_throughput) || options.request_min_throughput < 1) {
            throw new Error(`Invalid request min throughput option: ${options.request_min_throughput}`);
        }
    }

    if (options.request_timeout) {
        const request_timeout_str = options.request_timeout;
        options.request_timeout = Number(request_timeout_str);
        if (isNaN(options.request_timeout)) {
            throw new Error(`Invalid request timeout option, not a number: \'${request_timeout_str}\'`);
        }
        if (!Number.isInteger(options.request_timeout) || options.request_timeout < 1) {
            throw new Error(`Invalid request timeout option: ${options.request_timeout}`);
        }
    }

    if (options.retry_timeout) {
        const retry_timeout_str = options.retry_timeout;
        options.retry_timeout = Number(retry_timeout_str);
        if (isNaN(options.retry_timeout)) {
            throw new Error(`Invalid retry timeout option, not a number: \'${retry_timeout_str}\'`);
        }
        if (!Number.isInteger(options.retry_timeout) || options.retry_timeout < 0) {
            throw new Error(`Invalid retry timeout option: ${options.retry_timeout}`);
        }
    }
}

function parseCopyBuffer(options) {
    if (options.copy_buffer) {
        const copy_buffer_str = options.copy_buffer;
        switch (copy_buffer_str) {
            case ON:
                options.copy_buffer = true;
                break;
            case OFF:
                options.copy_buffer = false;
                break;
            default:
                throw new Error(`Invalid copy buffer option: \'${copy_buffer_str}\'`);
        }
    }
}

function parseMaxNameLength(options) {
    if (options.max_name_len) {
        const max_name_len_str = options.max_name_len;
        options.max_name_len = Number(max_name_len_str);
        if (isNaN(options.max_name_len)) {
            throw new Error(`Invalid max name length option, not a number: \'${max_name_len_str}\'`);
        }
        if (!Number.isInteger(options.max_name_len) || options.max_name_len < 1) {
            throw new Error(`Invalid max name length option: ${options.max_name_len}`);
        }
    }
}

exports.SenderOptions = SenderOptions;
exports.HTTP = HTTP;
exports.HTTPS = HTTPS;
exports.TCP = TCP;
exports.TCPS = TCPS;
