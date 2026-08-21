// Pins whether the classes a factory returns can be named in a type position
// by a consumer of the published package.
//
// Each entry point emits a self-contained bundle, so a class implemented in
// src/qwp/** is declared once per bundle. A class carrying private members is
// nominal, so those declarations are mutually incompatible -- and qwp/node.d.ts
// re-exports index's QwpSender wholesale (`export * from './index'`) while
// createQwpNodeSender returns its own local, unexported one. The importable
// type and the returned type are therefore different declarations no matter
// which subpath the consumer imports from.
//
// The @ts-expect-error directives below record that defect. When the build
// emits src/qwp/** as one shared chunk, each class collapses to a single
// declaration, these annotations start compiling, and tsc reports the
// directives as unused (TS2578) -- which is the signal to delete them.
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

// @ts-expect-error known gap: node's QwpSender is a separate declaration.
const annotated: QwpSender = createQwpNodeSender(senderOptions);
void annotated;

async function annotatedClient(): Promise<void> {
  // @ts-expect-error known gap: node's QwpClient is a separate declaration.
  const client: QwpClient = await connectQwpNodeClient(clientOptions);
  void client;
}
void annotatedClient;

const schema = { ticker: symbol(), ts: designatedTimestamp("ns") } as const;

// @ts-expect-error known gap: QwpTableWriter is nominal via its private
// appendRow, so the writer a sender returns cannot be annotated either.
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
