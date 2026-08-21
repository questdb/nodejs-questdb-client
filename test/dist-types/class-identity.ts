// Pins that the classes a factory returns can be named in a type position by a
// consumer of the published package.
//
// src/_qwp/** is emitted as shared chunks rather than inlined per entry, so
// each class is declared exactly once across the four bundles. Were an entry to
// start inlining them again, its declaration would be a second, nominally
// distinct one -- every class here carries private members -- and these
// annotations would stop compiling.
import {
  connectQwpNodeClient,
  createQwpNodeSender,
} from "@questdb/nodejs-client/qwp/node";
import type {
  QwpClient,
  QwpSender,
  QwpTableWriter,
} from "@questdb/nodejs-client/qwp";
import {
  designatedTimestamp,
  QwpUpgradeError,
  symbol,
} from "@questdb/nodejs-client/qwp";

declare const senderOptions: Parameters<typeof createQwpNodeSender>[0];
declare const clientOptions: Parameters<typeof connectQwpNodeClient>[0];

// Inference works today and must keep working: this is the documented shape.
const inferred = createQwpNodeSender(senderOptions);
void inferred.flush();

const annotated: QwpSender = createQwpNodeSender(senderOptions);
void annotated;

async function annotatedClient(): Promise<void> {
  const client: QwpClient = await connectQwpNodeClient(clientOptions);
  void client;
}
void annotatedClient;

const schema = { ticker: symbol(), ts: designatedTimestamp("ns") } as const;

// QwpTableWriter is nominal via its private appendRow, so this only compiles
// while the writer a sender returns comes from the same declaration.
const writer: QwpTableWriter<typeof schema> = inferred.writer("trades", schema);
void writer;

// Inference remains the working shape for writers too.
const inferredWriter = inferred.writer("trades", schema);
void inferredWriter.row({ ticker: "ETH-USD", ts: 1n });

// QwpUpgradeError has no private members, so it is structural and annotates
// cleanly today. It must stay that way once the bundles are collapsed.
const upgradeFailure: QwpUpgradeError = new QwpUpgradeError("nope", {
  kind: "opaque",
});
void upgradeFailure;
