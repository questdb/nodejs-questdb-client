// @ts-check
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

import { log, Logger } from "../logging";
import { SenderOptions, TCP, TCPS } from "../options";
import { SenderTransport } from "./index";
import { isBoolean } from "../utils";

const DEFAULT_TCP_AUTO_FLUSH_ROWS = 600;

// Arbitrary public key, used to construct valid JWK tokens.
// These are not used for actual authentication, only required for crypto API compatibility.
const PUBLIC_KEY = {
  x: "aultdA0PjhD_cWViqKKyL5chm6H1n-BiZBo_48T-uqc",
  y: "__ptaol41JWSpTTL525yVEfzmY8A6Vi_QrW1FjKcHMg",
};

/**
 * TCP transport implementation. <br>
 * Supports both plain TCP or secure TLS-encrypted connections with configurable JWK token authentication.
 */
class TcpTransport implements SenderTransport {
  private readonly secure: boolean;
  private readonly host: string;
  private readonly port: number;

  private socket: net.Socket | tls.TLSSocket;

  private readonly tlsVerify: boolean;
  private readonly tlsCA: Buffer;

  private readonly log: Logger;
  private readonly jwk: Record<string, string>;

  /**
   * Creates a new TcpTransport instance.
   *
   * @param options - Sender configuration object containing connection and authentication details
   * @throws Error if required options are missing or protocol is not 'tcp' or 'tcps'
   */
  constructor(options: SenderOptions) {
    if (!options || !options.protocol) {
      throw new Error("The 'protocol' option is mandatory");
    }
    if (!options.host) {
      throw new Error("The 'host' option is mandatory");
    }
    this.log = typeof options.log === "function" ? options.log : log;

    this.tlsVerify = isBoolean(options.tls_verify) ? options.tls_verify : true;
    this.tlsCA = options.tls_ca ? readFileSync(options.tls_ca) : undefined;

    this.host = options.host;
    this.port = options.port;

    switch (options.protocol) {
      case TCP:
        this.secure = false;
        break;
      case TCPS:
        this.secure = true;
        break;
      default:
        throw new Error(
          "The 'protocol' has to be 'tcp' or 'tcps' for the TCP transport",
        );
    }

    if (!options.auth && !options.jwk) {
      constructAuth(options);
    }
    this.jwk = constructJwk(options);
    if (!options.port) {
      options.port = 9009;
    }
  }

  /**
   * Creates a TCP connection to the database.
   * @returns Promise resolving to true if the connection is established successfully
   * @throws Error if connection fails or authentication is rejected
   */
  connect(): Promise<boolean> {
    const connOptions: net.NetConnectOpts | tls.ConnectionOptions = {
      host: this.host,
      port: this.port,
      ca: this.tlsCA,
    };

    return new Promise((resolve, reject) => {
      if (this.socket) {
        throw new Error("Sender connected already");
      }

      let authenticated: boolean = false;
      let data: Buffer;

      this.socket = !this.secure
        ? net.connect(connOptions as net.NetConnectOpts)
        : tls.connect(connOptions as tls.ConnectionOptions, () => {
            if (authenticated) {
              resolve(true);
            }
          });
      this.socket.setKeepAlive(true);

      this.socket
        .on("data", async (raw) => {
          data = !data ? raw : Buffer.concat([data, raw]);
          if (!authenticated) {
            authenticated = await this.authenticate(data);
            if (authenticated) {
              resolve(true);
            }
          } else {
            this.log("warn", `Received unexpected data: ${data}`);
          }
        })
        .on("ready", async () => {
          this.log(
            "info",
            `Successfully connected to ${connOptions.host}:${connOptions.port}`,
          );
          if (this.jwk) {
            this.log(
              "info",
              `Authenticating with ${connOptions.host}:${connOptions.port}`,
            );
            this.socket.write(`${this.jwk.kid}\n`, (err) =>
              err ? reject(err) : () => {},
            );
          } else {
            authenticated = true;
            if (!this.secure || !this.tlsVerify) {
              resolve(true);
            }
          }
        })
        .on("error", (err: Error & { code: string }) => {
          this.log("error", err);
          if (
            this.tlsVerify ||
            !err.code ||
            err.code !== "SELF_SIGNED_CERT_IN_CHAIN"
          ) {
            reject(err);
          }
        });
    });
  }

  /**
   * Sends data over the established TCP connection.
   * @param data - Buffer containing the data to send
   * @returns Promise resolving to true if data was sent successfully
   * @throws Error if the data could not be written to the socket
   */
  send(data: Buffer): Promise<boolean> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("TCP transport is not connected");
    }
    return new Promise((resolve, reject) => {
      this.socket.write(data, (err: Error) => {
        if (err) {
          reject(err);
        } else {
          resolve(true);
        }
      });
    });
  }

  /**
   * Closes the TCP connection to the database. <br>
   * Data sitting in the Sender's buffer will be lost unless flush() is called before close().
   */
  async close(): Promise<void> {
    if (this.socket) {
      const address = this.socket.remoteAddress;
      const port = this.socket.remotePort;
      this.socket.destroy();
      this.socket = null;
      this.log("info", `Connection to ${address}:${port} is closed`);
    }
  }

  getDefaultAutoFlushRows(): number {
    return DEFAULT_TCP_AUTO_FLUSH_ROWS;
  }

  private async authenticate(challenge: Buffer): Promise<boolean> {
    // Check for trailing \n which ends the challenge
    if (challenge.subarray(-1).readInt8() === 10) {
      const keyObject = crypto.createPrivateKey({
        key: this.jwk,
        format: "jwk",
      });
      const signature = crypto.sign(
        "RSA-SHA256",
        challenge.subarray(0, challenge.length - 1),
        keyObject,
      );

      return new Promise((resolve, reject) => {
        this.socket.write(
          `${Buffer.from(signature).toString("base64")}\n`,
          (err: Error) => {
            if (err) {
              reject(err);
            } else {
              resolve(true);
            }
          },
        );
      });
    }
    return false;
  }
}

function constructAuth(options: SenderOptions) {
  if (!options.username && !options.token && !options.password) {
    // no intention to authenticate
    return;
  }
  if (!options.username || !options.token) {
    throw new Error(
      "TCP transport requires a username and a private key for authentication, " +
        "please, specify the 'username' and 'token' config options",
    );
  }

  options.auth = {
    keyId: options.username,
    token: options.token,
  };
}

function constructJwk(options: SenderOptions) {
  if (options.auth) {
    if (!options.auth.keyId) {
      throw new Error(
        "Missing username, please, specify the 'keyId' property of the 'auth' config option. " +
          "For example: new Sender({protocol: 'tcp', host: 'host', auth: {keyId: 'username', token: 'private key'}})",
      );
    }
    if (typeof options.auth.keyId !== "string") {
      throw new Error(
        "Please, specify the 'keyId' property of the 'auth' config option as a string. " +
          "For example: new Sender({protocol: 'tcp', host: 'host', auth: {keyId: 'username', token: 'private key'}})",
      );
    }
    if (!options.auth.token) {
      throw new Error(
        "Missing private key, please, specify the 'token' property of the 'auth' config option. " +
          "For example: new Sender({protocol: 'tcp', host: 'host', auth: {keyId: 'username', token: 'private key'}})",
      );
    }
    if (typeof options.auth.token !== "string") {
      throw new Error(
        "Please, specify the 'token' property of the 'auth' config option as a string. " +
          "For example: new Sender({protocol: 'tcp', host: 'host', auth: {keyId: 'username', token: 'private key'}})",
      );
    }

    return {
      kid: options.auth.keyId,
      d: options.auth.token,
      ...PUBLIC_KEY,
      kty: "EC",
      crv: "P-256",
    };
  } else {
    return options.jwk;
  }
}

export { TcpTransport };
