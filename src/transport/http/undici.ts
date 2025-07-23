// @ts-check
import { Buffer } from "node:buffer";
import { Agent, RetryAgent } from "undici";
import Dispatcher from "undici/types/dispatcher";

import { SenderOptions, HTTP, HTTPS } from "../../options";
import {
  HttpTransportBase,
  RETRIABLE_STATUS_CODES,
  HTTP_NO_CONTENT,
} from "./base";

const DEFAULT_HTTP_OPTIONS: Agent.Options = {
  connect: {
    keepAlive: true,
  },
  pipelining: 1,
  keepAliveTimeout: 60000, // 1 minute
};

/** @classdesc
 * The QuestDB client's API provides methods to connect to the database, ingest data, and close the connection.
 * The supported protocols are HTTP and TCP. HTTP is preferred as it provides feedback in the HTTP response. <br>
 * of <i>undici.Agent</i>. The Sender's own agent uses persistent connections with 1 minute idle timeout, pipelines requests default to 1.
 * </p>
 */
class UndiciTransport extends HttpTransportBase {
  private static DEFAULT_HTTP_AGENT: Agent;

  private readonly agent: Dispatcher;
  private readonly dispatcher: RetryAgent;

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
        this.agent =
          options.agent instanceof Agent
            ? options.agent
            : UndiciTransport.getDefaultHttpAgent();
        break;
      case HTTPS:
        if (options.agent instanceof Agent) {
          this.agent = options.agent;
        } else {
          // Create a new agent with instance-specific TLS options
          this.agent = new Agent({
            ...DEFAULT_HTTP_OPTIONS,
            connect: {
              ...DEFAULT_HTTP_OPTIONS.connect,
              requestCert: this.tlsVerify,
              rejectUnauthorized: this.tlsVerify,
              ca: this.tlsCA,
            },
          });
        }
        break;
      default:
        throw new Error(
          "The 'protocol' has to be 'http' or 'https' for the Undici HTTP transport",
        );
    }

    this.dispatcher = new RetryAgent(this.agent, {
      maxRetries: Infinity,
      minTimeout: 10,
      maxTimeout: 1000,
      timeoutFactor: 2,
      retryAfter: true,
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
      statusCodes: RETRIABLE_STATUS_CODES,
      errorCodes: [
        "ECONNRESET",
        "EAI_AGAIN",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "EPIPE",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
      ],
    });
  }

  async send(data: Buffer): Promise<boolean> {
    const headers: Record<string, string> = {};
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    } else if (this.username && this.password) {
      headers["Authorization"] =
        `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`;
    }

    const controller = new AbortController();
    const { signal } = controller;
    setTimeout(() => controller.abort(), this.retryTimeout);

    let responseData: Dispatcher.ResponseData;
    try {
      const timeoutMillis =
        (data.length / this.requestMinThroughput) * 1000 + this.requestTimeout;
      responseData = await this.dispatcher.request({
        origin: `${this.secure ? "https" : "http"}://${this.host}:${this.port}`,
        path: "/write?precision=n",
        method: "POST",
        headers,
        body: data,
        headersTimeout: this.requestTimeout,
        bodyTimeout: timeoutMillis,
        signal,
      });
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(
          "HTTP request timeout, no response from server in time",
        );
      } else {
        throw err;
      }
    }

    const { statusCode } = responseData;
    const body = await responseData.body.arrayBuffer();
    if (statusCode === HTTP_NO_CONTENT) {
      if (body.byteLength > 0) {
        this.log(
          "warn",
          `Unexpected message from server: ${Buffer.from(body).toString()}`,
        );
      }
      return true;
    } else {
      throw new Error(
        `HTTP request failed, statusCode=${statusCode}, error=${Buffer.from(body).toString()}`,
      );
    }
  }

  /**
   * @ignore
   * @return {Agent} Returns the default http agent.
   */
  private static getDefaultHttpAgent(): Agent {
    if (!UndiciTransport.DEFAULT_HTTP_AGENT) {
      UndiciTransport.DEFAULT_HTTP_AGENT = new Agent(DEFAULT_HTTP_OPTIONS);
    }
    return UndiciTransport.DEFAULT_HTTP_AGENT;
  }
}

export { UndiciTransport };
