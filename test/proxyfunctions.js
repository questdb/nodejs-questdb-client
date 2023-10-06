'use strict';

const net = require('net');
const tls = require('tls');

const LOCALHOST = '127.0.0.1';

async function write(socket, data) {
    return new Promise((resolve, reject) => {
        socket.write(data, 'utf8', err => {
            err ? reject(err) : resolve();
        });
    });
}

async function listen(proxy, listenPort, dataHandler, tlsOptions) {
    return new Promise(resolve => {
        const clientConnHandler = client => {
            console.info('client connected');
            if (proxy.client) {
                console.error('There is already a client connected');
                process.exit(1);
            }
            proxy.client = client;

            client.on('data', dataHandler);
        }

        proxy.server = tlsOptions
            ? tls.createServer(tlsOptions, clientConnHandler)
            : net.createServer(clientConnHandler);

        proxy.server.on('error', err => {
            console.error(`server error: ${err}`);
        });

        proxy.server.listen(listenPort, LOCALHOST, () => {
            console.info(`listening for clients on ${listenPort}`);
            resolve();
        });
    });
}

async function shutdown(proxy, onServerClose = async () => {}) {
    console.info('closing proxy')
    return new Promise(resolve => {
        proxy.server.close(async () => {
            await onServerClose();
            resolve();
        });
    });
}

async function connect(proxy, remotePort, remoteHost) {
    console.info(`opening remote connection to ${remoteHost}:${remotePort}`)
    return new Promise(resolve => {
        proxy.remote.connect(remotePort, remoteHost, () => resolve());
    });
}

async function close(proxy) {
    console.info('closing remote connection')
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
