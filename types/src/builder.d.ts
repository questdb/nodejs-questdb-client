/// <reference types="node" />
export class Builder {
    constructor(bufferSize: any);
    resize(bufferSize: any): void;
    bufferSize: any;
    buffer: Buffer;
    reset(): Builder;
    position: number;
    addTable(table: any): Builder;
    hasTable: boolean;
    addSymbol(name: any, value: any): Builder;
    hasSymbols: boolean;
    addString(name: any, value: any): Builder;
    addBoolean(name: any, value: any): Builder;
    addFloat(name: any, value: any): Builder;
    addInteger(name: any, value: any): Builder;
    addTimestamp(name: any, value: any): Builder;
    at(timestamp: any): void;
    atNow(): void;
    /**
     * Writes rows into the buffer.
     *
     * @param {Row[] | Row} rows - The row or a list of rows to ingest.
     */
    addRows(rows: Row[] | Row): void;
    /**
     * Writes a row into the buffer.
     *
     * @param {Row} row - The row to ingest.
     */
    addRow(row: Row): void;
    toBuffer(): Buffer;
}
import { Buffer } from "buffer";
import { Row } from "./row";
//# sourceMappingURL=builder.d.ts.map