import net, { Socket } from "node:net";
import tls from "node:tls";
import { write, listen, shutdown, connect, close } from "./proxyfunctions";

// handles only a single client
// client -> server (Proxy) -> remote (QuestDB)
// client <- server (Proxy) <- remote (QuestDB)
class Proxy {
  client: Socket;
  remote: Socket;
  server: net.Server | tls.Server;

  constructor() {
    this.remote = new Socket();

    this.remote.on("data", async (data: string) => {
      console.info(`received from remote, forwarding to client: ${data}`);
      await write(this.client, data);
    });

    this.remote.on("close", () => {
      console.info("remote connection closed");
    });

    this.remote.on("error", (err: Error) => {
      console.error(`remote connection: ${err}`);
    });
  }

  async start(
    listenPort: number,
    remotePort: number,
    remoteHost: string,
    tlsOptions: Record<string, unknown>,
  ) {
    return new Promise<void>((resolve) => {
      this.remote.on("ready", async () => {
        console.info("remote connection ready");
        await listen(
          this,
          listenPort,
          async (data: string) => {
            console.info(`received from client, forwarding to remote: ${data}`);
            await write(this.remote, data);
          },
          tlsOptions,
        );
        resolve();
      });

      connect(this, remotePort, remoteHost);
    });
  }

  async stop() {
    await shutdown(this, async () => await close());
  }
}

export { Proxy };
