'use strict';

const { Sender } = require("../index");
const { readFileSync } = require('fs');

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
    port: PORT,
    ca: readFileSync('certs/ca/ca.crt') // necessary only if the server uses self-signed certificate
};

async function run() {
    const tableName = "test";

    const sender = new Sender({bufferSize: 131072, jwk: JWK});
    await sender.connect(senderTLS);
    const numOfRows = 300000;
    for (let i = 0; i < numOfRows; i++) {
        sender.table(tableName)
            .symbol("location", `emea${i}`).symbol("city", `budapest${i}`)
            .stringColumn("hoppa", `hello${i}`).stringColumn("hippi", `hel${i}`).stringColumn("hippo", `haho${i}`)
            .floatColumn("temperature", 12.1).intColumn("intcol", i)
            .atNow();
        if (i % 1000 === 0) {
            await sender.flush();
        }
    }
    await sender.flush();
    await sender.close();

    return 0;
}

run().then(value => console.log(value))
    .catch(err => console.log(err));
