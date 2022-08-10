'use strict';

const { Buffer } = require("buffer");
const { Row } = require("./row");
const { Micros, Nanos } = require("./timestamp");
const { validateTableName, validateColumnName } = require("./validation");

/** @classdesc Builder for the QuestDB client. */
class Builder {

    /**
     * Creates an instance of Builder.
     *
     * @param {number} bufferSize - Size of the buffer used by the builder, provided in bytes.
     */
    constructor(bufferSize) {
        this.resize(bufferSize);
    }

    /**
     * Reinitializes the buffer of the builder. <br>
     * Can be used to increase the size of buffer if overflown.
     *
     * @param {number} bufferSize - New size of the buffer used by the builder, provided in bytes.
     */
    resize(bufferSize) {
        this.bufferSize = bufferSize;
        this.buffer = Buffer.alloc(this.bufferSize + 1, 0, 'utf8');
        this.reset();
    }

    /**
     * Resets the buffer, data added to the buffer will be lost. <br>
     * In other words it clears the buffer and sets the writing position to the beginning of the buffer.
     *
     * @return {Builder} Returns with a reference to this builder.
     */
    reset() {
        this.position = 0;
        startNewRow(this);
        return this;
    }

    /**
     * Write the table name into the buffer of the builder.
     *
     * @param {string} table - Table name.
     * @return {Builder} Returns with a reference to this builder.
     */
    addTable(table) {
        if (typeof table !== "string") {
            throw new Error(`Table name must be a string, received ${typeof table}`);
        }
        if (this.hasTable) {
            throw new Error("Table name has already been set");
        }
        validateTableName(table);
        writeEscaped(this, table);
        this.hasTable = true;
        return this;
    }

    /**
     * Write a symbol name and value into the buffer of the builder.
     *
     * @param {string} name - Symbol name.
     * @param {any} value - Symbol value, toString() will be called to extract the actual symbol value from the parameter.
     * @return {Builder} Returns with a reference to this builder.
     */
    addSymbol(name, value) {
        if (typeof name !== "string") {
            throw new Error(`Symbol name must be a string, received ${typeof name}`);
        }
        if (!this.hasTable || this.hasColumns) {
            throw new Error("Symbol can be added only after table name is set and before any column added");
        }
        write(this, ',');
        validateColumnName(name);
        writeEscaped(this, name);
        write(this, '=');
        writeEscaped(this, value.toString());
        this.hasSymbols = true;
        return this;
    }

    /**
     * Write a string column with its value into the buffer of the builder.
     *
     * @param {string} name - Column name.
     * @param {string} value - Column value, accepts only string values.
     * @return {Builder} Returns with a reference to this builder.
     */
    addString(name, value) {
        addColumn(this, name, value, () => {
            write(this, '"');
            writeEscaped(this, value, true);
            write(this, '"');
        }, "string");
        return this;
    }

    /**
     * Write a boolean column with its value into the buffer of the builder.
     *
     * @param {string} name - Column name.
     * @param {boolean} value - Column value, accepts only boolean values.
     * @return {Builder} Returns with a reference to this builder.
     */
    addBoolean(name, value) {
        addColumn(this, name, value, () => {
            write(this, value ? 't' : 'f');
        }, "boolean");
        return this;
    }

    /**
     * Write a float column with its value into the buffer of the builder.
     *
     * @param {string} name - Column name.
     * @param {number} value - Column value, accepts only number values.
     * @return {Builder} Returns with a reference to this builder.
     */
    addFloat(name, value) {
        addColumn(this, name, value, () => {
            write(this, value.toString());
        }, "number");
        return this;
    }

    /**
     * Write an integer column with its value into the buffer of the builder.
     *
     * @param {string} name - Column name.
     * @param {bigint} value - Column value, accepts only bigint values.
     * @return {Builder} Returns with a reference to this builder.
     */
    addInteger(name, value) {
        addColumn(this, name, value, () => {
            write(this, value.toString());
            write(this, 'i');
        }, "bigint");
        return this;
    }

    /**
     * Write a timestamp column with its value into the buffer of the builder.
     *
     * @param {string} name - Column name.
     * @param {Micros} value - Column value, accepts only Micros objects.
     * @return {Builder} Returns with a reference to this builder.
     */
    addTimestamp(name, value) {
        addColumn(this, name, value, () => {
            write(this, value.toString());
            write(this, 't');
        }, "object", Micros.name);
        return this;
    }

    /**
     * Closing the row after writing the designated timestamp into the buffer of the builder.
     *
     * @param {Nanos | bigint | number | string} timestamp - The designated timestamp. If bigint, number or string passed it will be converted to nanoseconds.
     */
    at(timestamp) {
        if (typeof timestamp !== "object") {
            throw new Error(`The designated timestamp must be Nanos, received ${typeof timestamp}`);
        }
        if (!(timestamp instanceof Nanos)) {
            throw new Error(`The designated timestamp must be Nanos, received ${timestamp.constructor.name}`);
        }
        if (!this.hasSymbols && !this.hasColumns) {
            throw new Error("The row must have a symbol or field set before it is closed");
        }
        write(this, ' ');
        write(this, timestamp.toString());
        write(this, '\n');
        startNewRow(this);
    }

    /**
     * Closing the row without writing designated timestamp into the buffer of the builder. <br>
     * Designated timestamp will be populated by the server on this record.
     */
    atNow() {
        if (!this.hasSymbols && !this.hasColumns) {
            throw new Error("The row must have a symbol or field set before it is closed");
        }
        write(this, '\n');
        startNewRow(this);
    }

    /**
     * Writes rows into the buffer.
     *
     * @param {Row[] | Row} rows - The row or a list of rows to ingest.
     */
    addRows(rows) {
        if (Array.isArray(rows)) {
            for (const row of rows) {
                this.addRow(row);
            }
        } else {
            // not an array, assumed that it is a single row
            this.addRow(rows);
        }
    }

    /**
     * Writes a row into the buffer.
     *
     * @param {Row} row - The row to ingest.
     */
    addRow(row) {
        this.addTable(row.table);
        if (row.symbols) {
            for (const [name, value] of Object.entries(row.symbols)) {
                this.addSymbol(name, value);
            }
        }
        if (row.columns) {
            for (const [name, value] of Object.entries(row.columns)) {
                switch (typeof value) {
                    case "string":
                        this.addString(name, value);
                        break;
                    case "boolean":
                        this.addBoolean(name, value);
                        break;
                    case "number":
                        this.addFloat(name, value);
                        break;
                    case "bigint":
                        this.addInteger(name, value);
                        break;
                    case "object":
                        if (value instanceof Micros) {
                            this.addTimestamp(name, value);
                            break;
                        }
                        throw new Error(`Unsupported column type: ${value.constructor.name}`);
                    default:
                        throw new Error(`Unsupported column type: ${typeof value}`);
                }
            }
        }
        if (row.timestamp) {
            switch (typeof row.timestamp) {
                case "string":
                case "number":
                case "bigint":
                    this.at(new Nanos(row.timestamp));
                    break;
                case "object":
                    if (row.timestamp instanceof Nanos) {
                        this.at(row.timestamp);
                        break;
                    }
                    throw new Error(`Unsupported designated timestamp type: ${row.timestamp.constructor.name}`);
                default:
                    throw new Error(`Unsupported designated timestamp type: ${typeof row.timestamp}`);
            }
        } else {
            this.atNow();
        }
    }

    /**
     *  @return {string} Returns a cropped buffer ready to send to the server.
     */
    toBuffer() {
        if (this.hasTable) {
            throw new Error("The builder's content is invalid, row needs to be closed by calling at() or atNow()");
        }
        if (this.position < 1) {
            throw new Error("The builder is empty");
        }
        return this.buffer.subarray(0, this.position);
    }
}

function startNewRow(builder) {
    builder.hasTable = false;
    builder.hasSymbols = false;
    builder.hasColumns = false;
}

function addColumn(builder, name, value, writeValue, valueType, instanceType = undefined) {
    if (typeof name !== "string") {
        throw new Error(`Field name must be a string, received ${typeof name}`);
    }
    if (typeof value !== valueType) {
        throw new Error(`Field value must be a ${valueType}, received ${typeof value}`);
    }
    if (instanceType && value.constructor.name !== instanceType) {
        throw new Error(`Field value must be ${valueType}, received ${value.prototype.name}`);
    }
    if (!builder.hasTable) {
        throw new Error("Field can be added only after table name is set");
    }
    write(builder, builder.hasColumns ? ',' : ' ');
    validateColumnName(name);
    writeEscaped(builder, name);
    write(builder, '=');
    writeValue();
    builder.hasColumns = true;
}

function write(builder, data) {
    builder.position += builder.buffer.write(data, builder.position);
    if (builder.position > builder.bufferSize) {
        throw new Error(`Buffer overflow [position=${builder.position}, bufferSize=${builder.bufferSize}]`);
    }
}

function writeEscaped(builder, data, quoted = false) {
    for (const ch of data) {
        if (ch > '\\') {
            write(builder, ch);
            continue;
        }

        switch (ch) {
            case ' ':
            case ',':
            case '=':
                if (!quoted) {
                    write(builder, '\\');
                }
                write(builder, ch);
                break;
            case '\n':
            case '\r':
                write(builder, '\\');
                write(builder, ch);
                break;
            case '"':
                if (quoted) {
                    write(builder, '\\');
                }
                write(builder, ch);
                break;
            case '\\':
                write(builder, '\\\\');
                break;
            default:
                write(builder, ch);
                break;
        }
    }
}

exports.Builder = Builder;
