'use strict';

const { Nanos } = require("./timestamp");

/** @classdesc Represents a database row. */
class Row {

    /**
     * Creates a Row object.
     *
     * @param {string} table - The name of the table.
     * @param {object} [symbols = undefined] - Symbols of the row in the form of {colName1: value1, colName2: value2...}.
     * @param {object} [columns = undefined] - Columns of the row in the form of {colName1: value1, colName2: value2...}.
     * @param {Nanos | bigint | number | string} [timestamp = undefined] - The designated timestamp.
     */
    constructor(table, symbols = undefined, columns = undefined, timestamp = undefined) {
        this.table = table;
        if (symbols) {
            this.symbols = symbols;
        }
        if (columns) {
            this.columns = columns;
        }
        if (timestamp) {
            this.timestamp = timestamp;
        }
    }
}

exports.Row = Row;
