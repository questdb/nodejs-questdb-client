import { write, listen, shutdown } from "./proxyfunctions";

const CHALLENGE_LENGTH = 512;

class MockProxy {
  mockConfig: {
    auth?: boolean;
    assertions?: boolean;
  };
  dataSentToRemote: string[];
  hasSentChallenge: boolean;
  client: unknown;

  constructor(mockConfig) {
    if (!mockConfig) {
      throw new Error("Missing mock config");
    }
    this.mockConfig = mockConfig;
    this.dataSentToRemote = [];
  }

  async start(listenPort: number, tlsOptions?: Record<string, unknown>) {
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
