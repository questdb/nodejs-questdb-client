const { Socket, createServer } = require("net");
//const crypto = require('crypto');

const LOCALHOST = '127.0.0.1';

// handles only a single client
// client -> server (Proxy) -> remote (QuestDB)
// client <- server (Proxy) <- remote (QuestDB)
class Proxy {
    constructor(mockRemoteConnection = false) {
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
                await listen(this, listenPort);
                resolve();
            });

            connect(this, remotePort, remoteHost);
        });
    }

    async shutdown() {
        await stop(this);
    }
}

async function write(socket, data) {
    return new Promise(resolve => {
        socket.write(data, 'utf8', () => {
            resolve();
        });
    });
}

async function listen(proxy, listenPort) {
    return new Promise(resolve => {
        proxy.server = createServer(client => {
            console.log('client connected');
            if (proxy.client) {
                console.error("There is already a client connected");
                process.exit(1);
            }
            proxy.client = client;

            client.on("data", async data => {
                console.log(`received from client, forwarding to remote: ${data}`);
                await write(proxy.remote, data);
            });

            client.on("close", async () => {
                console.log("client connection closed");
            });

            client.on("error", async err => {
                console.error(`client connection: ${err}`);
                process.exit(1);
            });
        });

        proxy.server.on('error', err => {
            console.error(`server error: ${err}`);
            process.exit(1);
        });

        proxy.server.listen(listenPort, LOCALHOST, () => {
            console.log(`listening for clients on ${listenPort}`);
            resolve();
        });
    });
}

async function stop(proxy) {
    console.log("closing proxy")
    return new Promise(resolve => {
        proxy.server.close(async () => {
            await close(proxy);
            resolve();
        });
    });
}

async function connect(proxy, remotePort, remoteHost) {
    console.log(`opening remote connection to ${remoteHost}:${remotePort}`)
    return new Promise(resolve => {
        proxy.remote.connect(remotePort, remoteHost, () => resolve());
    });
}

async function close(proxy) {
    console.log("closing remote connection")
    return new Promise(resolve => {
        proxy.remote.destroy();
        resolve();
    });
}

exports.Proxy = Proxy;
