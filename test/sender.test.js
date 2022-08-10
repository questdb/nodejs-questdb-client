'use strict';

const { Sender } = require("../index");
const { MockProxy } = require("./mockproxy");
const { readFileSync} = require("fs");

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

async function createProxy(auth = false, tlsOptions = undefined) {
    const mockConfig = { auth: auth, assertions: true };
    const proxy = new MockProxy(mockConfig);
    await proxy.start(PROXY_PORT, tlsOptions);
    expect(proxy.mockConfig).toBe(mockConfig);
    expect(proxy.dataSentToRemote).toStrictEqual([]);
    return proxy;
}

async function createSender(jwk = undefined, secure = false) {
    const sender = new Sender(1024, jwk);
    const connected = await sender.connect(senderOptions, secure);
    expect(connected).toBe(true);
    return sender;
}

async function sendData(sender, rows = [{
                "table": "test",
                "symbols": { "location": "us" },
                "columns": { "temperature": 17.1 },
                "timestamp": 1658484765000000000
            }]) {
    sender.rows(rows);
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

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Sender test suite', function () {
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
});
