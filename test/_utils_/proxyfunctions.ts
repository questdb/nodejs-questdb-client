import net from "node:net";
import tls from "node:tls";

const LOCALHOST = "localhost";

async function write(socket, data) {
  return new Promise<void>((resolve, reject) => {
    socket.write(data, "utf8", (err) => {
      if (err) {
        reject(err)
      } else {
        resolve();
      }
    });
  });
}

async function listen(proxy, listenPort, dataHandler, tlsOptions) {
  return new Promise<void>((resolve) => {
    const clientConnHandler = (client) => {
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

async function shutdown(proxy, onServerClose = async () => { }) {
  console.info("closing proxy");
  return new Promise<void>((resolve) => {
    proxy.server.close(async () => {
      await onServerClose();
      resolve();
    });
  });
}

async function connect(proxy, remotePort, remoteHost) {
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
