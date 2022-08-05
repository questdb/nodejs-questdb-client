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

    // Necessary only if using the client certificate authentication
    //key: readFileSync('../certs/client/client.key'),
    //cert: readFileSync('../certs/client/client.crt'),

    // Necessary only if the server uses the self-signed certificate
    ca: readFileSync('../certs/ca/ca.crt')
};

const proxyTLS = {
    key: readFileSync('../certs/server/server.key'),
    cert: readFileSync('../certs/server/server.crt'),
    ca: readFileSync('../certs/ca/ca.crt'), // authority chain for the clients
    //requestCert: true, // ask for a client cert
    //rejectUnauthorized: false, // act on unauthorized clients at the app level
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run () {
    const proxy = new Proxy();
    //await proxy.start(PROXY_PORT, PORT, HOST, proxyTLS);
    await proxy.start(PROXY_PORT, PORT, HOST);

    const sender = new Sender(1024, JWK); //with authentication
    //const sender = new Sender(1024); // without authentication

    const connected = await sender.connect(PROXY_PORT, HOST, senderTLS); //connection through proxy with encryption
    //const connected = await sender.connect(PROXY_PORT, HOST); //connection through proxy without encryption
    //const connected = await sender.connect(PORT, HOST); //direct connection without proxy
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
        //await sleep(3000); //wait for proxy to forward data
    }
    await sender.close();

    await proxy.stop();
    return 0;
}

run().then(value => console.log(value))
    .catch(err => console.log(err));
