const { Buffer } = require("buffer");
const { validateTableName, validateColumnName } = require("./util");

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
        addColumn(this, name, value, "string", false, () => {
            write(this, '"');
            writeEscaped(this, value, true);
            write(this, '"');
        });
        return this;
    }

    addBoolean(name, value) {
        addColumn(this, name, value, "boolean", false, () => {
            write(this, value ? 't' : 'f');
        });
        return this;
    }

    addFloat(name, value) {
        addColumn(this, name, value, "number", false, () => {
            write(this, value.toString());
        });
        return this;
    }

    addInteger(name, value) {
        addColumn(this, name, value, "number", true, () => {
            write(this, value.toString());
            write(this, 'i');
        });
        return this;
    }

    addTimestamp(name, value) {
        addColumn(this, name, value, "number", true, () => {
            write(this, value.toString());
            write(this, 't');
        });
        return this;
    }

    at(timestamp) {
        if (typeof timestamp !== "number") {
            throw `Timestamp must be a number, received ${typeof timestamp}`;
        }
        if (!Number.isInteger(timestamp)) {
            throw `Timestamp must be an integer, received ${timestamp}`;
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

function addColumn(builder, name, value, valueType, valueShouldBeInteger, writeValue) {
    if (typeof name !== "string") {
        throw `Field name must be a string, received ${typeof name}`;
    }
    if (typeof value !== valueType) {
        throw `Field value must be a ${valueType}, received ${typeof value}`;
    }
    if (valueShouldBeInteger && !Number.isInteger(value)) {
        throw `Field value must be an integer, received ${value}`;
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
    for (let ch of data) {
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
