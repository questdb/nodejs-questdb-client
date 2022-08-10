const { Proxy } = require("./proxy");
const { Sender, Micros } = require("../index");
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
    ca: readFileSync('../certs/ca/ca.crt') // necessary only if the server uses self-signed certificate
};

const proxyTLS = {
    key: readFileSync('../certs/server/server.key'),
    cert: readFileSync('../certs/server/server.crt'),
    ca: readFileSync('../certs/ca/ca.crt') // authority chain for the clients
};

async function run() {
    const proxy = new Proxy();
    await proxy.start(PROXY_PORT, PORT, HOST, proxyTLS);

    const sender = new Sender(1024, JWK); //with authentication

    const connected = await sender.connect(senderTLS, true); //connection through proxy with encryption
    console.log("connected=" + connected);
    if (connected) {
        const rows1 = [
            {
                "table": "test",
                "symbols": { "location": "emea", "city": "budapest" },
                "columns": { "hoppa": "hello", "hippi": "hello", "hippo": "haho", "temperature": 14.1, "intcol": 56n, "tscol": new Micros() }
            },
            {
                "table": "test",
                "symbols": { "location": "asia", "city": "singapore" },
                "columns": { "hoppa": "hi", "hippi": "hopp", "hippo": "huhu", "temperature": 7.1 },
                "timestamp": 1658484765000555000n
            }
        ];

        console.log("sending: " + JSON.stringify(rows1, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
        ));
        sender.rows(rows1);

        const rows2 = {
            "table": "test",
            "symbols": { "location": "emea", "city": "miskolc"},
            "columns": { "hoppa": "hello", "hippi": "hello", "hippo": "lalalala", "temperature": 13.1 }
        };

        console.log("sending: " + JSON.stringify(rows2, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
        ));
        sender.rows(rows2);

        await sender.flush();
    }
    await sender.close();

    await proxy.stop();
    return 0;
}

run().then(value => console.log(value))
    .catch(err => console.log(err));
