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
import { Nanos } from "./timestamp";
//# sourceMappingURL=row.d.ts.map