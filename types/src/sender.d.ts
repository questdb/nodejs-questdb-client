/// <reference types="node" />
/** @classdesc Sender QuestDB client. */
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
     * @param {{host: string, port: number, ca: Buffer}} options - Connection options, host and port are required.
     * @param {boolean} [secure = false] - If true connection will use TLS encryption.
     */
    connect(options: {
        host: string;
        port: number;
        ca: Buffer;
    }, secure?: boolean): Promise<any>;
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
import { Buffer } from "buffer";
import { Row } from "./row";
//# sourceMappingURL=sender.d.ts.map