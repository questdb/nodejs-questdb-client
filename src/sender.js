const { Buffer } = require("buffer");
const { Builder } = require("./builder");
const { Nanos } = require("./timestamp");
const net = require("net");
const tls = require("tls");
const crypto = require('crypto');

/** @classdesc Sender QuestDB client. */
class Sender {

    /**
     * Creates an instance of Sender.
     *
     * @param {number} bufferSize - Size of the buffer used by the sender to collect rows, provided in bytes.
     * @param {{x: string, y: string, kid: string, kty: string, d: string, crv: string}} [jwk=null] - JWK for authentication, client is not authenticated if not provided. Server might reject the connection depending on configuration.
     */
    constructor(bufferSize, jwk = null) {
        /** @private */
        this.builder = new Builder(bufferSize);
        /** @private */
        this.jwk = jwk;
    }

    /**
     * Creates a connection to the database.
     *
     * @param {number} port - Port number of endpoint.
     * @param {string} host - Host name or IP address of endpoint.
     * @param {{host: string, port: number, ca: Buffer}} [tlsOptions=null] - TLS CA for encryption, connection is not encrypted if not provided.
     */
    async connect(port, host, tlsOptions = null) {
        let self = this;

        return new Promise((resolve, reject) => {
            let authenticated = false;
            let data;

            /** @private */
            this.socket = !tlsOptions
                ? net.connect(port, host)
                : tls.connect(tlsOptions, async () => {
                    if (!self.socket.authorized) {
                        reject("Problem with server's certificate");
                        await self.close();
                    }
                });

            this.socket.on("data", async raw => {
                data = !data ? raw : Buffer.concat([data, raw]);
                if (!authenticated) {
                    //console.log(`received: ${data}`);
                    authenticated = await authenticate(self, data);
                    authenticated ? resolve(true) : reject("Could not authenticate");
                } else {
                    console.warn(`received unexpected data: ${data}`);
                }
            })
            .on("ready", async () => {
                console.log("connection ready");
                if (self.jwk) {
                    console.log("authenticating with server");
                    self.socket.write(`${self.jwk.kid}\n`);
                } else {
                    console.log("no authentication");
                    authenticated = true;
                    resolve(true);
                }
            })
            .on("close", () => {
                console.log("connection closed");
            })
            .on("error", err => {
                console.error(err);
                process.exit(1);
            });
        });
    }

    /**
     * Closes the connection to the database.
     */
    async close() {
        console.log("closing connection")
        return new Promise(resolve => {
            this.socket.destroy();
            resolve();
        });
    }

    /**
     * Sends the buffer's content to the database and clears the buffer.
     */
    async flush() {
        const data = this.builder.toBuffer();
        return new Promise((resolve, reject) => {
            this.socket.write(data, err => {
                this.builder.reset();
                err ? reject(err.message) : resolve();
            });
        });
    }

    /**
     * Writes rows into the buffer.
     *
     * @param {{table: string, symbols: any[], columns: any[], timestamp: Nanos | bigint | number | string}} rows - The row or a list of rows to ingest.
     */
    rows(rows) {
        this.builder.addRows(rows);
    }
}

async function authenticate(sender, challenge) {
    // Check for trailing \n which ends the challenge
    if (challenge.slice(-1).readInt8() === 10) {
        const keyObject = await crypto.createPrivateKey(
            {'key': sender.jwk, 'format': 'jwk'}
        );
        const signature = await crypto.sign(
            "RSA-SHA256",
            challenge.slice(0, challenge.length - 1),
            keyObject
        );

        sender.socket.write(`${Buffer.from(signature).toString("base64")}\n`);
        return true;
    }
    return false;
}

exports.Sender = Sender;
