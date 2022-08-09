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
     * @param {{x: string, y: string, kid: string, kty: string, d: string, crv: string}} [jwk = undefined] - JWK for authentication, client is not authenticated if not provided. Server might reject the connection depending on configuration.
     */
    constructor(bufferSize: number, jwk?: {
        x: string;
        y: string;
        kid: string;
        kty: string;
        d: string;
        crv: string;
    });
    /** @private */
    private builder;
    /** @private */
    private jwk;
    /**
     * Creates a connection to the database.
     *
     * @param {NetConnectOpts | ConnectionOptions} options - Connection options, host and port are required.
     * @param {boolean} [secure = false] - If true connection will use TLS encryption.
     */
    connect(options: NetConnectOpts | ConnectionOptions, secure?: boolean): Promise<any>;
    /** @private */
    private socket;
    /**
     * Closes the connection to the database.
     */
    close(): Promise<any>;
    /**
     * Sends the buffer's content to the database and clears the buffer.
     */
    flush(): Promise<any>;
    /**
     * Writes rows into the buffer.
     *
     * @param {Row[] | Row} rows - The row or a list of rows to ingest.
     */
    rows(rows: Row[] | Row): void;
}
import { NetConnectOpts } from "net";
import { ConnectionOptions } from "tls";
import { Row } from "./row";
//# sourceMappingURL=sender.d.ts.map