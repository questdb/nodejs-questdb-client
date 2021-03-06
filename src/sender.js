const { Socket } = require("net");
const { Buffer } = require("buffer");
const crypto = require('crypto');

class Sender {
    constructor(jwk = null) {
        this.jwk = jwk;
        this.socket = new Socket();

        this.socket.on("close", async () => {
            console.log("connection closed");
        });

        this.socket.on("error", async err => {
            console.error(err);
            process.exit(1);
        });
    }

    async connect(port, host) {
        let self = this;
        let authenticated = false;

        return new Promise((resolve, reject) => {
            let data;
            this.socket.on("data", async raw => {
                data = !data ? raw : Buffer.concat([data, raw]);
                //console.log(`received: ${data}`);
                if (!authenticated) {
                    authenticated = await authenticate(self, data);
                    authenticated ? resolve(true) : reject(false);
                }
            });

            this.socket.on("ready", async () => {
                console.log("connection ready");
                if (self.jwk) {
                    console.log("authenticating with server");
                    await self.send(`${self.jwk.kid}\n`);
                } else {
                    console.log("no authentication");
                    authenticated = true;
                    resolve(true);
                }
            });

            this.socket.connect(port, host);
        });
    }

    async close() {
        console.log("closing connection")
        return new Promise(resolve => {
            this.socket.destroy();
            resolve();
        });
    }

    async send(data) {
        return new Promise(resolve => {
            this.socket.write(data, 'utf8', () => {
                resolve();
            });
        });
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

        await sender.send(`${Buffer.from(signature).toString("base64")}\n`);
        return true;
    }
    return false;
}

exports.Sender = Sender;
