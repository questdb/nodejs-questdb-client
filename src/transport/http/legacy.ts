// @ts-check
import http from "http";
import https from "https";
import { Buffer } from "node:buffer";

import { SenderOptions, HTTP, HTTPS } from "../../options";
import { HttpTransportBase, RETRIABLE_STATUS_CODES, HTTP_NO_CONTENT } from "./base";

// default options for HTTP agent
// - persistent connections with 1 minute idle timeout, server side has 5 minutes set by default
// - max open connections is set to 256, same as server side default
const DEFAULT_HTTP_AGENT_CONFIG = {
  maxSockets: 256,
  keepAlive: true,
  timeout: 60000 // 1 min
}

/** @classdesc
 * The QuestDB client's API provides methods to connect to the database, ingest data, and close the connection.
 * The supported protocols are HTTP and TCP. HTTP is preferred as it provides feedback in the HTTP response. <br>
 * Based on benchmarks HTTP also provides higher throughput, if configured to ingest data in bigger batches.
 */
class HttpTransport extends HttpTransportBase {
  private static DEFAULT_HTTP_AGENT: http.Agent;
  private static DEFAULT_HTTPS_AGENT: https.Agent;

  private readonly agent: http.Agent | https.Agent;

  /**
   * Creates an instance of Sender.
   *
   * @param {SenderOptions} options - Sender configuration object. <br>
   * See SenderOptions documentation for detailed description of configuration options. <br>
   */
  constructor(options: SenderOptions) {
    super(options);

    switch (options.protocol) {
      case HTTP:
        this.agent = options.agent instanceof http.Agent ? options.agent : HttpTransport.getDefaultHttpAgent();
        break;
      case HTTPS:
        this.agent = options.agent instanceof https.Agent ? options.agent : HttpTransport.getDefaultHttpsAgent();
        break;
      default:
        throw new Error("The 'protocol' has to be 'http' or 'https' for the HTTP transport");
    }
  }

  send(data: Buffer, retryBegin = -1, retryInterval = -1): Promise<boolean> {
    const request = this.secure ? https.request : http.request;

    const timeoutMillis = (data.length / this.requestMinThroughput) * 1000 + this.requestTimeout;
    const options = this.createRequestOptions(timeoutMillis);

    return new Promise((resolve, reject) => {
      let statusCode = -1;
      const req = request(options, response => {
        statusCode = response.statusCode;

        const body = [];
        response
            .on("data", chunk => {
              body.push(chunk);
            })
            .on("error", err => {
              this.log("error", `resp err=${err}`);
            });

        if (statusCode === HTTP_NO_CONTENT) {
          response.on("end", () => {
            if (body.length > 0) {
              this.log("warn", `Unexpected message from server: ${Buffer.concat(body)}`);
            }
            resolve(true);
          });
        } else {
          req.destroy(new Error(`HTTP request failed, statusCode=${statusCode}, error=${Buffer.concat(body)}`));
        }
      });

      if (this.token) {
        req.setHeader("Authorization", `Bearer ${this.token}`);
      } else if (this.username && this.password) {
        req.setHeader("Authorization", `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`);
      }

      req.on("timeout", () => {
        // set a retryable error code
        statusCode = 524;
        req.destroy(new Error("HTTP request timeout, no response from server in time"));
      });
      req.on("error", err => {
        // if the error is thrown while the request is sent, statusCode is -1 => no retry
        // request timeout comes through with statusCode 524 => retry
        // if the error is thrown while the response is processed, the statusCode is taken from the response => retry depends on statusCode
        if (isRetryable(statusCode) && this.retryTimeout > 0) {
          if (retryBegin < 0) {
            retryBegin = Date.now();
            retryInterval = 10;
          } else {
            const elapsed = Date.now() - retryBegin;
            if (elapsed > this.retryTimeout) {
              reject(err);
              return;
            }
          }
          const jitter = Math.floor(Math.random() * 10) - 5;
          setTimeout(() => {
            retryInterval = Math.min(retryInterval * 2, 1000);
            this.send(data, retryBegin, retryInterval)
                .then(() => resolve(true))
                .catch(e => reject(e));
          }, retryInterval + jitter);
        } else {
          reject(err);
        }
      });
      req.write(data, err => err ? reject(err) : () => {});
      req.end();
    });
  }

  private createRequestOptions(timeoutMillis: number): http.RequestOptions | https.RequestOptions {
    return {
      //protocol: this.secure ? "https:" : "http:",
      hostname: this.host,
      port: this.port,
      agent: this.agent,
      path: "/write?precision=n",
      method: "POST",
      timeout: timeoutMillis,
      rejectUnauthorized: this.secure && this.tlsVerify,
      ca: this.secure ? this.tlsCA : undefined,
    };
  }

  /**
   * @ignore
   * @return {http.Agent} Returns the default http agent.
   */
  private static getDefaultHttpAgent(): http.Agent {
    if (!HttpTransport.DEFAULT_HTTP_AGENT) {
      HttpTransport.DEFAULT_HTTP_AGENT = new http.Agent(DEFAULT_HTTP_AGENT_CONFIG);
    }
    return HttpTransport.DEFAULT_HTTP_AGENT;
  }

  /**
   * @ignore
   * @return {https.Agent} Returns the default https agent.
   */
  private static getDefaultHttpsAgent(): https.Agent {
    if (!HttpTransport.DEFAULT_HTTPS_AGENT) {
      HttpTransport.DEFAULT_HTTPS_AGENT = new https.Agent(DEFAULT_HTTP_AGENT_CONFIG);
    }
    return HttpTransport.DEFAULT_HTTPS_AGENT;
  }
}

function isRetryable(statusCode: number) {
  return RETRIABLE_STATUS_CODES.includes(statusCode);
}

export { HttpTransport, HttpTransportBase };
