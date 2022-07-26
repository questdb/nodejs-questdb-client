const { createServer } = require("net");
//const crypto = require('crypto');

const LOCALHOST = '127.0.0.1';

async function write(socket, data) {
    return new Promise(resolve => {
        socket.write(data, 'utf8', () => {
            resolve();
        });
    });
}

async function listen(proxy, listenPort, dataHandler) {
    return new Promise(resolve => {
        proxy.server = createServer(client => {
            console.log('client connected');
            if (proxy.client) {
                console.error("There is already a client connected");
                process.exit(1);
            }
            proxy.client = client;

            client.on("data", dataHandler);

            client.on("close", async () => {
                console.log("client connection closed");
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

async function shutdown(proxy, onServerClose = async () => {}) {
    console.log("closing proxy")
    return new Promise(resolve => {
        proxy.server.close(async () => {
            await onServerClose();
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

exports.write = write;
exports.listen = listen;
exports.shutdown = shutdown;
exports.connect = connect;
exports.close = close;
