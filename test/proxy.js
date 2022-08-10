const { Socket } = require("net");
const { write, listen, shutdown, connect, close } = require("./proxyfunctions");

// handles only a single client
// client -> server (Proxy) -> remote (QuestDB)
// client <- server (Proxy) <- remote (QuestDB)
class Proxy {
    constructor() {
        this.remote = new Socket();

        this.remote.on("data", async data => {
            console.info(`received from remote, forwarding to client: ${data}`);
            await write(this.client, data);
        });

        this.remote.on("close", () => {
            console.info("remote connection closed");
        });

        this.remote.on("error", err => {
            console.error(`remote connection: ${err}`);
        });
    }

    async start(listenPort, remotePort, remoteHost, tlsOptions = undefined) {
        return new Promise(resolve => {
            this.remote.on("ready", async () => {
                console.info("remote connection ready");
                await listen(this, listenPort, async data => {
                    console.info(`received from client, forwarding to remote: ${data}`);
                    await write(this.remote, data);
                }, tlsOptions);
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
