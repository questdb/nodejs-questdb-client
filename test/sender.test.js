'use strict';

const { Sender } = require("../index");
const { MockProxy } = require("./mockproxy");
const { readFileSync} = require("fs");
const { GenericContainer } = require("testcontainers");
const http = require('http');

const HTTP_OK = 200;

const QUESTDB_HTTP_PORT = 9000;
const QUESTDB_ILP_PORT = 9009;
const PROXY_PORT = 9099;
const PROXY_HOST = '127.0.0.1';

const senderOptions = {
    port: PROXY_PORT,
    host: PROXY_HOST,
    ca: readFileSync('test/certs/ca/ca.crt')
}

const proxyOptions = {
    key: readFileSync('test/certs/server/server.key'),
    cert: readFileSync('test/certs/server/server.crt'),
    ca: readFileSync('test/certs/ca/ca.crt')
};

const PRIVATE_KEY = "9b9x5WhJywDEuo1KGQWSPNxtX-6X6R2BRCKhYMMY6n8"
const PUBLIC_KEY = {
    x: "aultdA0PjhD_cWViqKKyL5chm6H1n-BiZBo_48T-uqc",
    y:"__ptaol41JWSpTTL525yVEfzmY8A6Vi_QrW1FjKcHMg"
}
const JWK = {
    ...PUBLIC_KEY,
    kid: "testapp",
    kty: "EC",
    d: PRIVATE_KEY,
    crv: "P-256",
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Sender connection suite', function () {
    async function createProxy(auth = false, tlsOptions = undefined) {
        const mockConfig = { auth: auth, assertions: true };
        const proxy = new MockProxy(mockConfig);
        await proxy.start(PROXY_PORT, tlsOptions);
        expect(proxy.mockConfig).toBe(mockConfig);
        expect(proxy.dataSentToRemote).toStrictEqual([]);
        return proxy;
    }

    async function createSender(jwk = undefined, secure = false) {
        const sender = new Sender({bufferSize: 1024, jwk: jwk});
        const connected = await sender.connect(senderOptions, secure);
        expect(connected).toBe(true);
        return sender;
    }

    async function sendData(sender) {
        sender.table("test").symbol("location", "us").floatColumn("temperature", 17.1).at("1658484765000000000");
        await sender.flush();
    }

    async function assertSentData(proxy, authenticated, expected, timeout = 60000) {
        const interval = 100;
        const num = timeout / interval;
        let actual;
        for (let i = 0; i < num; i++) {
            const dataSentToRemote = proxy.getDataSentToRemote().join('').split('\n');
            if (authenticated) {
                dataSentToRemote.splice(1, 1);
            }
            actual = dataSentToRemote.join('\n');
            if (actual === expected) {
                return new Promise(resolve => resolve(null));
            }
            await sleep(interval);
        }
        return new Promise(resolve => resolve(`data assert failed [expected=${expected}, actual=${actual}]`));
    }

    it('can authenticate', async function () {
        const proxy = await createProxy(true);
        const sender = await createSender(JWK);
        await sender.close();
        await assertSentData(proxy, true, "testapp\n");
        await proxy.stop();
    });

    it('can connect unauthenticated', async function () {
        const proxy = await createProxy();
        const sender = await createSender();
        await sender.close();
        await assertSentData(proxy, false, "");
        await proxy.stop();
    });

    it('can authenticate and send data to server', async function () {
        const proxy = await createProxy(true);
        const sender = await createSender(JWK);
        await sendData(sender);
        await sender.close();
        await assertSentData(proxy, true, "testapp\ntest,location=us temperature=17.1 1658484765000000000\n");
        await proxy.stop();
    });

    it('can connect unauthenticated and send data to server', async function () {
        const proxy = await createProxy();
        const sender = await createSender();
        await sendData(sender);
        await sender.close();
        await assertSentData(proxy, false, "test,location=us temperature=17.1 1658484765000000000\n");
        await proxy.stop();
    });

    it('can authenticate and send data to server via secure connection', async function () {
        const proxy = await createProxy(true, proxyOptions);
        const sender = await createSender(JWK, true);
        await sendData(sender);
        await sender.close();
        await assertSentData(proxy, true, "testapp\ntest,location=us temperature=17.1 1658484765000000000\n");
        await proxy.stop();
    });

    it('can connect unauthenticated and send data to server via secure connection', async function () {
        const proxy = await createProxy(false, proxyOptions);
        const sender = await createSender(null, true);
        await sendData(sender);
        await sender.close();
        await assertSentData(proxy, false, "test,location=us temperature=17.1 1658484765000000000\n");
        await proxy.stop();
    });

    it('guards against multiple connect calls', async function () {
        const proxy = await createProxy(true, proxyOptions);
        const sender = await createSender(JWK, true);
        try {
            await sender.connect(senderOptions, true);
        } catch(err) {
            expect(err.message).toBe("Sender connected already");
        }
        await sender.close();
        await proxy.stop();
    });

    it('guards against concurrent connect calls', async function () {
        const proxy = await createProxy(true, proxyOptions);
        const sender = new Sender({bufferSize: 1024, jwk: JWK});
        try {
            await Promise.all([sender.connect(senderOptions, true), sender.connect(senderOptions, true)]);
        } catch(err) {
            expect(err.message).toBe("Sender connected already");
        }
        await sender.close();
        await proxy.stop();
    });
});

describe('Client interop test suite', function () {
    it('runs client tests as per json test config', function () {
        let testCases = JSON.parse(readFileSync('./questdb-client-test/ilp-client-interop-test.json').toString());

        loopTestCase:
            for (const testCase of testCases) {
                console.info(`test name: ${testCase.testName}`);
                const sender = new Sender({bufferSize: 1024});
                try {
                    sender.table(testCase.table);
                    for (const symbol of testCase.symbols) {
                        sender.symbol(symbol.name, symbol.value);
                    }
                    for (const column of testCase.columns) {
                        switch (column.type) {
                            case "STRING":
                                sender.stringColumn(column.name, column.value);
                                break;
                            case "LONG":
                                sender.intColumn(column.name, column.value);
                                break;
                            case "DOUBLE":
                                sender.floatColumn(column.name, column.value);
                                break;
                            case "BOOLEAN":
                                sender.booleanColumn(column.name, column.value);
                                break;
                            case "TIMESTAMP":
                                sender.timestampColumn(column.name, column.value);
                                break;
                            default:
                                throw new Error("Unsupported column type");
                        }
                    }
                    sender.atNow();
                } catch (e) {
                    if (testCase.result.status !== "ERROR") {
                        fail("Did not expect error: " + e.message);
                        break;
                    }
                    continue;
                }

                const buffer = sender.toBuffer();
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

describe('Sender message builder test suite (anything not covered in client interop test suite)', function () {
    it('supports timestamp fields', function () {
        const sender = new Sender({bufferSize: 1024});
        sender.table("tableName")
            .booleanColumn("boolCol", true)
            .timestampColumn("timestampCol", 1658484765000000)
            .atNow();
        expect(sender.toBuffer().toString()).toBe(
            "tableName boolCol=t,timestampCol=1658484765000000t\n"
        );
    });

    it('supports setting designated timestamp from client', function () {
        const sender = new Sender({bufferSize: 1024});
        sender.table("tableName")
            .booleanColumn("boolCol", true)
            .timestampColumn("timestampCol", 1658484765000000)
            .at("1658484769000000123");
        expect(sender.toBuffer().toString()).toBe(
            "tableName boolCol=t,timestampCol=1658484765000000t 1658484769000000123\n"
        );
    });

    it('throws exception if table name is not a string', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table(23456)
        ).toThrow("Table name must be a string, received number");
    });

    it('throws exception if table name is too long', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table("123456789012345678901234567890123456789012345678901234567890"
                + "12345678901234567890123456789012345678901234567890123456789012345678")
        ).toThrow("Table name is too long, max length is 127");
    });

    it('throws exception if table name is set more times', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table("tableName")
                .symbol("name", "value")
                .table("newTableName")
        ).toThrow("Table name has already been set");
    });

    it('throws exception if symbol name is not a string', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table("tableName")
                .symbol(12345.5656, "value")
        ).toThrow("Symbol name must be a string, received number");
    });

    it('throws exception if symbol name is empty string', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table("tableName")
                .symbol("", "value")
        ).toThrow("Empty string is not allowed as column name");
    });

    it('throws exception if column name is not a string', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table("tableName")
                .stringColumn(12345.5656, "value")
        ).toThrow("Column name must be a string, received number");
    });

    it('throws exception if column name is empty string', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table("tableName")
                .stringColumn("", "value")
        ).toThrow("Empty string is not allowed as column name");
    });

    it('throws exception if column name is too long', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table("tableName")
                .stringColumn("123456789012345678901234567890123456789012345678901234567890"
                    + "12345678901234567890123456789012345678901234567890123456789012345678", "value")
        ).toThrow("Column name is too long, max length is 127");
    });

    it('throws exception if column value is not the right type', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table("tableName")
                .stringColumn("columnName", false)
        ).toThrow("Column value must be of type string, received boolean");
    });

    it('throws exception if adding column without setting table name', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.floatColumn("name", 12.459)
        ).toThrow("Column can be set only after table name is set");
    });

    it('throws exception if adding symbol without setting table name', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.symbol("name", "value")
        ).toThrow("Symbol can be added only after table name is set and before any column added");
    });

    it('throws exception if adding symbol after columns', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table("tableName")
                .stringColumn("name", "value")
                .symbol("symbolName", "symbolValue")
        ).toThrow("Symbol can be added only after table name is set and before any column added");
    });

    it('returns null if preparing an empty buffer for send', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(sender.toBuffer()).toBe(null);
    });

    it('ignores unfinished rows when preparing a buffer for send', function () {
        const sender = new Sender({bufferSize: 1024});
        sender.table("tableName")
            .symbol("name", "value")
            .at("1234567890");
        sender.table("tableName")
            .symbol("name", "value2");
        expect(
            sender.toBuffer(sender.endOfLastRow).toString()
        ).toBe("tableName,name=value 1234567890\n");
    });

    it('throws exception if a float is passed as integer field', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table("tableName")
                .intColumn("intField", 123.222)
        ).toThrow("Value must be an integer, received 123.222");
    });

    it('throws exception if designated timestamp is not a string', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table("tableName")
                .symbol("name", "value")
                .at(23232322323)
        ).toThrow("The designated timestamp must be of type string, received number");
    });

    it('throws exception if designated timestamp is an empty string', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table("tableName")
                .symbol("name", "value")
                .at("")
        ).toThrow("Empty string is not allowed as designated timestamp");
    });

    it('throws exception if designated timestamp is invalid', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table("tableName")
                .symbol("name", "value")
                .at("343434.5656")
        ).toThrow("Invalid character in designated timestamp: 343434.5656");
    });

    it('throws exception if designated timestamp is set without any fields added', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table("tableName")
                .at("12345678")
        ).toThrow("The row must have a symbol or column set before it is closed");
    });

    it('extends the size of the buffer if data does not fit', function () {
        const sender = new Sender({bufferSize: 8});
        expect(sender.bufferSize).toBe(8);
        expect(sender.position).toBe(0);
        sender.table("tableName");
        expect(sender.bufferSize).toBe(16);
        expect(sender.position).toBe("tableName".length);
        sender.intColumn("intField", 123);
        expect(sender.bufferSize).toBe(32);
        expect(sender.position).toBe("tableName intField=123i".length);
        sender.atNow();
        expect(sender.bufferSize).toBe(32);
        expect(sender.position).toBe("tableName intField=123i\n".length);
        expect(sender.toBuffer().toString()).toBe(
            "tableName intField=123i\n"
        );

        sender.table("table2")
            .intColumn("intField", 125)
            .stringColumn("strField", "test")
            .atNow();
        expect(sender.bufferSize).toBe(64);
        expect(sender.position).toBe("tableName intField=123i\ntable2 intField=125i,strField=\"test\"\n".length);
        expect(sender.toBuffer().toString()).toBe(
            "tableName intField=123i\ntable2 intField=125i,strField=\"test\"\n"
        );
    });

    it('is possible to clear the buffer by calling reset()', function () {
        const sender = new Sender({bufferSize: 1024});
        sender.table("tableName")
            .booleanColumn("boolCol", true)
            .timestampColumn("timestampCol", 1658484765000000)
            .atNow();
        sender.table("tableName")
            .booleanColumn("boolCol", false)
            .timestampColumn("timestampCol", 1658484766000000)
            .atNow();
        expect(sender.toBuffer().toString()).toBe(
            "tableName boolCol=t,timestampCol=1658484765000000t\n"
            + "tableName boolCol=f,timestampCol=1658484766000000t\n"
        );

        sender.reset();
        sender.table("tableName")
            .floatColumn("floatCol", 1234567890)
            .timestampColumn("timestampCol", 1658484767000000)
            .atNow();
        expect(sender.toBuffer().toString()).toBe(
            "tableName floatCol=1234567890,timestampCol=1658484767000000t\n"
        );
    });
});

describe("Sender tests with containerized QuestDB instance", () => {
    let container;
    let sender;

    async function query(container, query) {
        const options = {
            hostname: container.getHost(),
            port: container.getMappedPort(QUESTDB_HTTP_PORT),
            path: `/exec?query=${encodeURIComponent(query)}`,
            method: 'GET',
        };

        return new Promise((resolve, reject) => {
            const req = http.request(options, response => {
                if (response.statusCode === HTTP_OK) {
                    response.on('data', data => {
                        resolve(JSON.parse(data.toString()));
                    });
                } else {
                    reject(new Error(`HTTP request failed, statusCode=${response.statusCode}, query=${query}`));
                }
            });

            req.on('error', error => {
                reject(error);
            });

            req.end();
        });
    }

    async function runSelect(container, select, expectedCount, timeout = 60000) {
        const interval = 500;
        const num = timeout / interval;
        let selectResult;
        for (let i = 0; i < num; i++) {
            selectResult = await query(container, select);
            if (selectResult && selectResult.count >= expectedCount) {
                return selectResult;
            }
            await sleep(interval);
        }
        throw new Error(`Timed out while waiting for ${expectedCount} rows, select='${select}'`);
    }

    function getFieldsString(schema) {
        let fields = "";
        for (const element of schema) {
            fields += `${element.name} ${element.type}, `;
        }
        return fields.substring(0, fields.length - 2);
    }

    beforeAll(async () => {
        jest.setTimeout(3000000);
        container = await new GenericContainer("questdb/questdb")
            .withExposedPorts(QUESTDB_HTTP_PORT, QUESTDB_ILP_PORT)
            .start();

        sender = new Sender();
        await sender.connect({host: container.getHost(), port: container.getMappedPort(QUESTDB_ILP_PORT)});
    });

    afterAll(async () => {
        await sender.close();
        await container.stop();
    });

    it("can ingest data and run queries", async () => {
        const tableName = "test";
        const schema = [
            {name: "location", type: "SYMBOL"},
            {name: "temperature", type: "DOUBLE"},
            {name: "timestamp", type: "TIMESTAMP"}
        ];

        // create table
        let createTableResult = await query(container,
            `CREATE TABLE ${tableName}(${getFieldsString(schema)}) TIMESTAMP (timestamp) PARTITION BY DAY`
        );
        expect(createTableResult.ddl).toBe("OK");

        // alter table
        let alterTableResult = await query(container,
            `ALTER TABLE ${tableName} SET PARAM maxUncommittedRows = 1`
        );
        expect(alterTableResult.ddl).toBe("OK");

        // ingest via client
        sender.table("test").symbol("location", "us").floatColumn("temperature", 17.1).at("1658484765000000000");
        await sender.flush();

        // query table
        const select1Result = await runSelect(container, "test", 1);
        expect(select1Result.query).toBe("test");
        expect(select1Result.count).toBe(1);
        expect(select1Result.columns).toStrictEqual(schema);
        expect(select1Result.dataset).toStrictEqual([
            ["us",17.1,"2022-07-22T10:12:45.000000Z"]
        ]);

        // ingest via client, add new column
        sender.table("test").symbol("location", "us").floatColumn("temperature", 17.3).at("1658484765000666000");
        sender.table("test").symbol("location", "emea").floatColumn("temperature", 17.4).at("1658484765000999000");
        sender.table("test").symbol("location", "emea").symbol("city", "london").floatColumn("temperature", 18.8).at("1658484765001234000");
        await sender.flush();

        // query table
        const select2Result = await runSelect(container, "test", 4);
        expect(select2Result.query).toBe("test");
        expect(select2Result.count).toBe(4);
        expect(select2Result.columns).toStrictEqual([
            {name: "location", type: "SYMBOL"},
            {name: "temperature", type: "DOUBLE"},
            {name: "timestamp", type: "TIMESTAMP"},
            {name: "city", type: "SYMBOL"}
        ]);
        expect(select2Result.dataset).toStrictEqual([
            ["us",17.1,"2022-07-22T10:12:45.000000Z",null],
            ["us",17.3,"2022-07-22T10:12:45.000666Z",null],
            ["emea",17.4,"2022-07-22T10:12:45.000999Z",null],
            ["emea",18.8,"2022-07-22T10:12:45.001234Z","london"]
        ]);
    });
});
