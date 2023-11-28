'use strict';

/* eslint-disable no-unused-vars */

const { Buffer } = require('buffer');
const { log } = require('./logging');
const { validateTableName, validateColumnName } = require('./validation');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const DEFAULT_BUFFER_SIZE = 8192;

// an arbitrary public key, not used in authentication
// only used to construct a valid JWK token which is accepted by the crypto API
const PUBLIC_KEY = {
    x: 'aultdA0PjhD_cWViqKKyL5chm6H1n-BiZBo_48T-uqc',
    y: '__ptaol41JWSpTTL525yVEfzmY8A6Vi_QrW1FjKcHMg'
};

/** @classdesc
 * The QuestDB client's API provides methods to connect to the database, ingest data, and close the connection.
 * <p>
 * The client supports authentication. <br>
 * Authentication details can be passed to the Sender in its configuration options. <br>
 * The user id and the user's private key are required for authentication. <br>
 * More details on configuration options can be found in the description of the constructor. <br>
 * Please, note that authentication is enabled by default in QuestDB Enterprise only. <br>
 * Details on how to configure authentication in the open source version of QuestDB: {@link https://questdb.io/docs/reference/api/ilp/authenticate}
 * </p>
 * <p>
 * The client also supports TLS encryption to provide a secure connection. <br>
 * Please, note that the open source version of QuestDB does not support TLS, and requires an external reverse-proxy, such as Nginx to enable encryption.
 * </p>
 */
class Sender {

    /** @private */ jwk;
    /** @private */ socket;
    /** @private */ bufferSize;
    /** @private */ buffer;
    /** @private */ toBuffer;
    /** @private */ doResolve;
    /** @private */ position;
    /** @private */ endOfLastRow;
    /** @private */ hasTable;
    /** @private */ hasSymbols;
    /** @private */ hasColumns;
    /** @private */ log;

    /**
     * Creates an instance of Sender.
     *
     * @param {object} options - Configuration options. <br>
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
    constructor(options = undefined) {
        this.jwk = constructJwk(options);
        const noCopy = options && typeof options.copyBuffer === 'boolean' && !options.copyBuffer;
        this.toBuffer = noCopy ? this.toBufferView : this.toBufferNew;
        this.doResolve = noCopy
            ? resolve => {
                    compact(this);
                    resolve(true);
            }
            : resolve => resolve(true);
        this.log = options && typeof options.log === 'function' && options.log ? options.log : log;
        this.resize(options && typeof options.bufferSize === 'number' && options.bufferSize ? options.bufferSize : DEFAULT_BUFFER_SIZE);
        this.reset();
    }

    /**
     * Extends the size of the sender's buffer. <br>
     * Can be used to increase the size of buffer if overflown.
     * The buffer's content is copied into the new buffer.
     *
     * @param {number} bufferSize - New size of the buffer used by the sender, provided in bytes.
     */
    resize(bufferSize) {
        this.bufferSize = bufferSize;
        const newBuffer = Buffer.alloc(this.bufferSize + 1, 0, 'utf8');
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
    reset() {
        this.position = 0;
        startNewRow(this);
        return this;
    }

    /**
     * Creates a connection to the database.
     *
     * @param {net.NetConnectOpts | tls.ConnectionOptions} options - Connection options, host and port are required.
     * @param {boolean} [secure = false] - If true connection will use TLS encryption.
     *
     * @return {Promise<boolean>} Resolves to true if client is connected.
     */
    connect(options, secure = false) {
        let self = this;

        return new Promise((resolve, reject) => {
            let authenticated = false;
            let data;

            if (this.socket) {
                throw new Error('Sender connected already');
            }
            this.socket = !secure
                ? net.connect(options)
                : tls.connect(options, async () => {
                    if (!self.socket.authorized) {
                        reject(new Error('Problem with server\'s certificate'));
                        await self.close();
                    }
                });
            this.socket.setKeepAlive(true);

            this.socket.on('data', async raw => {
                data = !data ? raw : Buffer.concat([data, raw]);
                if (!authenticated) {
                    authenticated = await authenticate(self, data);
                    if (authenticated) {
                        resolve(true);
                    }
                } else {
                    this.log('warn', `Received unexpected data: ${data}`);
                }
            })
            .on('ready', async () => {
                this.log('info', `Successfully connected to ${options.host}:${options.port}`);
                if (self.jwk) {
                    this.log('info', `Authenticating with ${options.host}:${options.port}`);
                    await self.socket.write(`${self.jwk.kid}\n`, err => {
                        if (err) {
                            reject(err);
                        }
                    });
                } else {
                    authenticated = true;
                    resolve(true);
                }
            })
            .on('error', err => {
                this.log('error', err);
                reject(err);
            });
        });
    }

    /**
     * Closes the connection to the database. <br>
     * Data sitting in the Sender's buffer will be lost unless flush() is called before close().
     */
    async close() {
        const address = this.socket.remoteAddress;
        const port = this.socket.remotePort;
        this.socket.destroy();
        this.log('info', `Connection to ${address}:${port} is closed`);
    }

    /**
     * Sends the buffer's content to the database and compacts the buffer.
     * If the last row is not finished it stays in the sender's buffer.
     *
     * @return {Promise<boolean>} Resolves to true if there was data in the buffer to send.
     */
    async flush() {
        const data = this.toBuffer(this.endOfLastRow);
        if (!data) {
            return false;
        }
        return new Promise((resolve, reject) => {
            this.socket.write(data, err => {
                err ? reject(err) : this.doResolve(resolve);
            });
        });
    }

    /**
     * @ignore
     * @return {Buffer} Returns a cropped buffer ready to send to the server or null if there is nothing to send.
     * The returned buffer is backed by the sender's buffer.
     */
    toBufferView(pos = this.position) {
        return pos > 0
            ? this.buffer.subarray(0, pos)
            : null;
    }

    /**
     * @ignore
     * @return {Buffer} Returns a cropped buffer ready to send to the server or null if there is nothing to send.
     * The returned buffer is a copy of the sender's buffer.
     */
    toBufferNew(pos = this.position) {
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
    table(table) {
        if (typeof table !== 'string') {
            throw new Error(`Table name must be a string, received ${typeof table}`);
        }
        if (this.hasTable) {
            throw new Error('Table name has already been set');
        }
        validateTableName(table);
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
    symbol(name, value) {
        if (typeof name !== 'string') {
            throw new Error(`Symbol name must be a string, received ${typeof name}`);
        }
        if (!this.hasTable || this.hasColumns) {
            throw new Error('Symbol can be added only after table name is set and before any column added');
        }
        const valueStr = value.toString();
        checkCapacity(this, [name, valueStr], 2 + name.length + valueStr.length);
        write(this, ',');
        validateColumnName(name);
        writeEscaped(this, name);
        write(this, '=');
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
    stringColumn(name, value) {
        writeColumn(this, name, value, () => {
            checkCapacity(this, [value], 2 + value.length);
            write(this, '"');
            writeEscaped(this, value, true);
            write(this, '"');
        }, 'string');
        return this;
    }

    /**
     * Write a boolean column with its value into the buffer of the sender.
     *
     * @param {string} name - Column name.
     * @param {boolean} value - Column value, accepts only boolean values.
     * @return {Sender} Returns with a reference to this sender.
     */
    booleanColumn(name, value) {
        writeColumn(this, name, value, () => {
            checkCapacity(this, [], 1);
            write(this, value ? 't' : 'f');
        }, 'boolean');
        return this;
    }

    /**
     * Write a float column with its value into the buffer of the sender.
     *
     * @param {string} name - Column name.
     * @param {number} value - Column value, accepts only number values.
     * @return {Sender} Returns with a reference to this sender.
     */
    floatColumn(name, value) {
        writeColumn(this, name, value, () => {
            const valueStr = value.toString();
            checkCapacity(this, [valueStr], valueStr.length);
            write(this, valueStr);
        }, 'number');
        return this;
    }

    /**
     * Write an integer column with its value into the buffer of the sender.
     *
     * @param {string} name - Column name.
     * @param {number} value - Column value, accepts only number values.
     * @return {Sender} Returns with a reference to this sender.
     */
    intColumn(name, value) {
        if (!Number.isInteger(value)) {
            throw new Error(`Value must be an integer, received ${value}`);
        }
        writeColumn(this, name, value, () => {
            const valueStr = value.toString();
            checkCapacity(this, [valueStr], 1 + valueStr.length);
            write(this, valueStr);
            write(this, 'i');
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
    timestampColumn(name, value, unit = 'us') {
        if (typeof value !== 'bigint' && !Number.isInteger(value)) {
            throw new Error(`Value must be an integer or BigInt, received ${value}`);
        }
        writeColumn(this, name, value, () => {
            const valueMicros = timestampToMicros(BigInt(value), unit);
            const valueStr = valueMicros.toString();
            checkCapacity(this, [valueStr], 1 + valueStr.length);
            write(this, valueStr);
            write(this, 't');
        });
        return this;
    }

    /**
     * Closing the row after writing the designated timestamp into the buffer of the sender.
     *
     * @param {number | bigint} timestamp - Designated epoch timestamp, accepts numbers or BigInts.
     * @param {string} [unit=us] - Timestamp unit. Supported values: 'ns' - nanoseconds, 'us' - microseconds, 'ms' - milliseconds. Defaults to 'us'.
     */
    at(timestamp, unit = 'us') {
        if (!this.hasSymbols && !this.hasColumns) {
            throw new Error('The row must have a symbol or column set before it is closed');
        }
        if (typeof timestamp !== 'bigint' && !Number.isInteger(timestamp)) {
            throw new Error(`Designated timestamp must be an integer or BigInt, received ${timestamp}`);
        }
        const timestampNanos = timestampToNanos(BigInt(timestamp), unit);
        const timestampStr = timestampNanos.toString();
        checkCapacity(this, [], 2 + timestampStr.length);
        write(this, ' ');
        write(this, timestampStr);
        write(this, '\n');
        startNewRow(this);
    }

    /**
     * Closing the row without writing designated timestamp into the buffer of the sender. <br>
     * Designated timestamp will be populated by the server on this record.
     */
    atNow() {
        if (!this.hasSymbols && !this.hasColumns) {
            throw new Error('The row must have a symbol or column set before it is closed');
        }
        checkCapacity(this, [], 1);
        write(this, '\n');
        startNewRow(this);
    }
}

async function authenticate(sender, challenge) {
    // Check for trailing \n which ends the challenge
    if (challenge.slice(-1).readInt8() === 10) {
        const keyObject = await crypto.createPrivateKey(
            {'key': sender.jwk, 'format': 'jwk'}
        );
        const signature = await crypto.sign(
            'RSA-SHA256',
            challenge.slice(0, challenge.length - 1),
            keyObject
        );

        return new Promise((resolve, reject) => {
            sender.socket.write(`${Buffer.from(signature).toString('base64')}\n`, err => {
                err ? reject(err) : resolve(true);
            });
        });
    }
    return false;
}

function startNewRow(sender) {
    sender.endOfLastRow = sender.position;
    sender.hasTable = false;
    sender.hasSymbols = false;
    sender.hasColumns = false;
}

function checkCapacity(sender, data, base = 0) {
    let length = base;
    for (const str of data) {
        length += Buffer.byteLength(str, 'utf8');
    }
    if (sender.position + length > sender.bufferSize) {
        let newSize = sender.bufferSize;
        do {
            newSize += sender.bufferSize;
        } while(sender.position + length > newSize);
        sender.resize(newSize);
    }
}

function compact(sender) {
    if (sender.endOfLastRow > 0) {
        sender.buffer.copy(sender.buffer, 0, sender.endOfLastRow, sender.position);
        sender.position = sender.position - sender.endOfLastRow;
        sender.endOfLastRow = 0;
    }
}

function writeColumn(sender, name, value, writeValue, valueType) {
    if (typeof name !== 'string') {
        throw new Error(`Column name must be a string, received ${typeof name}`);
    }
    if (valueType != null && typeof value !== valueType) {
        throw new Error(`Column value must be of type ${valueType}, received ${typeof value}`);
    }
    if (!sender.hasTable) {
        throw new Error('Column can be set only after table name is set');
    }
    checkCapacity(sender, [name], 2 + name.length);
    write(sender, sender.hasColumns ? ',' : ' ');
    validateColumnName(name);
    writeEscaped(sender, name);
    write(sender, '=');
    writeValue();
    sender.hasColumns = true;
}

function write(sender, data) {
    sender.position += sender.buffer.write(data, sender.position);
    if (sender.position > sender.bufferSize) {
        throw new Error(`Buffer overflow [position=${sender.position}, bufferSize=${sender.bufferSize}]`);
    }
}

function writeEscaped(sender, data, quoted = false) {
    for (const ch of data) {
        if (ch > '\\') {
            write(sender, ch);
            continue;
        }

        switch (ch) {
            case ' ':
            case ',':
            case '=':
                if (!quoted) {
                    write(sender, '\\');
                }
                write(sender, ch);
                break;
            case '\n':
            case '\r':
                write(sender, '\\');
                write(sender, ch);
                break;
            case '"':
                if (quoted) {
                    write(sender, '\\');
                }
                write(sender, ch);
                break;
            case '\\':
                write(sender, '\\\\');
                break;
            default:
                write(sender, ch);
                break;
        }
    }
}

function timestampToMicros(timestamp, unit) {
    switch (unit) {
        case 'ns':
            return timestamp / 1000n;
        case 'us':
            return timestamp;
        case 'ms':
            return timestamp * 1000n;
        default:
            throw new Error('Unknown timestamp unit: ' + unit);
    }
}

function timestampToNanos(timestamp, unit) {
    switch (unit) {
        case 'ns':
            return timestamp;
        case 'us':
            return timestamp * 1000n;
        case 'ms':
            return timestamp * 1000_000n;
        default:
            throw new Error('Unknown timestamp unit: ' + unit);
    }
}

function constructJwk(options) {
    if (options) {
        if (options.auth) {
            if (!options.auth.keyId) {
                throw new Error('Missing username, please, specify the \'keyId\' property of the \'auth\' config option. ' +
                    'For example: new Sender({auth: {keyId: \'username\', token: \'private key\'}})');
            }
            if (typeof options.auth.keyId !== 'string') {
                throw new Error('Please, specify the \'keyId\' property of the \'auth\' config option as a string. ' +
                    'For example: new Sender({auth: {keyId: \'username\', token: \'private key\'}})');
            }
            if (!options.auth.token) {
                throw new Error('Missing private key, please, specify the \'token\' property of the \'auth\' config option. ' +
                    'For example: new Sender({auth: {keyId: \'username\', token: \'private key\'}})');
            }
            if (typeof options.auth.token !== 'string') {
                throw new Error('Please, specify the \'token\' property of the \'auth\' config option as a string. ' +
                    'For example: new Sender({auth: {keyId: \'username\', token: \'private key\'}})');
            }

            return {
                kid: options.auth.keyId,
                d: options.auth.token,
                ...PUBLIC_KEY,
                kty: 'EC',
                crv: 'P-256'
            };
        } else {
            return options.jwk;
        }
    }
    return undefined;
}

exports.Sender = Sender;
exports.DEFAULT_BUFFER_SIZE = DEFAULT_BUFFER_SIZE;
