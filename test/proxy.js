const { Socket } = require("net");
const { write, listen, shutdown, connect, close } = require("./proxyfunctions");
//const crypto = require('crypto');

// handles only a single client
// client -> server (Proxy) -> remote (QuestDB)
// client <- server (Proxy) <- remote (QuestDB)
class Proxy {
    constructor() {
        this.remote = new Socket();

        this.remote.on("data", async data => {
            console.log(`received from remote, forwarding to client: ${data}`);
            await write(this.client, data);
        });

        this.remote.on("close", async () => {
            console.log("remote connection closed");
        });

        this.remote.on("error", async err => {
            console.error(`remote connection: ${err}`);
            process.exit(1);
        });
    }

    async start(listenPort, remotePort, remoteHost) {
        return new Promise(resolve => {
            this.remote.on("ready", async () => {
                console.log("remote connection ready");
                await listen(this, listenPort, async data => {
                    console.log(`received from client, forwarding to remote: ${data}`);
                    await write(this.remote, data);
                });
                resolve();
            });

            connect(this, remotePort, remoteHost);
        });
    }

    async stop() {
        await shutdown(this, async () => await close(this));
    }
}

exports.Proxy = Proxy;
