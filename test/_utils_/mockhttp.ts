import http from "node:http";
import https from "node:https";

class MockHttp {
  server: http.Server | https.Server;
  mockConfig: {
    responseDelays?: number[],
    responseCodes?: number[],
    username?: string,
    password?: string,
    token?: string,
  };
  numOfRequests: number;

  constructor() {
    this.reset();
  }

  reset(mockConfig = {}) {
    this.mockConfig = mockConfig;
    this.numOfRequests = 0;
  }

  async start(listenPort: number, secure: boolean = false, options?: Record<string, unknown>) {
    const serverCreator = secure ? https.createServer : http.createServer;
    // @ts-expect-error - Testing different options, so typing is not important
    this.server = serverCreator(options, (req, res) => {
      const authFailed = checkAuthHeader(this.mockConfig, req);

      const body: Uint8Array[] = [];
      req.on("data", (chunk: Uint8Array) => {
        body.push(chunk);
      });

      req.on("end", async () => {
        console.info(`Received data: ${Buffer.concat(body)}`);
        this.numOfRequests++;

        const delay =
          this.mockConfig.responseDelays &&
            this.mockConfig.responseDelays.length > 0
            ? this.mockConfig.responseDelays.pop()
            : undefined;
        if (delay) {
          await sleep(delay);
        }

        const responseCode = authFailed
          ? 401
          : this.mockConfig.responseCodes &&
            this.mockConfig.responseCodes.length > 0
            ? this.mockConfig.responseCodes.pop()
            : 204;
        res.writeHead(responseCode);
        res.end();
      });
    });

    this.server.listen(listenPort, () => {
      console.info(`Server is running on port ${listenPort}`);
    });
  }

  async stop() {
    if (this.server) {
      this.server.close();
    }
  }
}

function checkAuthHeader(mockConfig, req) {
  let authFailed = false;
  const header = (req.headers.authorization || "").split(/\s+/);
  switch (header[0]) {
    case "Basic": {
      const auth = Buffer.from(header[1], "base64").toString().split(/:/);
      if (mockConfig.username !== auth[0] || mockConfig.password !== auth[1]) {
        authFailed = true;
      }
      break;
    }
    case "Bearer":
      if (mockConfig.token !== header[1]) {
        authFailed = true;
      }
      break;
    default:
      if (mockConfig.username || mockConfig.password || mockConfig.token) {
        authFailed = true;
      }
  }
  return authFailed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { MockHttp };
