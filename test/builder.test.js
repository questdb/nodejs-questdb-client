'use strict';

const fs = require('fs')
const { Builder } = require("../src/builder");
const { Row, Micros, Nanos } = require("../index");

describe('Client interop test suite', function () {
    it('runs client tests as per json test config', function () {
        let testCases = JSON.parse(fs.readFileSync('./questdb-client-test/ilp-client-interop-test.json').toString());

        loopTestCase:
        for (const testCase of testCases) {
            const builder = new Builder(1024);
            try {
                builder.addTable(testCase.table);
                for (const symbol of testCase.symbols) {
                    builder.addSymbol(symbol.name, symbol.value);
                }
                for (const column of testCase.columns) {
                    switch (column.type) {
                        case "STRING":
                            builder.addString(column.name, column.value);
                            break;
                        case "LONG":
                            builder.addInteger(column.name, BigInt(column.value));
                            break;
                        case "DOUBLE":
                            builder.addFloat(column.name, column.value);
                            break;
                        case "BOOLEAN":
                            builder.addBoolean(column.name, column.value);
                            break;
                        case "TIMESTAMP":
                            builder.addTimestamp(column.name, new Micros(column.value));
                            break;
                        default:
                            throw new Error("Unsupported column type");
                    }
                }
                builder.atNow();
            } catch (e) {
                if (testCase.result.status !== "ERROR") {
                    fail("Did not expect error: " + e.message);
                    break;
                }
                continue;
            }

            const buffer = builder.toBuffer();
            if (testCase.result.status === "SUCCESS") {
                if (testCase.result.line) {
                    expect(buffer.toString()).toBe(testCase.result.line + '\n');
                } else {
                    for (const line of testCase.result.anyLines) {
                        if (buffer.toString() === line + '\n') {
                            // test passed
                            continue loopTestCase;
                        }
                    }
                    fail("Line is not matching any of the expected results: " + buffer.toString());
                }
            } else {
                fail("Expected error missing, instead we have a line: " + buffer.toString());
                break;
            }
        }
    });
});

describe('Builder test suite (anything not covered in client interop test suite)', function () {
    it('supports timestamp fields', function () {
        const builder = new Builder(1024);
        builder.addTable("tableName")
            .addBoolean("boolCol", true)
            .addTimestamp("timestampCol", new Micros(1658484765000000n))
            .atNow();
        expect(builder.toBuffer().toString()).toBe(
            "tableName boolCol=t,timestampCol=1658484765000000t\n"
        );
    });

    it('supports setting designated timestamp from client', function () {
        const builder = new Builder(1024);
        builder.addTable("tableName")
            .addBoolean("boolCol", true)
            .addTimestamp("timestampCol", new Micros(1658484765000000n))
            .at(new Nanos(1658484769000000123n));
        expect(builder.toBuffer().toString()).toBe(
            "tableName boolCol=t,timestampCol=1658484765000000t 1658484769000000123\n"
        );
    });

    it('throws exception if table name is not a string', function () {
        const builder = new Builder(1024);
        expect(
            () => builder.addTable(23456)
        ).toThrow("Table name must be a string, received number");
    });

    it('throws exception if table name is too long', function () {
        const builder = new Builder(1024);
        expect(
            () => builder.addTable("123456789012345678901234567890123456789012345678901234567890"
            + "12345678901234567890123456789012345678901234567890123456789012345678")
        ).toThrow("Table name is too long, max length is 127");
    });

    it('throws exception if table name is set more times', function () {
        const builder = new Builder(1024);
        expect(
            () => builder.addTable("tableName")
                .addSymbol("name", "value")
                .addTable("newTableName")
        ).toThrow("Table name has already been set");
    });

    it('throws exception if symbol name is not a string', function () {
        const builder = new Builder(1024);
        expect(
            () => builder.addTable("tableName")
                .addSymbol(12345.5656, "value")
        ).toThrow("Symbol name must be a string, received number");
    });

    it('throws exception if symbol name is empty string', function () {
        const builder = new Builder(1024);
        expect(
            () => builder.addTable("tableName")
                .addSymbol("", "value")
        ).toThrow("Empty string is not allowed as column name");
    });

    it('throws exception if column name is not a string', function () {
        const builder = new Builder(1024);
        expect(
            () => builder.addTable("tableName")
                .addString(12345.5656, "value")
        ).toThrow("Field name must be a string, received number");
    });

    it('throws exception if column name is empty string', function () {
        const builder = new Builder(1024);
        expect(
            () => builder.addTable("tableName")
                .addString("", "value")
        ).toThrow("Empty string is not allowed as column name");
    });

    it('throws exception if column name is too long', function () {
        const builder = new Builder(1024);
        expect(
            () => builder.addTable("tableName")
                .addString("123456789012345678901234567890123456789012345678901234567890"
                    + "12345678901234567890123456789012345678901234567890123456789012345678", "value")
        ).toThrow("Column name is too long, max length is 127");
    });

    it('throws exception if column value is not the right type', function () {
        const builder = new Builder(1024);
        expect(
            () => builder.addTable("tableName")
                .addString("columnName", false)
        ).toThrow("Field value must be a string, received boolean");
    });

    it('throws exception if adding column without setting table name', function () {
        const builder = new Builder(1024);
        expect(
            () => builder.addFloat("name", 12.459)
        ).toThrow("Field can be added only after table name is set");
    });

    it('throws exception if adding symbol without setting table name', function () {
        const builder = new Builder(1024);
        expect(
            () => builder.addSymbol("name", "value")
        ).toThrow("Symbol can be added only after table name is set and before any column added");
    });

    it('throws exception if adding symbol after columns', function () {
        const builder = new Builder(1024);
        expect(
            () => builder.addTable("tableName")
                .addString("name", "value")
                .addSymbol("symbolName", "symbolValue")
        ).toThrow("Symbol can be added only after table name is set and before any column added");
    });

    it('throws exception if preparing an empty buffer for send', function () {
        const builder = new Builder(1024);
        expect(
            () => builder.toBuffer()
        ).toThrow("The builder is empty");
    });

    it('throws exception if preparing a buffer with an unclosed row for send', function () {
        const builder = new Builder(1024);
        expect(
            () => builder.addTable("tableName")
                .addSymbol("name", "value")
                .toBuffer()
        ).toThrow("The builder's content is invalid, row needs to be closed by calling at() or atNow()");
    });

    it('throws exception if a float is passed as integer field', function () {
        const builder = new Builder(1024);
        expect(
            () => builder.addTable("tableName")
                .addInteger("intField", 123.222)
        ).toThrow("Field value must be a bigint, received number");
    });

    it('throws exception if designated timestamp is not an object', function () {
        const builder = new Builder(1024);
        expect(
            () => builder.addTable("tableName")
                .addSymbol("name", "value")
                .at(Date.now())
        ).toThrow("The designated timestamp must be Nanos, received number");
    });

    it('throws exception if designated timestamp is not Nanos object', function () {
        const builder = new Builder(1024);
        expect(
            () => builder.addTable("tableName")
                .addSymbol("name", "value")
                .at(new Date())
        ).toThrow("The designated timestamp must be Nanos, received Date");
    });

    it('throws exception if designated timestamp is set without any fields added', function () {
        const builder = new Builder(1024);
        expect(
            () => builder.addTable("tableName")
                .at(new Nanos(12345678))
        ).toThrow("The row must have a symbol or field set before it is closed");
    });

    it('throws exception if buffer overflows', function () {
        const builder = new Builder(16);
        expect(
            () => builder.addTable("tableName")
                .addInteger("intField", BigInt(123))
        ).toThrow("Buffer overflow [position=17, bufferSize=16]");
    });

    it('can fix buffer overflows by calling resize()', function () {
        const builder = new Builder(16);
        expect(
            () => builder.addTable("tableName")
                .addFloat("floatField", 123.34)
        ).toThrow("Buffer overflow [position=17, bufferSize=16]");

        builder.resize(1024);
        builder.addTable("tableName")
            .addFloat("floatField", 123.34)
            .atNow();
        expect(builder.toBuffer().toString()).toBe(
            "tableName floatField=123.34\n"
        );
    });

    it('is possible to reuse the buffer by calling reset()', function () {
        const builder = new Builder(1024);
        builder.addTable("tableName")
            .addBoolean("boolCol", true)
            .addTimestamp("timestampCol", new Micros(1658484765000000n))
            .atNow();
        builder.addTable("tableName")
            .addBoolean("boolCol", false)
            .addTimestamp("timestampCol", new Micros(1658484766000000n))
            .atNow();
        expect(builder.toBuffer().toString()).toBe(
            "tableName boolCol=t,timestampCol=1658484765000000t\n"
            + "tableName boolCol=f,timestampCol=1658484766000000t\n"
        );

        builder.reset();
        builder.addTable("tableName")
            .addFloat("floatCol", 1234567890)
            .addTimestamp("timestampCol", new Micros(1658484767000000n))
            .atNow();
        expect(builder.toBuffer().toString()).toBe(
            "tableName floatCol=1234567890,timestampCol=1658484767000000t\n"
        );
    });

    it('can take an entire row', function () {
        const builder = new Builder(1024);
        builder.addRow({table: "tableName", symbols: {}, columns: {"floatField": 123.34}, timestamp: new Nanos(555n)});
        builder.addRow(new Row("tableName", {}, {"floatField": 67.67}, new Nanos(888n)));
        expect(builder.toBuffer().toString()).toBe(
            "tableName floatField=123.34 555\n" +
            "tableName floatField=67.67 888\n"
        );
    });

    it('can take a list of rows', function () {
        const builder = new Builder(1024);
        builder.addRows([
            {table: "tableName", symbols: {}, columns: {"floatField": 123.34}, timestamp: 555n},
            {table: "tableName", symbols: {"symField": "sym1"}, columns: {"floatField": 88.88}, timestamp: 666n}
        ]);
        builder.addRows([
            new Row("tableName", {"symField": "sym2"}, {"floatField": 55.55}, 777n),
            new Row("tableName", {}, {"floatField": 888.33}, 888n)
        ]);
        expect(builder.toBuffer().toString()).toBe(
            "tableName floatField=123.34 555\n" +
            "tableName,symField=sym1 floatField=88.88 666\n" +
            "tableName,symField=sym2 floatField=55.55 777\n" +
            "tableName floatField=888.33 888\n"
        );
    });

    it('can take string, float, int, boolean and timestamp in a row', function () {
        const builder = new Builder(1024);
        builder.addRows(new Row("tableName", {}, {
            "stringField": "something",
            "floatField": 67.67,
            "intField": 678n,
            "boolField": true,
            "tsField": new Micros(19191919n)
        }, new Nanos(888n)));
        expect(builder.toBuffer().toString()).toBe(
            "tableName stringField=\"something\",floatField=67.67,intField=678i,boolField=t,tsField=19191919t 888\n"
        );
    });

    it('can take a row without specifying designated timestamp', function () {
        const builder = new Builder(1024);
        builder.addRows(new Row("tableName", {}, {
            "stringField": "something",
            "floatField": 67.67,
            "intField": 678n,
            "boolField": true,
            "tsField": new Micros(19191919n)
        }));
        expect(builder.toBuffer().toString()).toBe(
            "tableName stringField=\"something\",floatField=67.67,intField=678i,boolField=t,tsField=19191919t\n"
        );
    });
});
