// Typechecked against the BUILT bundles, not src/. In src/ all four entry
// points share one module instance, so a type identity that only holds within
// a bundle still looks correct there; only a consumer resolving through
// package.json `exports` sees the emitted .d.ts files separately.
//
// Every check below is a `@ts-expect-error`, so this file fails loudly in both
// directions: if a check stops firing, tsc reports the directive as unused
// (TS2578), which is exactly what a collapse of the row input type looks like.
import { Sender } from "@questdb/nodejs-client";
import {
  designatedTimestamp,
  double,
  long,
  symbol,
  type QwpWriterRow,
} from "@questdb/nodejs-client/qwp";
import { createQwpNodeSender } from "@questdb/nodejs-client/qwp/node";
import { createQwpBrowserSender } from "@questdb/nodejs-client/qwp/browser";

const schema = {
  ticker: symbol(),
  price: double(),
  quantity: long(),
  timestamp: designatedTimestamp("ns"),
} as const;

declare const rootSender: Sender;
declare const nodeSender: ReturnType<typeof createQwpNodeSender>;
declare const browserSender: ReturnType<typeof createQwpBrowserSender>;

const fromRoot = rootSender.writer("trades", schema);
const fromNode = nodeSender.writer("trades", schema);
const fromBrowser = browserSender.writer("trades", schema);

for (const trades of [fromRoot, fromNode, fromBrowser]) {
  // A correct row must still compile.
  void trades.row({
    ticker: "ETH-USD",
    price: 2615.54,
    quantity: 42n,
    timestamp: 1_723_000_000_000_000_000n,
  });

  // @ts-expect-error symbol() accepts only strings.
  void trades.row({ ticker: 1, price: 1, quantity: 1n, timestamp: 1n });
  // @ts-expect-error double() does not accept bigint.
  void trades.row({ ticker: "a", price: 1n, quantity: 1n, timestamp: 1n });
  // @ts-expect-error long() requires bigint, not number.
  void trades.row({ ticker: "a", price: 1, quantity: 1, timestamp: 1n });
  // @ts-expect-error a nanosecond designated timestamp requires bigint.
  void trades.row({ ticker: "a", price: 1, quantity: 1n, timestamp: 1 });
  // @ts-expect-error the designated timestamp is required.
  void trades.row({ ticker: "a", price: 1, quantity: 1n });
  // @ts-expect-error unknown columns are rejected.
  void trades.row({ ticker: "a", price: 1, quantity: 1n, timestamp: 1n, x: 1 });
}

// The row type must also be nameable and enforced on its own.
const row: QwpWriterRow<typeof schema> = {
  ticker: "ETH-USD",
  price: 1,
  quantity: 1n,
  timestamp: 1n,
};
void row;
