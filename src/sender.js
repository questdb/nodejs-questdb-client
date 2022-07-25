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

    async authenticate(jwk, challenge) {
        // Check for trailing \n which ends the challenge
        if (challenge.slice(-1).readInt8() === 10) {
            const keyObject = await crypto.createPrivateKey(
                {'key': jwk, 'format': 'jwk'}
            );
            const signature = await crypto.sign(
                "RSA-SHA256",
                challenge.slice(0, challenge.length - 1),
                keyObject
            );

            await this.write(`${Buffer.from(signature).toString("base64")}\n`);
            return true;
        }
        return false;
    }

    async connect(port, host) {
        let self = this;
        let authenticated = false;

        this.socket.on("ready", async () => {
            console.log("connection ready");
            if (self.jwk) {
                console.log("authenticating with server");
                await self.write(`${self.jwk.kid}\n`);
            } else {
                console.log("no authentication");
                authenticated = true;
            }
        });

        return new Promise((resolve, reject) => {
            let data;
            this.socket.on("data", async function (raw) {
                data = !data ? raw : Buffer.concat([data, raw]);
                console.log('received: ' + data);
                if (!authenticated) {
                    authenticated = await self.authenticate(self.jwk, data);
                    authenticated ? resolve(true) : reject(false);
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

    // data can be a buffer or a string
    async write(data) {
        return new Promise(resolve => {
            this.socket.write(data, 'utf8', () => {
                resolve();
            });
        });
    }

    // writes the buffer's content to the socket
    // a Builder should be used to construct the buffer's content
    async send(buffer) {
        await this.write(buffer);
    }

    // writes a single row to the socket
    // row is passed as a string without EOL char
    async sendRow(row) {
        await this.write(`${row}\n`);
    }

    // writes a list of rows to the socket
    // rows are passed in a string array without EOL char
    async sendRows(rows) {
        const len = rows.length;
        for (let i = 0; i < len; i++) {
            await this.sendRow(rows[i]);
        }
        return len;
    }
}

exports.Sender = Sender;
