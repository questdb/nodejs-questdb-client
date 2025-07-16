import net, { Socket } from "node:net";
import tls, { TLSSocket } from "node:tls";
import { Proxy } from "./proxy";
import {MockProxy} from "./mockproxy";

const LOCALHOST = "localhost";

async function write(socket: Socket, data: string) {
  return new Promise<void>((resolve, reject) => {
    socket.write(data, "utf8", (err: Error) => err ? reject(err): resolve());
  });
}

async function listen(proxy: Proxy | MockProxy, listenPort: number, dataHandler: (data: string) => void, tlsOptions: tls.TlsOptions) {
  return new Promise<void>((resolve) => {
    const clientConnHandler = (client: Socket | TLSSocket) => {
      console.info("client connected");
      if (proxy.client) {
        console.error("There is already a client connected");
        process.exit(1);
      }
      proxy.client = client;

      client.on("data", dataHandler);
    };

    proxy.server = tlsOptions
      ? tls.createServer(tlsOptions, clientConnHandler)
      : net.createServer(clientConnHandler);

    proxy.server.on("error", (err) => {
      console.error(`server error: ${err}`);
    });

    proxy.server.listen(listenPort, LOCALHOST, () => {
      console.info(`listening for clients on ${listenPort}`);
      resolve();
    });
  });
}

async function shutdown(proxy: Proxy | MockProxy, onServerClose = async () => {}) {
  console.info("closing proxy");
  return new Promise<void>((resolve) => {
    proxy.server.close(async () => {
      await onServerClose();
      resolve();
    });
  });
}

async function connect(proxy: Proxy, remotePort: number, remoteHost: string) {
  console.info(`opening remote connection to ${remoteHost}:${remotePort}`);
  return new Promise<void>((resolve) => {
    proxy.remote.connect(remotePort, remoteHost, () => resolve());
  });
}

async function close() {
  console.info("closing remote connection");
  return new Promise<void>((resolve) => {
    resolve();
  });
}

export { write, listen, shutdown, connect, close };
