/// <reference types="node" />
/** @classdesc Builder for the QuestDB client. */
export class Builder {
    /**
     * Creates an instance of Builder.
     *
     * @param {number} bufferSize - Size of the buffer used by the builder, provided in bytes.
     */
    constructor(bufferSize: number);
    /**
     * Reinitializes the buffer of the builder. <br>
     * Can be used to increase the size of buffer if overflown.
     *
     * @param {number} bufferSize - New size of the buffer used by the builder, provided in bytes.
     */
    resize(bufferSize: number): void;
    bufferSize: number;
    buffer: Buffer;
    /**
     * Resets the buffer, data added to the buffer will be lost. <br>
     * In other words it clears the buffer and sets the writing position to the beginning of the buffer.
     *
     * @return {Builder} Returns with a reference to this builder.
     */
    reset(): Builder;
    position: number;
    /**
     * Write the table name into the buffer of the builder.
     *
     * @param {string} table - Table name.
     * @return {Builder} Returns with a reference to this builder.
     */
    addTable(table: string): Builder;
    hasTable: boolean;
    /**
     * Write a symbol name and value into the buffer of the builder.
     *
     * @param {string} name - Symbol name.
     * @param {any} value - Symbol value, toString() will be called to extract the actual symbol value from the parameter.
     * @return {Builder} Returns with a reference to this builder.
     */
    addSymbol(name: string, value: any): Builder;
    hasSymbols: boolean;
    /**
     * Write a string column with its value into the buffer of the builder.
     *
     * @param {string} name - Column name.
     * @param {string} value - Column value, accepts only string values.
     * @return {Builder} Returns with a reference to this builder.
     */
    addString(name: string, value: string): Builder;
    /**
     * Write a boolean column with its value into the buffer of the builder.
     *
     * @param {string} name - Column name.
     * @param {boolean} value - Column value, accepts only boolean values.
     * @return {Builder} Returns with a reference to this builder.
     */
    addBoolean(name: string, value: boolean): Builder;
    /**
     * Write a float column with its value into the buffer of the builder.
     *
     * @param {string} name - Column name.
     * @param {number} value - Column value, accepts only number values.
     * @return {Builder} Returns with a reference to this builder.
     */
    addFloat(name: string, value: number): Builder;
    /**
     * Write an integer column with its value into the buffer of the builder.
     *
     * @param {string} name - Column name.
     * @param {bigint} value - Column value, accepts only bigint values.
     * @return {Builder} Returns with a reference to this builder.
     */
    addInteger(name: string, value: bigint): Builder;
    /**
     * Write a timestamp column with its value into the buffer of the builder.
     *
     * @param {string} name - Column name.
     * @param {Micros} value - Column value, accepts only Micros objects.
     * @return {Builder} Returns with a reference to this builder.
     */
    addTimestamp(name: string, value: Micros): Builder;
    /**
     * Closing the row after writing the designated timestamp into the buffer of the builder.
     *
     * @param {Nanos | bigint | number | string} timestamp - The designated timestamp. If bigint, number or string passed it will be converted to nanoseconds.
     */
    at(timestamp: Nanos | bigint | number | string): void;
    /**
     * Closing the row without writing designated timestamp into the buffer of the builder. <br>
     * Designated timestamp will be populated by the server on this record.
     */
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
    /**
     *  @return {string} Returns a cropped buffer ready to send to the server.
     */
    toBuffer(): string;
}
import { Buffer } from "buffer";
import { Micros } from "./timestamp";
import { Nanos } from "./timestamp";
import { Row } from "./row";
//# sourceMappingURL=builder.d.ts.map