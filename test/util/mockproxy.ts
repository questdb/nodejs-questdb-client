import net, { Socket } from "node:net";
import tls from "node:tls";
import { write, listen, shutdown } from "./proxyfunctions";

const CHALLENGE_LENGTH = 512;

type MockConfig = {
  auth?: boolean;
  assertions?: boolean;
};

class MockProxy {
  mockConfig: MockConfig;
  dataSentToRemote: string[];
  hasSentChallenge: boolean;
  client: Socket;
  server: net.Server | tls.Server;

  constructor(mockConfig: MockConfig) {
    if (!mockConfig) {
      throw new Error("Missing mock config");
    }
    this.mockConfig = mockConfig;
    this.dataSentToRemote = [];
  }

  async start(listenPort: number, tlsOptions?: tls.TlsOptions) {
    await listen(
      this,
      listenPort,
      async (data) => {
        console.info(`received from client: ${data}`);
        if (this.mockConfig.assertions) {
          this.dataSentToRemote.push(data.toString());
        }
        if (this.mockConfig.auth && !this.hasSentChallenge) {
          await write(this.client, mockChallenge());
          this.hasSentChallenge = true;
        }
      },
      tlsOptions,
    );
  }

  async stop() {
    await shutdown(this);
  }

  getDataSentToRemote() {
    if (!this.mockConfig.assertions) {
      throw new Error("Should be called only when assertions switched on");
    }
    return this.dataSentToRemote;
  }
}

function mockChallenge() {
  let challenge = "";
  for (let i = 0; i < CHALLENGE_LENGTH - 1; i++) {
    challenge += "a";
  }
  return challenge + "\n";
}

export { MockProxy };
