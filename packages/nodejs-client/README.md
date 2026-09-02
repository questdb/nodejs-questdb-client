# QuestDB JavaScript Client for Node.js

The official QuestDB client for Node.js and TypeScript. Use it to ingest rows
with the InfluxDB Line Protocol (ILP), ingest and query with the QuestDB Wire
Protocol (QWP), and keep publishing through outages with Node-only persistent
store-and-forward.

The complete Node.js API is exported from `@questdb/nodejs-client`. There are no
additional public import paths.

## Features

- ILP ingestion over HTTP, HTTPS, TCP, and TLS-encrypted TCP
- QWP ingestion over WebSocket, secure WebSocket, and UDP
- Streaming QWP queries with typed bind variables and result batches
- Automatic batching, failover, reconnect, and acknowledgement tracking
- Persistent QWP store-and-forward for process and server outages
- ESM, CommonJS, and bundled TypeScript declarations

## Requirements

- Node.js 20 or newer
- A running QuestDB instance
- QWP endpoints `/write/v4` and `/read/v1` for QWP ingestion and queries

## Installation

```shell
npm install @questdb/nodejs-client
```

```shell
yarn add @questdb/nodejs-client
```

```shell
pnpm add @questdb/nodejs-client
```

## Quick start: ILP over HTTP

`Sender` buffers rows locally. Add as many complete rows as needed, then call
`flush()` to send the batch.

```typescript
import { Sender } from "@questdb/nodejs-client";

const sender = await Sender.fromConfig("http::addr=localhost:9000");

try {
  await sender
    .table("trades")
    .symbol("symbol", "ETH-USD")
    .symbol("side", "buy")
    .floatColumn("price", 2_615.54)
    .floatColumn("amount", 0.25)
    .at(Date.now(), "ms");

  await sender.flush();
} finally {
  await sender.close();
}
```

HTTP and HTTPS connect for each request. TCP, TCPS, WS, WSS, and UDP transports
have an explicit connection, so call `await sender.connect()` before writing.

## Choosing a transport

| Configuration prefix | Protocol | Typical use                                             |
| -------------------- | -------- | ------------------------------------------------------- |
| `http::`, `https::`  | ILP      | Recommended general-purpose ingestion                   |
| `tcp::`, `tcps::`    | ILP      | Long-lived ILP connection                               |
| `ws::`, `wss::`      | QWP      | Acknowledged ingestion, failover, and store-and-forward |
| `udp::`              | QWP      | Fire-and-forget datagrams on trusted networks           |

Use encrypted transports and certificate verification outside trusted local
development environments.

## Batch multiple rows

Avoid flushing after every row when the application can send a larger batch.
The sender also supports automatic flushing through its configuration options.

```typescript
import { Sender } from "@questdb/nodejs-client";

const sender = await Sender.fromConfig("http::addr=localhost:9000");

try {
  for (const trade of [
    { symbol: "ETH-USD", price: 2_615.54, amount: 0.25 },
    { symbol: "BTC-USD", price: 59_750.1, amount: 0.01 },
  ]) {
    await sender
      .table("trades")
      .symbol("symbol", trade.symbol)
      .floatColumn("price", trade.price)
      .floatColumn("amount", trade.amount)
      .atNow();
  }

  await sender.flush();
} finally {
  await sender.close();
}
```

Passing `null` or `undefined` to a supported symbol or column method omits that
column from the row, which records a SQL `NULL` in QuestDB.

## Authentication and TLS

Configuration strings use the form
`protocol::key=value;key=value`. HTTP Basic authentication uses `username` and
`password`; REST and OIDC access tokens use `token`.

```typescript
import { Sender } from "@questdb/nodejs-client";

const sender = await Sender.fromConfig(
  `https::addr=questdb.example:9000;token=${process.env.QUESTDB_TOKEN};tls_verify=on`,
);

try {
  await sender.table("service_health").booleanColumn("healthy", true).atNow();
  await sender.flush();
} finally {
  await sender.close();
}
```

The same configuration can be provided through `QDB_CLIENT_CONF`:

```typescript
import { Sender } from "@questdb/nodejs-client";

// QDB_CLIENT_CONF=http::addr=localhost:9000
const sender = await Sender.fromEnv();
```

## QWP ingestion

Changing the configuration prefix to `ws::` or `wss::` selects QWP while
keeping the familiar `Sender` row API.

```typescript
import { Sender } from "@questdb/nodejs-client";

const sender = await Sender.fromConfig(
  `wss::addr=questdb.example:9000;token=${process.env.QUESTDB_TOKEN};auto_flush=off`,
);
await sender.connect();

try {
  await sender
    .table("trades")
    .symbol("symbol", "ETH-USD")
    .floatColumn("price", 2_615.54)
    .timestampColumn("received_at", Date.now(), "ms")
    .atNow();

  await sender.flush();
} finally {
  await sender.close();
}
```

QWP senders support server acknowledgements, durable acknowledgements,
transactions, reconnect, failover, compiled row writers, and metrics. See the
[QWP guide](https://github.com/questdb/nodejs-questdb-client/blob/main/QWP.md)
for the delivery semantics of each option.

### Type-safe object rows

For repeated object-shaped rows, compile a table schema once. TypeScript then
checks each row against that schema.

```typescript
import {
  Sender,
  designatedTimestamp,
  double,
  long,
  symbol,
} from "@questdb/nodejs-client";

const sender = await Sender.fromConfig("ws::addr=localhost:9000");
await sender.connect();

try {
  const trades = sender.writer("trades", {
    symbol: symbol(),
    side: symbol(),
    price: double(),
    quantity: long(),
    timestamp: designatedTimestamp("ns"),
  });

  await trades.rows([
    {
      symbol: "ETH-USD",
      side: "buy",
      price: 2_615.54,
      quantity: 42n,
      timestamp: 1_723_000_000_000_000_000n,
    },
    {
      symbol: "BTC-USD",
      side: "sell",
      price: 59_750.1,
      quantity: 1n,
      timestamp: 1_723_000_001_000_000_000n,
    },
  ]);

  await sender.flush();
} finally {
  await sender.close();
}
```

Compiled writers are available with QWP transports only.

## QWP queries

QWP egress streams typed result batches. One egress session executes one active
query at a time.

```typescript
import { connectQwpNodeEgress } from "@questdb/nodejs-client";

const session = await connectQwpNodeEgress(
  {
    url: "wss://questdb.example:9000/read/v1",
    authorization: `Bearer ${process.env.QUESTDB_TOKEN}`,
    compression: "zstd",
  },
  { queryTimeoutMs: 30_000 },
);

try {
  const query = await session.query(
    "select timestamp, symbol, price from trades where symbol = $1",
    {
      // Bind index 0 corresponds to SQL placeholder $1.
      binds: (binds) => binds.setVarchar(0, "ETH-USD"),
      initialCredit: 1024 * 1024,
    },
  );

  for await (const batch of query) {
    for (const row of batch.rows()) {
      console.log(row);
    }
  }

  await query.completion;
} finally {
  await session.close();
}
```

Use `queryViews()` instead of `query()` for reusable, allocation-conscious
column and row views.

## Persistent store-and-forward

Node.js can journal QWP frames to disk before sending them. The producer can
continue accepting rows during a QuestDB outage and replay them in order after
reconnection.

```typescript
import { Sender } from "@questdb/nodejs-client";

const sender = await Sender.fromConfig(
  "wss::" +
    "addr=questdb-a.example:9000,questdb-b.example:9000;" +
    "sf_dir=/var/lib/my-service/questdb-replay;" +
    "initial_connect_retry=async;",
);

await sender.connect();
```

Give every active producer its own journal directory. Durability,
backpressure, capacity, orphan recovery, and shutdown behavior are covered in
the [store-and-forward section of the QWP guide](https://github.com/questdb/nodejs-questdb-client/blob/main/QWP.md#store-and-forward-node-only).

## Error handling and shutdown

- Always call `close()` in a `finally` block.
- Call `flush()` before closing an ILP sender; otherwise buffered rows are lost.
- A QWP sender publishes completed rows during close, but an unfinished row is
  never completed implicitly.
- Do not write concurrently through one `Sender`. Give each worker or producer
  its own sender.
- Treat authentication and protocol errors as configuration failures rather
  than retrying the same request indefinitely.

## More documentation

- [Complete repository README](https://github.com/questdb/nodejs-questdb-client#readme)
- [QWP guide](https://github.com/questdb/nodejs-questdb-client/blob/main/QWP.md)
- [Node.js API reference](https://questdb.github.io/nodejs-questdb-client/modules/_questdb_nodejs-client.html)
- [QuestDB documentation](https://questdb.com/docs/)
- [QuestDB Community Forum](https://community.questdb.com/)
