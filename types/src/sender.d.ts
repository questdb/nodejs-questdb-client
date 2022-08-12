/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
/** @classdesc
 * The QuestDB client's API provides methods to connect to the database, ingest data and close the connection.
 * <p>
 * The client supports authentication. <br>
 * A JsonWebKey can be passed to the Sender in its constructor, the JsonWebKey will be used for authentication. <br>
 * If no JsonWebKey specified the client will not attempt to authenticate itself with the server. <br>
 * Details on how to configure QuestDB authentication: {@link https://questdb.io/docs/reference/api/ilp/authenticate}
 * </p>
 * <p>
 * The client also supports TLS encryption to provide a secure connection. <br>
 * However, QuestDB does not support TLS yet and requires an external reverse-proxy, such as Nginx to enable encryption.
 * </p>
 */
export class Sender {
    /**
     * Creates an instance of Sender.
     *
     * @param {number} bufferSize - Size of the buffer used by the sender to collect rows, provided in bytes.
     * @param {{x: string, y: string, kid: string, kty: string, d: string, crv: string}} [jwk = undefined] - JWK for authentication, client is not authenticated if not provided. <br> Server might reject the connection depending on configuration.
     */
    constructor(bufferSize: number, jwk?: {
        x: string;
        y: string;
        kid: string;
        kty: string;
        d: string;
        crv: string;
    });
    /** @private */ private jwk;
    /** @private */ private socket;
    /** @private */ private bufferSize;
    /** @private */ private buffer;
    /** @private */ private position;
    /** @private */ private hasTable;
    /** @private */ private hasSymbols;
    /** @private */ private hasColumns;
    /**
     * Reinitializes the buffer of the sender. <br>
     * Can be used to increase the size of buffer if overflown.
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
     * Creates a connection to the database.
     *
     * @param {NetConnectOpts | ConnectionOptions} options - Connection options, host and port are required.
     * @param {boolean} [secure = false] - If true connection will use TLS encryption.
     */
    connect(options: NetConnectOpts | ConnectionOptions, secure?: boolean): Promise<any>;
    /**
     * Closes the connection to the database. <br>
     * Data sitting in the Sender's buffer will be lost unless flush() is called before close().
     */
    close(): Promise<any>;
    /**
     * Sends the buffer's content to the database and clears the buffer.
     */
    flush(): Promise<any>;
    /**
     * @ignore
     * @return {Buffer} Returns a cropped buffer ready to send to the server.
     */
    toBuffer(): Buffer;
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
     * @param {number} value - Column value, accepts only number objects.
     * @return {Sender} Returns with a reference to this sender.
     */
    timestampColumn(name: string, value: number): Sender;
    /**
     * Closing the row after writing the designated timestamp into the buffer of the sender.
     *
     * @param {string} timestamp - A string represents the designated timestamp in nanoseconds.
     */
    at(timestamp: string): void;
    /**
     * Closing the row without writing designated timestamp into the buffer of the sender. <br>
     * Designated timestamp will be populated by the server on this record.
     */
    atNow(): void;
}
import { NetConnectOpts } from "net";
import { ConnectionOptions } from "tls";
import { Buffer } from "buffer";
//# sourceMappingURL=sender.d.ts.map