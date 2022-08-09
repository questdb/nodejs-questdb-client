const { Buffer } = require("buffer");
const { Builder } = require("./builder");
const { Row } = require("./row");
const { connect, NetConnectOpts } = require("net");
const { connect: connectTLS, ConnectionOptions} = require("tls");
const crypto = require('crypto');

/** @classdesc
 * The QuestDB client's API provides methods to connect to the database, ingest data and close the connection.
 * <p>
 * The client supports authentication. <br>
 * A JsonWebKey can be passed to the Sender in its constructor, the JsonWebKey will be used for authentication. <br>
 * If no JsonWebKey specified the client will not attempt to authenticate itself with the server. <br>
 * Details on how to configure QuestDB authentication: {@link https://questdb.io/docs/reference/api/ilp/authenticate}
 * </p>
 * <p>
 * The client also supports TLS encryption to provide a secure connection. <br>
 * However, QuestDB does not support TLS yet and requires an external reverse-proxy, such as Nginx to enable encryption.
 * </p>
 */
class Sender {

    /**
     * Creates an instance of Sender.
     *
     * @param {number} bufferSize - Size of the buffer used by the sender to collect rows, provided in bytes.
     * @param {{x: string, y: string, kid: string, kty: string, d: string, crv: string}} [jwk = undefined] - JWK for authentication, client is not authenticated if not provided. <br> Server might reject the connection depending on configuration.
     */
    constructor(bufferSize, jwk = undefined) {
        /** @private */
        this.builder = new Builder(bufferSize);
        /** @private */
        this.jwk = jwk;
    }

    /**
     * Creates a connection to the database.
     *
     * @param {NetConnectOpts | ConnectionOptions} options - Connection options, host and port are required.
     * @param {boolean} [secure = false] - If true connection will use TLS encryption.
     */
    async connect(options, secure = false) {
        let self = this;

        return new Promise((resolve, reject) => {
            let authenticated = false;
            let data;

            /** @private */
            this.socket = !secure
                ? connect(options)
                : connectTLS(options, async () => {
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
     * @param {Row[] | Row} rows - The row or a list of rows to ingest.
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
