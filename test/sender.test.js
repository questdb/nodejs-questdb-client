'use strict';

const { Sender } = require('../index');
const { DEFAULT_BUFFER_SIZE } = require('../src/sender');
const { log } = require('../src/logging');
const { MockProxy } = require('./mockproxy');
const { readFileSync} = require('fs');
const { GenericContainer } = require('testcontainers');
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
}

const USER_NAME = 'testapp';
const PRIVATE_KEY = '9b9x5WhJywDEuo1KGQWSPNxtX-6X6R2BRCKhYMMY6n8';
const AUTH = {
    keyId: USER_NAME,
    token: PRIVATE_KEY
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Sender auth config checks suite', function () {
    it('requires a username for authentication', async function () {
        try {
            new Sender({
                bufferSize: 512,
                auth: {
                    token: 'privateKey'
                }
            });
            fail('it should not be able to create the sender');
        } catch(err) {
            expect(err.message).toBe('Missing username, please, specify the \'keyId\' property of the \'auth\' config option. ' +
                'For example: new Sender({auth: {keyId: \'username\', token: \'private key\'}})');
        }
    });

    it('requires a non-empty username', async function () {
        try {
            new Sender({
                bufferSize: 512,
                auth: {
                    keyId: '',
                    token: 'privateKey'
                }
            });
            fail('it should not be able to create the sender');
        } catch(err) {
            expect(err.message).toBe('Missing username, please, specify the \'keyId\' property of the \'auth\' config option. ' +
                'For example: new Sender({auth: {keyId: \'username\', token: \'private key\'}})');
        }
    });

    it('requires that the username is a string', async function () {
        try {
            new Sender({
                bufferSize: 512,
                auth: {
                    keyId: 23,
                    token: 'privateKey'
                }
            });
            fail('it should not be able to create the sender');
        } catch(err) {
            expect(err.message).toBe('Please, specify the \'keyId\' property of the \'auth\' config option as a string. ' +
                'For example: new Sender({auth: {keyId: \'username\', token: \'private key\'}})');
        }
    });

    it('requires a private key for authentication', async function () {
        try {
            new Sender({
                auth: {
                    keyId: 'username'
                }
            });
            fail('it should not be able to create the sender');
        } catch(err) {
            expect(err.message).toBe('Missing private key, please, specify the \'token\' property of the \'auth\' config option. ' +
                'For example: new Sender({auth: {keyId: \'username\', token: \'private key\'}})');
        }
    });

    it('requires a non-empty private key', async function () {
        try {
            new Sender({
                auth: {
                    keyId: 'username',
                    token: ''
                }
            });
            fail('it should not be able to create the sender');
        } catch(err) {
            expect(err.message).toBe('Missing private key, please, specify the \'token\' property of the \'auth\' config option. ' +
                'For example: new Sender({auth: {keyId: \'username\', token: \'private key\'}})');
        }
    });

    it('requires that the private key is a string', async function () {
        try {
            new Sender({
                auth: {
                    keyId: 'username',
                    token: true
                }
            });
            fail('it should not be able to create the sender');
        } catch(err) {
            expect(err.message).toBe('Please, specify the \'token\' property of the \'auth\' config option as a string. ' +
                'For example: new Sender({auth: {keyId: \'username\', token: \'private key\'}})');
        }
    });
});

describe('Sender connection suite', function () {
    async function createProxy(auth = false, tlsOptions = undefined) {
        const mockConfig = { auth: auth, assertions: true };
        const proxy = new MockProxy(mockConfig);
        await proxy.start(PROXY_PORT, tlsOptions);
        expect(proxy.mockConfig).toBe(mockConfig);
        expect(proxy.dataSentToRemote).toStrictEqual([]);
        return proxy;
    }

    async function createSender(auth = undefined, secure = false) {
        const sender = new Sender({bufferSize: 1024, auth: auth});
        const connected = await sender.connect(senderOptions, secure);
        expect(connected).toBe(true);
        return sender;
    }

    async function sendData(sender) {
        sender.table('test').symbol('location', 'us').floatColumn('temperature', 17.1).at(1658484765000000000n, 'ns');
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
        const sender = await createSender(AUTH);
        await sender.close();
        await assertSentData(proxy, true, 'testapp\n');
        await proxy.stop();
    });

    it('can authenticate with a different private key', async function () {
        const proxy = await createProxy(true);
        const sender = await createSender({
            keyId: 'user1',
            token: 'zhPiK3BkYMYJvRf5sqyrWNJwjDKHOWHnRbmQggUll6A'
        });
        await sender.close();
        await assertSentData(proxy, true, 'user1\n');
        await proxy.stop();
    });

    it('is backwards compatible and still can authenticate with full JWK', async function () {
        const JWK = {
            x: 'BtUXC_K3oAyGlsuPjTgkiwirMUJhuRQDfcUHeyoxFxU',
            y: 'R8SOup-rrNofB7wJagy4HrJhTVfrVKmj061lNRk3bF8',
            kid: 'user2',
            kty: 'EC',
            d: 'hsg6Zm4kSBlIEvKUWT3kif-2y2Wxw-iWaGrJxrPXQhs',
            crv: 'P-256'
        }

        const proxy = await createProxy(true);
        const sender = new Sender({jwk: JWK});
        const connected = await sender.connect(senderOptions, false);
        expect(connected).toBe(true);
        await sender.close();
        await assertSentData(proxy, true, 'user2\n');
        await proxy.stop();
    });

    it('can connect unauthenticated', async function () {
        const proxy = await createProxy();
        const sender = await createSender();
        await sender.close();
        await assertSentData(proxy, false, '');
        await proxy.stop();
    });

    it('can authenticate and send data to server', async function () {
        const proxy = await createProxy(true);
        const sender = await createSender(AUTH);
        await sendData(sender);
        await sender.close();
        await assertSentData(proxy, true, 'testapp\ntest,location=us temperature=17.1 1658484765000000000\n');
        await proxy.stop();
    });

    it('can connect unauthenticated and send data to server', async function () {
        const proxy = await createProxy();
        const sender = await createSender();
        await sendData(sender);
        await sender.close();
        await assertSentData(proxy, false, 'test,location=us temperature=17.1 1658484765000000000\n');
        await proxy.stop();
    });

    it('can authenticate and send data to server via secure connection', async function () {
        const proxy = await createProxy(true, proxyOptions);
        const sender = await createSender(AUTH, true);
        await sendData(sender);
        await sender.close();
        await assertSentData(proxy, true, 'testapp\ntest,location=us temperature=17.1 1658484765000000000\n');
        await proxy.stop();
    });

    it('can connect unauthenticated and send data to server via secure connection', async function () {
        const proxy = await createProxy(false, proxyOptions);
        const sender = await createSender(null, true);
        await sendData(sender);
        await sender.close();
        await assertSentData(proxy, false, 'test,location=us temperature=17.1 1658484765000000000\n');
        await proxy.stop();
    });

    it('guards against multiple connect calls', async function () {
        const proxy = await createProxy(true, proxyOptions);
        const sender = await createSender(AUTH, true);
        try {
            await sender.connect(senderOptions, true);
            fail('it should not be able to connect again');
        } catch(err) {
            expect(err.message).toBe('Sender connected already');
        }
        await sender.close();
        await proxy.stop();
    });

    it('guards against concurrent connect calls', async function () {
        const proxy = await createProxy(true, proxyOptions);
        const sender = new Sender({bufferSize: 1024, auth: AUTH});
        try {
            await Promise.all([sender.connect(senderOptions, true), sender.connect(senderOptions, true)]);
            fail('it should not be able to connect twice');
        } catch(err) {
            expect(err.message).toBe('Sender connected already');
        }
        await sender.close();
        await proxy.stop();
    });

    it('can handle unfinished rows during flush()', async function () {
        const proxy = await createProxy(true, proxyOptions);
        const sender = await createSender(AUTH, true);
        sender.table('test').symbol('location', 'us');
        const sent = await sender.flush();
        expect(sent).toBe(false);
        await sender.close();
        await assertSentData(proxy, true, 'testapp\n');
        await proxy.stop();
    });

    it('supports custom logger', async function () {
        const expectedMessages = [
            'Successfully connected to 127.0.0.1:9099',
            'Connection to 127.0.0.1:9099 is closed'
        ];
        const log = (level, message) => {
            expect(level).toBe('info');
            expect(message).toBe(expectedMessages.shift());
        };
        const proxy = await createProxy();
        const sender = new Sender({bufferSize: 1024, log: log});
        await sender.connect(senderOptions);
        await sendData(sender);
        await sender.close();
        await assertSentData(proxy, false, 'test,location=us temperature=17.1 1658484765000000000\n');
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
                            case 'STRING':
                                sender.stringColumn(column.name, column.value);
                                break;
                            case 'LONG':
                                sender.intColumn(column.name, column.value);
                                break;
                            case 'DOUBLE':
                                sender.floatColumn(column.name, column.value);
                                break;
                            case 'BOOLEAN':
                                sender.booleanColumn(column.name, column.value);
                                break;
                            case 'TIMESTAMP':
                                sender.timestampColumn(column.name, column.value);
                                break;
                            default:
                                throw new Error('Unsupported column type');
                        }
                    }
                    sender.atNow();
                } catch (e) {
                    if (testCase.result.status !== 'ERROR') {
                        fail('Did not expect error: ' + e.message);
                        break;
                    }
                    continue;
                }

                const buffer = sender.toBufferView();
                if (testCase.result.status === 'SUCCESS') {
                    if (testCase.result.line) {
                        expect(buffer.toString()).toBe(testCase.result.line + '\n');
                    } else {
                        for (const line of testCase.result.anyLines) {
                            if (buffer.toString() === line + '\n') {
                                // test passed
                                continue loopTestCase;
                            }
                        }
                        fail('Line is not matching any of the expected results: ' + buffer.toString());
                    }
                } else {
                    fail('Expected error missing, instead we have a line: ' + buffer.toString());
                    break;
                }
            }
    });
});

describe('Sender message builder test suite (anything not covered in client interop test suite)', function () {
    it('throws on invalid timestamp unit', function () {
        const sender = new Sender({bufferSize: 1024});
        try {
            sender.table('tableName')
                .booleanColumn('boolCol', true)
                .timestampColumn('timestampCol', 1658484765000000, 'foobar')
                .atNow();
        } catch(err) {
            expect(err.message).toBe('Unknown timestamp unit: foobar');
        }
    });

    it('supports timestamp field as number', function () {
        const sender = new Sender({bufferSize: 1024});
        sender.table('tableName')
            .booleanColumn('boolCol', true)
            .timestampColumn('timestampCol', 1658484765000000)
            .atNow();
        expect(sender.toBufferView().toString()).toBe(
            'tableName boolCol=t,timestampCol=1658484765000000t\n'
        );
    });

    it('supports timestamp field as ns number', function () {
        const sender = new Sender({bufferSize: 1024});
        sender.table('tableName')
            .booleanColumn('boolCol', true)
            .timestampColumn('timestampCol', 1658484765000000, 'ns')
            .atNow();
        expect(sender.toBufferView().toString()).toBe(
            'tableName boolCol=t,timestampCol=1658484765000t\n'
        );
    });

    it('supports timestamp field as us number', function () {
        const sender = new Sender({bufferSize: 1024});
        sender.table('tableName')
            .booleanColumn('boolCol', true)
            .timestampColumn('timestampCol', 1658484765000000, 'us')
            .atNow();
        expect(sender.toBufferView().toString()).toBe(
            'tableName boolCol=t,timestampCol=1658484765000000t\n'
        );
    });

    it('supports timestamp field as ms number', function () {
        const sender = new Sender({bufferSize: 1024});
        sender.table('tableName')
            .booleanColumn('boolCol', true)
            .timestampColumn('timestampCol', 1658484765000, 'ms')
            .atNow();
        expect(sender.toBufferView().toString()).toBe(
            'tableName boolCol=t,timestampCol=1658484765000000t\n'
        );
    });

    it('supports timestamp field as BigInt', function () {
        const sender = new Sender({bufferSize: 1024});
        sender.table('tableName')
            .booleanColumn('boolCol', true)
            .timestampColumn('timestampCol', 1658484765000000n)
            .atNow();
        expect(sender.toBufferView().toString()).toBe(
            'tableName boolCol=t,timestampCol=1658484765000000t\n'
        );
    });

    it('supports timestamp field as ns BigInt', function () {
        const sender = new Sender({bufferSize: 1024});
        sender.table('tableName')
            .booleanColumn('boolCol', true)
            .timestampColumn('timestampCol', 1658484765000000000n, 'ns')
            .atNow();
        expect(sender.toBufferView().toString()).toBe(
            'tableName boolCol=t,timestampCol=1658484765000000t\n'
        );
    });

    it('supports timestamp field as us BigInt', function () {
        const sender = new Sender({bufferSize: 1024});
        sender.table('tableName')
            .booleanColumn('boolCol', true)
            .timestampColumn('timestampCol', 1658484765000000n, 'us')
            .atNow();
        expect(sender.toBufferView().toString()).toBe(
            'tableName boolCol=t,timestampCol=1658484765000000t\n'
        );
    });

    it('supports timestamp field as ms BigInt', function () {
        const sender = new Sender({bufferSize: 1024});
        sender.table('tableName')
            .booleanColumn('boolCol', true)
            .timestampColumn('timestampCol', 1658484765000n, 'ms')
            .atNow();
        expect(sender.toBufferView().toString()).toBe(
            'tableName boolCol=t,timestampCol=1658484765000000t\n'
        );
    });

    it('throws on invalid designated timestamp unit', function () {
        const sender = new Sender({bufferSize: 1024});
        try {
            sender.table('tableName')
                .booleanColumn('boolCol', true)
                .timestampColumn('timestampCol', 1658484765000000)
                .at(1658484769000000, 'foobar');
        } catch(err) {
            expect(err.message).toBe('Unknown timestamp unit: foobar');
        }
    });

    it('supports setting designated us timestamp as number from client', function () {
        const sender = new Sender({bufferSize: 1024});
        sender.table('tableName')
            .booleanColumn('boolCol', true)
            .timestampColumn('timestampCol', 1658484765000000)
            .at(1658484769000000, 'us');
        expect(sender.toBufferView().toString()).toBe(
            'tableName boolCol=t,timestampCol=1658484765000000t 1658484769000000000\n'
        );
    });

    it('supports setting designated ms timestamp as number from client', function () {
        const sender = new Sender({bufferSize: 1024});
        sender.table('tableName')
            .booleanColumn('boolCol', true)
            .timestampColumn('timestampCol', 1658484765000000)
            .at(1658484769000, 'ms');
        expect(sender.toBufferView().toString()).toBe(
            'tableName boolCol=t,timestampCol=1658484765000000t 1658484769000000000\n'
        );
    });

    it('supports setting designated timestamp as BigInt from client', function () {
        const sender = new Sender({bufferSize: 1024});
        sender.table('tableName')
            .booleanColumn('boolCol', true)
            .timestampColumn('timestampCol', 1658484765000000)
            .at(1658484769000000n);
        expect(sender.toBufferView().toString()).toBe(
            'tableName boolCol=t,timestampCol=1658484765000000t 1658484769000000000\n'
        );
    });

    it('supports setting designated ns timestamp as BigInt from client', function () {
        const sender = new Sender({bufferSize: 1024});
        sender.table('tableName')
            .booleanColumn('boolCol', true)
            .timestampColumn('timestampCol', 1658484765000000)
            .at(1658484769000000123n, 'ns');
        expect(sender.toBufferView().toString()).toBe(
            'tableName boolCol=t,timestampCol=1658484765000000t 1658484769000000123\n'
        );
    });

    it('supports setting designated us timestamp as BigInt from client', function () {
        const sender = new Sender({bufferSize: 1024});
        sender.table('tableName')
            .booleanColumn('boolCol', true)
            .timestampColumn('timestampCol', 1658484765000000)
            .at(1658484769000000n, 'us');
        expect(sender.toBufferView().toString()).toBe(
            'tableName boolCol=t,timestampCol=1658484765000000t 1658484769000000000\n'
        );
    });

    it('supports setting designated ms timestamp as BigInt from client', function () {
        const sender = new Sender({bufferSize: 1024});
        sender.table('tableName')
            .booleanColumn('boolCol', true)
            .timestampColumn('timestampCol', 1658484765000000)
            .at(1658484769000n, 'ms');
        expect(sender.toBufferView().toString()).toBe(
            'tableName boolCol=t,timestampCol=1658484765000000t 1658484769000000000\n'
        );
    });

    it('throws exception if table name is not a string', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table(23456)
        ).toThrow('Table name must be a string, received number');
    });

    it('throws exception if table name is too long', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table('123456789012345678901234567890123456789012345678901234567890'
                + '12345678901234567890123456789012345678901234567890123456789012345678')
        ).toThrow('Table name is too long, max length is 127');
    });

    it('throws exception if table name is set more times', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table('tableName')
                .symbol('name', 'value')
                .table('newTableName')
        ).toThrow('Table name has already been set');
    });

    it('throws exception if symbol name is not a string', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table('tableName')
                .symbol(12345.5656, 'value')
        ).toThrow('Symbol name must be a string, received number');
    });

    it('throws exception if symbol name is empty string', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table('tableName')
                .symbol('', 'value')
        ).toThrow('Empty string is not allowed as column name');
    });

    it('throws exception if column name is not a string', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table('tableName')
                .stringColumn(12345.5656, 'value')
        ).toThrow('Column name must be a string, received number');
    });

    it('throws exception if column name is empty string', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table('tableName')
                .stringColumn('', 'value')
        ).toThrow('Empty string is not allowed as column name');
    });

    it('throws exception if column name is too long', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table('tableName')
                .stringColumn('123456789012345678901234567890123456789012345678901234567890'
                    + '12345678901234567890123456789012345678901234567890123456789012345678', 'value')
        ).toThrow('Column name is too long, max length is 127');
    });

    it('throws exception if column value is not the right type', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table('tableName')
                .stringColumn('columnName', false)
        ).toThrow('Column value must be of type string, received boolean');
    });

    it('throws exception if adding column without setting table name', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.floatColumn('name', 12.459)
        ).toThrow('Column can be set only after table name is set');
    });

    it('throws exception if adding symbol without setting table name', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.symbol('name', 'value')
        ).toThrow('Symbol can be added only after table name is set and before any column added');
    });

    it('throws exception if adding symbol after columns', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table('tableName')
                .stringColumn('name', 'value')
                .symbol('symbolName', 'symbolValue')
        ).toThrow('Symbol can be added only after table name is set and before any column added');
    });

    it('returns null if preparing an empty buffer for send', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(sender.toBufferView()).toBe(null);
    });

    it('ignores unfinished rows when preparing a buffer for send', function () {
        const sender = new Sender({bufferSize: 1024});
        sender.table('tableName')
            .symbol('name', 'value')
            .at(1234567890n, 'ns');
        sender.table('tableName')
            .symbol('name', 'value2');
        expect(
            sender.toBufferView(sender.endOfLastRow).toString()
        ).toBe('tableName,name=value 1234567890\n');
    });

    it('throws exception if a float is passed as integer field', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table('tableName')
                .intColumn('intField', 123.222)
        ).toThrow('Value must be an integer, received 123.222');
    });

    it('throws exception if a float is passed as timestamp field', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table('tableName')
                .timestampColumn('intField', 123.222)
        ).toThrow('Value must be an integer or BigInt, received 123.222');
    });

    it('throws exception if designated timestamp is not an integer or bigint', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table('tableName')
                .symbol('name', 'value')
                .at(23232322323.05)
        ).toThrow('Designated timestamp must be an integer or BigInt, received 23232322323.05');
    });

    it('throws exception if designated timestamp is invalid', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table('tableName')
                .symbol('name', 'value')
                .at('invalid_dts')
        ).toThrow('Designated timestamp must be an integer or BigInt, received invalid_dts');
    });

    it('throws exception if designated timestamp is set without any fields added', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(
            () => sender.table('tableName')
                .at(12345678n, 'ns')
        ).toThrow('The row must have a symbol or column set before it is closed');
    });

    it('extends the size of the buffer if data does not fit', function () {
        const sender = new Sender({bufferSize: 8});
        expect(sender.bufferSize).toBe(8);
        expect(sender.position).toBe(0);
        sender.table('tableName');
        expect(sender.bufferSize).toBe(16);
        expect(sender.position).toBe('tableName'.length);
        sender.intColumn('intField', 123);
        expect(sender.bufferSize).toBe(32);
        expect(sender.position).toBe('tableName intField=123i'.length);
        sender.atNow();
        expect(sender.bufferSize).toBe(32);
        expect(sender.position).toBe('tableName intField=123i\n'.length);
        expect(sender.toBufferView().toString()).toBe(
            'tableName intField=123i\n'
        );

        sender.table('table2')
            .intColumn('intField', 125)
            .stringColumn('strField', 'test')
            .atNow();
        expect(sender.bufferSize).toBe(64);
        expect(sender.position).toBe('tableName intField=123i\ntable2 intField=125i,strField="test"\n'.length);
        expect(sender.toBufferView().toString()).toBe(
            'tableName intField=123i\ntable2 intField=125i,strField="test"\n'
        );
    });

    it('is possible to clear the buffer by calling reset()', function () {
        const sender = new Sender({bufferSize: 1024});
        sender.table('tableName')
            .booleanColumn('boolCol', true)
            .timestampColumn('timestampCol', 1658484765000000)
            .atNow();
        sender.table('tableName')
            .booleanColumn('boolCol', false)
            .timestampColumn('timestampCol', 1658484766000000)
            .atNow();
        expect(sender.toBufferView().toString()).toBe(
            'tableName boolCol=t,timestampCol=1658484765000000t\n'
            + 'tableName boolCol=f,timestampCol=1658484766000000t\n'
        );

        sender.reset();
        sender.table('tableName')
            .floatColumn('floatCol', 1234567890)
            .timestampColumn('timestampCol', 1658484767000000)
            .atNow();
        expect(sender.toBufferView().toString()).toBe(
            'tableName floatCol=1234567890,timestampCol=1658484767000000t\n'
        );
    });
});

describe('Sender options test suite', function () {
    it('does copy the buffer during flush() if no options defined', function () {
        const sender = new Sender();
        expect(sender.toBuffer).toBe(sender.toBufferNew);
    });

    it('does copy the buffer during flush() if options are null', function () {
        const sender = new Sender(null);
        expect(sender.toBuffer).toBe(sender.toBufferNew);
    });

    it('does copy the buffer during flush() if options are undefined', function () {
        const sender = new Sender(undefined);
        expect(sender.toBuffer).toBe(sender.toBufferNew);
    });

    it('does copy the buffer during flush() if options are empty', function () {
        const sender = new Sender({});
        expect(sender.toBuffer).toBe(sender.toBufferNew);
    });

    it('does copy the buffer during flush() if copyBuffer is not set', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(sender.toBuffer).toBe(sender.toBufferNew);
    });

    it('does copy the buffer during flush() if copyBuffer is set to true', function () {
        const sender = new Sender({copyBuffer: true});
        expect(sender.toBuffer).toBe(sender.toBufferNew);
    });

    it('does copy the buffer during flush() if copyBuffer is not a boolean', function () {
        const sender = new Sender({copyBuffer: ''});
        expect(sender.toBuffer).toBe(sender.toBufferNew);
    });

    it('does not copy the buffer during flush() if copyBuffer is set to false', function () {
        const sender = new Sender({copyBuffer: false});
        expect(sender.toBuffer).toBe(sender.toBufferView);
    });

    it('does not copy the buffer during flush() if copyBuffer is set to null', function () {
        const sender = new Sender({copyBuffer: null});
        expect(sender.toBuffer).toBe(sender.toBufferNew);
    });

    it('does not copy the buffer during flush() if copyBuffer is undefined', function () {
        const sender = new Sender({copyBuffer: undefined});
        expect(sender.toBuffer).toBe(sender.toBufferNew);
    });

    it('sets default buffer size if no options defined', function () {
        const sender = new Sender();
        expect(sender.bufferSize).toBe(DEFAULT_BUFFER_SIZE);
    });

    it('sets default buffer size if options are null', function () {
        const sender = new Sender(null);
        expect(sender.bufferSize).toBe(DEFAULT_BUFFER_SIZE);
    });

    it('sets default buffer size if options are undefined', function () {
        const sender = new Sender(undefined);
        expect(sender.bufferSize).toBe(DEFAULT_BUFFER_SIZE);
    });

    it('sets default buffer size if options are empty', function () {
        const sender = new Sender({});
        expect(sender.bufferSize).toBe(DEFAULT_BUFFER_SIZE);
    });

    it('sets default buffer size if bufferSize is not set', function () {
        const sender = new Sender({copyBuffer: true});
        expect(sender.bufferSize).toBe(DEFAULT_BUFFER_SIZE);
    });

    it('sets the requested buffer size if bufferSize is set', function () {
        const sender = new Sender({bufferSize: 1024});
        expect(sender.bufferSize).toBe(1024);
    });

    it('sets default buffer size if bufferSize is set to null', function () {
        const sender = new Sender({bufferSize: null});
        expect(sender.bufferSize).toBe(DEFAULT_BUFFER_SIZE);
    });

    it('sets default buffer size if bufferSize is set to undefined', function () {
        const sender = new Sender({bufferSize: undefined});
        expect(sender.bufferSize).toBe(DEFAULT_BUFFER_SIZE);
    });

    it('sets default buffer size if bufferSize is not a number', function () {
        const sender = new Sender({bufferSize: '1024'});
        expect(sender.bufferSize).toBe(DEFAULT_BUFFER_SIZE);
    });

    it('uses default logger if no options defined', function () {
        const sender = new Sender();
        expect(sender.log).toBe(log);
    });

    it('uses default logger if options are null', function () {
        const sender = new Sender(null);
        expect(sender.log).toBe(log);
    });

    it('uses default logger if options are undefined', function () {
        const sender = new Sender(undefined);
        expect(sender.log).toBe(log);
    });

    it('uses default logger if options are empty', function () {
        const sender = new Sender({});
        expect(sender.log).toBe(log);
    });

    it('uses default logger if log function is not set', function () {
        const sender = new Sender({copyBuffer: true});
        expect(sender.log).toBe(log);
    });

    it('uses the required log function if it is set', function () {
        const testFunc = () => {};
        const sender = new Sender({log: testFunc});
        expect(sender.log).toBe(testFunc);
    });

    it('uses default logger if log is set to null', function () {
        const sender = new Sender({log: null});
        expect(sender.log).toBe(log);
    });

    it('uses default logger if log is set to undefined', function () {
        const sender = new Sender({log: undefined});
        expect(sender.log).toBe(log);
    });

    it('uses default logger if log is not a function', function () {
        const sender = new Sender({log: ''});
        expect(sender.log).toBe(log);
    });
});

describe('Sender tests with containerized QuestDB instance', () => {
    let container;

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
                    const body = [];
                    response.on('data', data => {
                        body.push(data);
                    }).on('end', () => {
                        resolve(JSON.parse(Buffer.concat(body).toString()));
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
        let fields = '';
        for (const element of schema) {
            fields += `${element.name} ${element.type}, `;
        }
        return fields.substring(0, fields.length - 2);
    }

    beforeAll(async () => {
        jest.setTimeout(3000000);
        container = await new GenericContainer('questdb/questdb:7.3.2')
            .withExposedPorts(QUESTDB_HTTP_PORT, QUESTDB_ILP_PORT)
            .start();

        const stream = await container.logs();
        stream
            .on('data', line => console.log(line))
            .on('err', line => console.error(line))
            .on('end', () => console.log('Stream closed'));
    });

    afterAll(async () => {
        await container.stop();
    });

    it('can ingest data and run queries', async () => {
        const sender = new Sender();
        await sender.connect({host: container.getHost(), port: container.getMappedPort(QUESTDB_ILP_PORT)});

        const tableName = 'test';
        const schema = [
            {name: 'location', type: 'SYMBOL'},
            {name: 'temperature', type: 'DOUBLE'},
            {name: 'timestamp', type: 'TIMESTAMP'}
        ];

        // create table
        let createTableResult = await query(container,
            `CREATE TABLE ${tableName}(${getFieldsString(schema)}) TIMESTAMP (timestamp) PARTITION BY DAY BYPASS WAL;`
        );
        expect(createTableResult.ddl).toBe('OK');

        // alter table
        let alterTableResult = await query(container,
            `ALTER TABLE ${tableName} SET PARAM maxUncommittedRows = 1;`
        );
        expect(alterTableResult.ddl).toBe('OK');

        // ingest via client
        sender.table(tableName).symbol('location', 'us').floatColumn('temperature', 17.1).at(1658484765000000000n, 'ns');
        await sender.flush();

        // query table
        const select1Result = await runSelect(container, tableName, 1);
        expect(select1Result.query).toBe(tableName);
        expect(select1Result.count).toBe(1);
        expect(select1Result.columns).toStrictEqual(schema);
        expect(select1Result.dataset).toStrictEqual([
            ['us',17.1,'2022-07-22T10:12:45.000000Z']
        ]);

        // ingest via client, add new column
        sender.table(tableName).symbol('location', 'us').floatColumn('temperature', 17.3).at(1658484765000666000n, 'ns');
        sender.table(tableName).symbol('location', 'emea').floatColumn('temperature', 17.4).at(1658484765000999000n, 'ns');
        sender.table(tableName).symbol('location', 'emea').symbol('city', 'london').floatColumn('temperature', 18.8).at(1658484765001234000n, 'ns');
        await sender.flush();

        // query table
        const select2Result = await runSelect(container, tableName, 4);
        expect(select2Result.query).toBe('test');
        expect(select2Result.count).toBe(4);
        expect(select2Result.columns).toStrictEqual([
            {name: 'location', type: 'SYMBOL'},
            {name: 'temperature', type: 'DOUBLE'},
            {name: 'timestamp', type: 'TIMESTAMP'},
            {name: 'city', type: 'SYMBOL'}
        ]);
        expect(select2Result.dataset).toStrictEqual([
            ['us',17.1,'2022-07-22T10:12:45.000000Z',null],
            ['us',17.3,'2022-07-22T10:12:45.000666Z',null],
            ['emea',17.4,'2022-07-22T10:12:45.000999Z',null],
            ['emea',18.8,'2022-07-22T10:12:45.001234Z','london']
        ]);

        await sender.close();
    });

    it('does not duplicate rows if await is missing when calling flush', async () => {
        // setting copyBuffer to make sure promises send data from their own local buffer
        const sender = new Sender({ copyBuffer: true });
        await sender.connect({host: container.getHost(), port: container.getMappedPort(QUESTDB_ILP_PORT)});

        const tableName = 'test2';
        const schema = [
            {name: 'location', type: 'SYMBOL'},
            {name: 'temperature', type: 'DOUBLE'},
            {name: 'timestamp', type: 'TIMESTAMP'}
        ];

        // create table
        let createTableResult = await query(container,
            `CREATE TABLE ${tableName}(${getFieldsString(schema)}) TIMESTAMP (timestamp) PARTITION BY DAY BYPASS WAL;`
        );
        expect(createTableResult.ddl).toBe('OK');

        // alter table
        let alterTableResult = await query(container,
            `ALTER TABLE ${tableName} SET PARAM maxUncommittedRows = 1;`
        );
        expect(alterTableResult.ddl).toBe('OK');

        // ingest via client
        const numOfRows = 100;
        for (let i = 0; i < numOfRows; i++) {
            sender.table(tableName).symbol('location', 'us').floatColumn('temperature', i).at(1658484765000000000n, 'ns');
            // missing await is intentional
            sender.flush();
        }

        // query table
        const selectQuery = `${tableName} order by temperature`;
        const selectResult = await runSelect(container, selectQuery, numOfRows);
        expect(selectResult.query).toBe(selectQuery);
        expect(selectResult.count).toBe(numOfRows);
        expect(selectResult.columns).toStrictEqual(schema);

        const expectedData = [];
        for (let i = 0; i < numOfRows; i++) {
            expectedData.push(['us',i,'2022-07-22T10:12:45.000000Z']);
        }
        expect(selectResult.dataset).toStrictEqual(expectedData);

        await sender.close();
    });
});
