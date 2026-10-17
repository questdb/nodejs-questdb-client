// The full-JWK escape hatch must be available through the published types,
// including ESM, CommonJS, and TypeScript 4.9 declarations.
import { Sender, SenderOptions } from "@questdb/nodejs-client";
import type { ExtraOptions } from "@questdb/nodejs-client";

declare const jwk: Record<string, string>;
const extraOptions: ExtraOptions = { jwk };

void new SenderOptions("tcp::addr=localhost:9009", extraOptions);
void SenderOptions.fromConfig("tcp::addr=localhost:9009", { jwk });
void SenderOptions.fromEnv({ jwk });
void Sender.fromConfig("tcps::addr=localhost:9009", { jwk });
void Sender.fromEnv({ jwk });
