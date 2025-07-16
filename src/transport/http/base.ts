// @ts-check
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";

import { log, Logger } from "../../logging";
import { SenderOptions, HTTP, HTTPS } from "../../options";
import { SenderTransport } from "../index";
import { isBoolean, isInteger } from "../../utils";

const HTTP_NO_CONTENT = 204; // success

const DEFAULT_HTTP_AUTO_FLUSH_ROWS = 75000;

const DEFAULT_REQUEST_MIN_THROUGHPUT = 102400; // 100 KB/sec
const DEFAULT_REQUEST_TIMEOUT = 10000; // 10 sec
const DEFAULT_RETRY_TIMEOUT = 10000; // 10 sec

/*
We are retrying on the following response codes (copied from the Rust client):
500:  Internal Server Error
503:  Service Unavailable
504:  Gateway Timeout

// Unofficial extensions
507:  Insufficient Storage
509:  Bandwidth Limit Exceeded
523:  Origin is Unreachable
524:  A Timeout Occurred
529:  Site is overloaded
599:  Network Connect Timeout Error
*/
const RETRIABLE_STATUS_CODES = [500, 503, 504, 507, 509, 523, 524, 529, 599];

/** @classdesc
 * The QuestDB client's API provides methods to connect to the database, ingest data, and close the connection.
 * The supported protocols are HTTP and TCP. HTTP is preferred as it provides feedback in the HTTP response. <br>
 */
abstract class HttpTransportBase implements SenderTransport {
  protected readonly secure: boolean;
  protected readonly host: string;
  protected readonly port: number;

  protected readonly username: string;
  protected readonly password: string;
  protected readonly token: string;

  protected readonly tlsVerify: boolean;
  protected readonly tlsCA: Buffer;

  protected readonly requestMinThroughput: number;
  protected readonly requestTimeout: number;
  protected readonly retryTimeout: number;

  protected readonly log: Logger;

  protected constructor(options: SenderOptions) {
    if (!options || !options.protocol) {
      throw new Error("The 'protocol' option is mandatory");
    }
    if (!options.host) {
      throw new Error("The 'host' option is mandatory");
    }
    this.log = typeof options.log === "function" ? options.log : log;

    this.tlsVerify = isBoolean(options.tls_verify) ? options.tls_verify : true;
    this.tlsCA = options.tls_ca ? readFileSync(options.tls_ca) : undefined;

    this.username = options.username;
    this.password = options.password;
    this.token = options.token;
    if (!options.port) {
      options.port = 9000;
    }

    this.host = options.host;
    this.port = options.port;

    this.requestMinThroughput = isInteger(options.request_min_throughput, 0)
        ? options.request_min_throughput
        : DEFAULT_REQUEST_MIN_THROUGHPUT;
    this.requestTimeout = isInteger(options.request_timeout, 1)
        ? options.request_timeout
        : DEFAULT_REQUEST_TIMEOUT;
    this.retryTimeout = isInteger(options.retry_timeout, 0)
        ? options.retry_timeout
        : DEFAULT_RETRY_TIMEOUT;

    switch (options.protocol) {
      case HTTP:
        this.secure = false;
        break;
      case HTTPS:
        this.secure = true;
        break;
      default:
        throw new Error("The 'protocol' has to be 'http' or 'https' for the HTTP transport");
    }
  }

  connect(): Promise<boolean> {
    throw new Error("'connect()' is not required for HTTP transport");
  }

  async close(): Promise<void> {
  }

  getDefaultAutoFlushRows(): number {
    return DEFAULT_HTTP_AUTO_FLUSH_ROWS;
  }

  abstract send(data: Buffer): Promise<boolean>;
}

export { HttpTransportBase, RETRIABLE_STATUS_CODES, HTTP_NO_CONTENT };
