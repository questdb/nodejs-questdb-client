const { Proxy } = require("./proxy");
const { Sender, Builder } = require("../index");

const PROXY_PORT = 9099;
const PORT = 9009;
const HOST = "127.0.0.1";

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

const rows = [
    `test,location=us temperature=22.4,hoppa="hoppa str" ${Date.now() * 1e6}`,
    `test,location=us temperature=22.4,hoppa="hoppa string" ${Date.now() * 1e6}`
];

async function run () {
    const proxy = new Proxy();
    await proxy.start(PROXY_PORT, PORT, HOST);

    const sender = new Sender(JWK);
    const connected = await sender.connect(PROXY_PORT, HOST);
    console.log("connected=" + connected);
    if (connected) {
        const builder = new Builder(1024);
        builder.addTable("test")
            .addSymbol("location", "emea")
            .addSymbol("city", "budapest")
            .addString("hoppa", "hello")
            .addString("hippi", 'hello')
            .addString("hippo", new String('haho').toString())
            .addFloat("temperature", 14.1)
            .atNow();
        builder.addTable("test")
            .addSymbol("location", "asia")
            .addSymbol("city", "singapore")
            .addString("hoppa", "hi")
            .addString("hippi", 'hopp')
            .addString("hippo", "huhu")
            .addFloat("temperature", 7.1)
            .at(1658484765000000000);

        let buffer = builder.toBuffer();
        console.log("sending:\n" + buffer.toString());
        await sender.send(buffer);

        await sender.sendRows(rows);

        builder.reset().addTable("test")
            .addSymbol("location", "emea")
            .addSymbol("city", "miskolc")
            .addString("hoppa", "hello")
            .addString("hippi", 'hello')
            .addString("hippo", "lalalala")
            .addFloat("temperature", 13.1)
            .atNow();

        buffer = builder.toBuffer();
        console.log("sending:\n" + buffer.toString());
        await sender.send(buffer);
    }
    await sender.close();

    await proxy.shutdown();
    return 0;
}

run().then(value => console.log(value))
    .catch(err => console.log(err));
