const { Buffer } = require("buffer");
const { Micros, Nanos } = require("./timestamp");
const { validateTableName, validateColumnName } = require("./validation");

class Builder {
    constructor(bufferSize) {
        this.resize(bufferSize);
    }

    resize(bufferSize) {
        this.bufferSize = bufferSize;
        this.buffer = Buffer.alloc(this.bufferSize + 1, 0, 'utf8');
        this.reset();
    }

    reset() {
        this.position = 0;
        startNewRow(this);
        return this;
    }

    addTable(table) {
        if (typeof table !== "string") {
            throw `Table name must be a string, received ${typeof table}`;
        }
        if (this.hasTable) {
            throw "Table name has already been set";
        }
        validateTableName(table);
        writeEscaped(this, table);
        this.hasTable = true;
        return this;
    }

    addSymbol(name, value) {
        if (typeof name !== "string") {
            throw `Symbol name must be a string, received ${typeof name}`;
        }
        if (!this.hasTable || this.hasColumns) {
            throw "Symbol can be added only after table name is set and before any column added";
        }
        write(this, ',');
        validateColumnName(name);
        writeEscaped(this, name);
        write(this, '=');
        writeEscaped(this, value.toString());
        this.hasSymbols = true;
        return this;
    }

    addString(name, value) {
        addColumn(this, name, value, () => {
            write(this, '"');
            writeEscaped(this, value, true);
            write(this, '"');
        }, "string");
        return this;
    }

    addBoolean(name, value) {
        addColumn(this, name, value, () => {
            write(this, value ? 't' : 'f');
        }, "boolean");
        return this;
    }

    addFloat(name, value) {
        addColumn(this, name, value, () => {
            write(this, value.toString());
        }, "number");
        return this;
    }

    addInteger(name, value) {
        addColumn(this, name, value, () => {
            write(this, value.toString());
            write(this, 'i');
        }, "bigint");
        return this;
    }

    addTimestamp(name, value) {
        addColumn(this, name, value, () => {
            write(this, value.toString());
            write(this, 't');
        }, "object", Micros.name);
        return this;
    }

    at(timestamp) {
        if (typeof timestamp !== "object") {
            throw `The designated timestamp must be Nanos, received ${typeof timestamp}`;
        }
        if (!(timestamp instanceof Nanos)) {
            throw `The designated timestamp must be Nanos, received ${timestamp.constructor.name}`;
        }
        if (!this.hasSymbols && !this.hasColumns) {
            throw "The row must have a symbol or field set before it is closed";
        }
        write(this, ' ');
        write(this, timestamp.toString());
        write(this, '\n');
        startNewRow(this);
    }

    atNow() {
        if (!this.hasSymbols && !this.hasColumns) {
            throw "The row must have a symbol or field set before it is closed";
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
                        throw `Unsupported column type: ${value.constructor.name}`;
                    default:
                        throw `Unsupported column type: ${typeof value}`;
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
                    throw `Unsupported designated timestamp type: ${row.timestamp.constructor.name}`;
                default:
                    throw `Unsupported designated timestamp type: ${typeof row.timestamp}`;
            }
        } else {
            this.atNow();
        }
    }

    toBuffer() {
        if (this.hasTable) {
            throw "The builder's content is invalid, row needs to be closed by calling at() or atNow()";
        }
        if (this.position < 1) {
            throw "The builder is empty";
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
        throw `Field name must be a string, received ${typeof name}`;
    }
    if (typeof value !== valueType) {
        throw `Field value must be a ${valueType}, received ${typeof value}`;
    }
    if (instanceType && value.constructor.name !== instanceType) {
        throw `Field value must be ${valueType}, received ${value.prototype.name}`;
    }
    if (!builder.hasTable) {
        throw "Field can be added only after table name is set";
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
        throw `Buffer overflow [position=${builder.position}, bufferSize=${builder.bufferSize}]`;
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
    constructor(table, symbols= undefined, columns = undefined, timestamp= undefined) {
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
exports.Builder = Builder;
