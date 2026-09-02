// Typechecked against the BUILT packages, not client-core/src. The source tree
// shares one module instance, so only a consumer resolving each public
// package through `exports` sees the emitted declarations as they are shipped.
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
} from "@questdb/nodejs-client";
import { createQwpNodeSender } from "@questdb/nodejs-client";
import {
  createQwpBrowserSender,
  designatedTimestamp as browserDesignatedTimestamp,
  double as browserDouble,
  long as browserLong,
  symbol as browserSymbol,
  type QwpWriterRow as BrowserQwpWriterRow,
} from "@questdb/browser-client";

const schema = {
  ticker: symbol(),
  price: double(),
  quantity: long(),
  timestamp: designatedTimestamp("ns"),
} as const;

const browserSchema = {
  ticker: browserSymbol(),
  price: browserDouble(),
  quantity: browserLong(),
  timestamp: browserDesignatedTimestamp("ns"),
} as const;

declare const rootSender: Sender;
declare const nodeSender: ReturnType<typeof createQwpNodeSender>;
declare const browserSender: ReturnType<typeof createQwpBrowserSender>;

const fromRoot = rootSender.writer("trades", schema);
const fromNode = nodeSender.writer("trades", schema);
const fromBrowser = browserSender.writer("trades", browserSchema);

for (const trades of [fromRoot, fromNode]) {
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

// The independently emitted browser declarations preserve the same schema
// inference at the browser package root.
void fromBrowser.row({
  ticker: "ETH-USD",
  price: 2615.54,
  quantity: 42n,
  timestamp: 1_723_000_000_000_000_000n,
});
// @ts-expect-error symbol() accepts only strings.
void fromBrowser.row({ ticker: 1, price: 1, quantity: 1n, timestamp: 1n });
// @ts-expect-error double() does not accept bigint.
void fromBrowser.row({ ticker: "a", price: 1n, quantity: 1n, timestamp: 1n });
// @ts-expect-error long() requires bigint, not number.
void fromBrowser.row({ ticker: "a", price: 1, quantity: 1, timestamp: 1n });
// @ts-expect-error a nanosecond designated timestamp requires bigint.
void fromBrowser.row({ ticker: "a", price: 1, quantity: 1n, timestamp: 1 });
// @ts-expect-error the designated timestamp is required.
void fromBrowser.row({ ticker: "a", price: 1, quantity: 1n });
void fromBrowser.row({
  ticker: "a",
  price: 1,
  quantity: 1n,
  timestamp: 1n,
  // @ts-expect-error unknown columns are rejected.
  x: 1,
});

// The row type must also be nameable and enforced on its own.
const row: QwpWriterRow<typeof schema> = {
  ticker: "ETH-USD",
  price: 1,
  quantity: 1n,
  timestamp: 1n,
};
void row;

const browserRow: BrowserQwpWriterRow<typeof browserSchema> = {
  ticker: "ETH-USD",
  price: 1,
  quantity: 1n,
  timestamp: 1n,
};
void browserRow;
