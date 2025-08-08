// @ts-check
import { Buffer } from "node:buffer";

import { SenderOptions, HTTP, HTTPS, TCP, TCPS } from "../options";
import { UndiciTransport } from "./http/undici";
import { TcpTransport } from "./tcp";
import { HttpTransport } from "./http/stdlib";

/**
 * Interface for QuestDB transport implementations. <br>
 * Defines the contract for different transport protocols (HTTP/HTTPS/TCP/TCPS).
 */
interface SenderTransport {
  /**
   * Establishes a connection to the database server. <br>
   * Should not be called on HTTP transports.
   * @returns Promise resolving to true if connection is successful
   */
  connect(): Promise<boolean>;

  /**
   * Sends the data to the database server.
   * @param {Buffer} data - Buffer containing the data to send
   * @returns Promise resolving to true if data was sent successfully
   */
  send(data: Buffer): Promise<boolean>;

  /**
   * Closes the connection to the database server. <br>
   * Should not be called on HTTP transports.
   * @returns Promise that resolves when the connection is closed
   */
  close(): Promise<void>;

  /**
   * Gets the default number of rows that trigger auto-flush for this transport.
   * @returns Default auto-flush row count
   */
  getDefaultAutoFlushRows(): number;
}

/**
 * Factory function to create appropriate transport instance based on configuration.
 * @param {SenderOptions} options - Sender configuration options including protocol and connection details
 * @returns {SenderTransport} Transport instance appropriate for the specified protocol
 * @throws Error if protocol or host options are missing or invalid
 */
function createTransport(options: SenderOptions): SenderTransport {
  if (!options || !options.protocol) {
    throw new Error("The 'protocol' option is mandatory");
  }
  if (!options.host) {
    throw new Error("The 'host' option is mandatory");
  }

  switch (options.protocol) {
    case HTTP:
    case HTTPS:
      return options.stdlib_http
        ? new HttpTransport(options)
        : new UndiciTransport(options);
    case TCP:
    case TCPS:
      return new TcpTransport(options);
    default:
      throw new Error(`Invalid protocol: '${options.protocol}'`);
  }
}

export { SenderTransport, createTransport };
