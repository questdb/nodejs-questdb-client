/// <reference types="node" />
/** @classdesc Sender QuestDB client. */
export class Sender {
    /**
     * Creates an instance of Sender.
     *
     * @param {number} bufferSize - Size of the buffer used by the sender to collect rows, provided in bytes.
     * @param {{x: string, y: string, kid: string, kty: string, d: string, crv: string}} [jwk=null] - JWK for authentication, client is not authenticated if not provided. Server might reject the connection depending on configuration.
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
     * @param {number} port - Port number of endpoint.
     * @param {string} host - Host name or IP address of endpoint.
     * @param {{host: string, port: number, ca: Buffer}} [tlsOptions=null] - TLS CA for encryption, connection is not encrypted if not provided.
     */
    connect(port: number, host: string, tlsOptions?: {
        host: string;
        port: number;
        ca: Buffer;
    }): Promise<any>;
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
     * @param {{table: string, symbols: any[], columns: any[], timestamp: Nanos | bigint | number | string}} rows - The row or a list of rows to ingest.
     */
    rows(rows: {
        table: string;
        symbols: any[];
        columns: any[];
        timestamp: Nanos | bigint | number | string;
    }): void;
}
import { Buffer } from "buffer";
import { Nanos } from "./timestamp";
//# sourceMappingURL=sender.d.ts.map