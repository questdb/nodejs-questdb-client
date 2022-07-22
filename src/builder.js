const { Buffer } = require("buffer");

const State = {
    Table: 'Table',
    SymbolOrField: 'SymbolOrField',
    Field: 'Field'
};

function write(builder, data) {
    builder.position += builder.buffer.write(data, builder.position);
    if (builder.position >= builder.bufferSize) {
        throw "Buffer overflow, position=" + builder.position + ", bufferSize=" + builder.bufferSize;
    }
}

class Builder {
    constructor(bufferSize) {
        this.resize(bufferSize);
    }

    resize(bufferSize) {
        this.bufferSize = bufferSize;
        this.buffer = Buffer.alloc(bufferSize, 0, 'utf8');
        this.reset();
    }

    reset() {
        this.position = 0;
        this.state = State.Table;
        return this;
    }

    addTable(table) {
        if (typeof table !== "string") {
            throw "Table name must be a string, received " + typeof table;
        }
        if (this.state !== State.Table) {
            throw "Table name not expected, current state: " + this.state;
        }
        write(this, table);
        this.state = State.SymbolOrField;
        return this;
    }

    addSymbol(name, value) {
        if (typeof name !== "string") {
            throw "Symbol name must be a string, received " + typeof name;
        }
        if (typeof value !== "string") {
            throw "Symbol value must be a string, received " + typeof value;
        }
        if (this.state !== State.SymbolOrField) {
            throw "Symbol not expected, current state: " + this.state;
        }
        write(this, ',');
        write(this, name);
        write(this, '=');
        write(this, value);
        this.state = State.SymbolOrField;
        return this;
    }

    addString(name, value) {
        if (typeof name !== "string") {
            throw "Field name must be a string, received " + typeof name;
        }
        if (typeof value !== "string") {
            throw "Field value must be a string, received " + typeof value;
        }
        if (this.state === State.Table) {
            throw "Field not expected, current state: " + this.state;
        }
        write(this, this.state === State.Field ? ',' : ' ');
        write(this, name);
        write(this, '="');
        write(this, value);
        write(this, '"');
        this.state = State.Field;
        return this;
    }

    addBoolean(name, value) {
        if (typeof name !== "string") {
            throw "Field name must be a string, received " + typeof name;
        }
        if (typeof value !== "boolean") {
            throw "Field value must be a boolean, received " + typeof value;
        }
        if (this.state === State.Table) {
            throw "Field not expected, current state: " + this.state;
        }
        write(this, this.state === State.Field ? ',' : ' ');
        write(this, name);
        write(this, '=');
        write(this, value ? 't' : 'f');
        this.state = State.Field;
        return this;
    }

    addFloat(name, value) {
        if (typeof name !== "string") {
            throw "Field name must be a string, received " + typeof name;
        }
        if (typeof value !== "number") {
            throw "Field value must be a number, received " + typeof value;
        }
        if (this.state === State.Table) {
            throw "Field not expected, current state: " + this.state;
        }
        write(this, this.state === State.Field ? ',' : ' ');
        write(this, name);
        write(this, '=');
        write(this, value.toString());
        this.state = State.Field;
        return this;
    }

    addInteger(name, value) {
        if (typeof name !== "string") {
            throw "Field name must be a string, received " + typeof name;
        }
        if (typeof value !== "number") {
            throw "Field value must be a number, received " + typeof value;
        }
        if (!Number.isInteger(value)) {
            throw "Field value must be an integer, received " + value;
        }
        if (this.state === State.Table) {
            throw "Field not expected, current state: " + this.state;
        }
        write(this, this.state === State.Field ? ',' : ' ');
        write(this, name);
        write(this, '=');
        write(this, value.toString());
        write(this, 'i');
        this.state = State.Field;
        return this;
    }

    addTimestamp(name, value) {
        if (typeof name !== "string") {
            throw "Field name must be a string, received " + typeof name;
        }
        if (typeof value !== "number") {
            throw "Field value must be a number, received " + typeof value;
        }
        if (!Number.isInteger(value)) {
            throw "Field value must be an integer, received " + value;
        }
        if (this.state === State.Table) {
            throw "Field not expected, current state: " + this.state;
        }
        write(this, this.state === State.Field ? ',' : ' ');
        write(this, name);
        write(this, '=');
        write(this, value.toString());
        write(this, 't');
        this.state = State.Field;
        return this;
    }

    at(timestamp) {
        if (typeof timestamp !== "number") {
            throw "Timestamp must be a number, received " + typeof timestamp;
        }
        if (!Number.isInteger(timestamp)) {
            throw "Timestamp must be an integer, received " + timestamp;
        }
        if (this.state === State.Table) {
            throw "Timestamp not expected, current state: " + this.state;
        }
        write(this, ' ');
        write(this, timestamp.toString());
        write(this, '\n');
        this.state = State.Table;
    }

    atNow() {
        if (this.state === State.Table) {
            throw "Line end not expected, current state: " + this.state;
        }
        write(this, '\n');
        this.state = State.Table;
    }

    toBuffer() {
        if (this.state !== State.Table) {
            throw "The builder's content is invalid, row needs to be closed by calling at() or atNow()";
        }
        if (this.position < 1) {
            throw "The builder is empty";
        }
        return this.buffer.subarray(0, this.position);
    }
}

exports.Builder = Builder;
