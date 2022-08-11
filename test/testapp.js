'use strict';

const { Proxy } = require("./proxy");
const { Sender } = require("../index");
const { readFileSync } = require('fs');

const PROXY_PORT = 9099;
const PORT = 9009;
const HOST = "127.0.0.1";

const PRIVATE_KEY = "9b9x5WhJywDEuo1KGQWSPNxtX-6X6R2BRCKhYMMY6n8";
const PUBLIC_KEY = {
    x: "aultdA0PjhD_cWViqKKyL5chm6H1n-BiZBo_48T-uqc",
    y: "__ptaol41JWSpTTL525yVEfzmY8A6Vi_QrW1FjKcHMg"
};
const JWK = {
    ...PUBLIC_KEY,
    kid: "testapp",
    kty: "EC",
    d: PRIVATE_KEY,
    crv: "P-256",
};

const senderTLS = {
    host: HOST,
    port: PROXY_PORT,
    ca: readFileSync('certs/ca/ca.crt') // necessary only if the server uses self-signed certificate
};

const proxyTLS = {
    key: readFileSync('certs/server/server.key'),
    cert: readFileSync('certs/server/server.crt'),
    ca: readFileSync('certs/ca/ca.crt') // authority chain for the clients
};

async function run() {
    const proxy = new Proxy();
    await proxy.start(PROXY_PORT, PORT, HOST, proxyTLS);

    const sender = new Sender(1024, JWK); //with authentication
    const connected = await sender.connect(senderTLS, true); //connection through proxy with encryption
    if (connected) {
        sender.table("test")
            .symbol("location", "emea").symbol("city", "budapest")
            .stringColumn("hoppa", "hello").stringColumn("hippi", "hello").stringColumn("hippo", "haho")
            .floatColumn("temperature", 14.1).intColumn("intcol", 56).timestampColumn("tscol", Date.now() * 1000)
            .atNow();
        sender.table("test")
            .symbol("location", "asia").symbol("city", "singapore")
            .stringColumn("hoppa", "hi").stringColumn("hopp", "hello").stringColumn("hippo", "huhu")
            .floatColumn("temperature", 7.1)
            .at("1658484765000555000");

        console.log("sending:\n" + sender.toBuffer().toString());
        await sender.flush();

        sender.table("test")
            .symbol("location", "emea").symbol("city", "miskolc")
            .stringColumn("hoppa", "hello").stringColumn("hippi", "hello").stringColumn("hippo", "lalalala")
            .floatColumn("temperature", 13.1).intColumn("intcol", 333)
            .atNow();

        console.log("sending:\n" + sender.toBuffer().toString());
        await sender.flush();
    }
    await sender.close();

    await proxy.stop();
    return 0;
}

run().then(value => console.log(value))
    .catch(err => console.log(err));
