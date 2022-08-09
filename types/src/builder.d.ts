/// <reference types="node" />
/** @classdesc Represents a database row. */
export class Row {
    /**
     * Creates a Row object.
     *
     * @param {string} table - The name of the table.
     * @param {object} [symbols = undefined] - Symbols of the row in the form of {colName1: value1, colName2: value2...}.
     * @param {object} [columns = undefined] - Columns of the row in the form of {colName1: value1, colName2: value2...}.
     * @param {Nanos | bigint | number | string} [timestamp = undefined] - The designated timestamp.
     */
    constructor(table: string, symbols?: object, columns?: object, timestamp?: Nanos | bigint | number | string);
    table: string;
    symbols: any;
    columns: any;
    timestamp: string | number | bigint | Nanos;
}
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
import { Nanos } from "./timestamp";
import { Buffer } from "buffer";
//# sourceMappingURL=builder.d.ts.map