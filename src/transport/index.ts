// @ts-check
import { Buffer } from "node:buffer";

import { SenderOptions, HTTP, HTTPS, TCP, TCPS } from "../options";
import { UndiciTransport } from "./http/undici";
import { TcpTransport } from "./tcp";
import { HttpTransport } from "./http/legacy";

interface SenderTransport {
  connect(): Promise<boolean>;
  send(data: Buffer): Promise<boolean>;
  close(): Promise<void>;
  getDefaultAutoFlushRows(): number;
}

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
      return options.legacy_http
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
