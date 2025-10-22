## Installation

```shell
# With npm
npm i -s @questdb/nodejs-client

# With yarn
yarn add @questdb/nodejs-client

# With pnpm
pnpm add @questdb/nodejs-client
```

## Compatibility table

| QuestDB client version | Supported Node.js versions | Default HTTP Agent  |
|------------------------|----------------------------|---------------------|
| ^4.0.0                 | v20 and above              | Undici Http Agent   |
| ^3.0.0                 | v16 and above              | Standard Http Agent |

The current version of the client requires Node.js v20 or newer version.
Versions up to and including 3.0.0 are compatible with Node.js v16 and above.

The Undici HTTP agent was introduced in 4.0.0, and it is the default HTTP transport.
The standard HTTP/HTTPS modules of Node.js are still supported for backwards compatibility.
Use the <i>stdlib_http</i> option to switch to the standard HTTP/HTTPS modules.

## Configuration options

Detailed description of the client's configuration options can be found in
the {@link SenderOptions} documentation.

## Examples

The examples below demonstrate how to use the client. <br>
For more details, please, check the {@link Sender}'s documentation.

### Basic API usage

```typescript
import { Sender } from "@questdb/nodejs-client";

async function run() {
  // create a sender using HTTP protocol
  const sender = await Sender.fromConfig("http::addr=127.0.0.1:9000");

  // add rows to the buffer of the sender
  await sender
    .table("trades")
    .symbol("symbol", "BTC-USD")
    .symbol("side", "sell")
    .floatColumn("price", 39269.98)
    .floatColumn("amount", 0.011)
    .at(Date.now(), "ms");

  // flush the buffer of the sender, sending the data to QuestDB
  // the buffer is cleared after the data is sent, and the sender is ready to accept new data
  await sender.flush();

  // close the connection after all rows ingested
  // unflushed data will be lost
  await sender.close();
}

run().then(console.log).catch(console.error);
```

### Authentication and secure connection

#### Username and password authentication with HTTP transport

```typescript
import { Sender } from "@questdb/nodejs-client";

async function run() {
  // authentication details
  const USER = "admin";
  const PWD = "quest";

  // pass the authentication details to the sender
  // for secure connection use 'https' protocol instead of 'http'
  const sender = await Sender.fromConfig(
    `http::addr=127.0.0.1:9000;username=${USER};password=${PWD}`
  );

  // add rows to the buffer of the sender
  await sender
    .table("trades")
    .symbol("symbol", "ETH-USD")
    .symbol("side", "sell")
    .floatColumn("price", 2615.54)
    .floatColumn("amount", 0.00044)
    .at(Date.now(), "ms");

  // flush the buffer of the sender, sending the data to QuestDB
  await sender.flush();

  // close the connection after all rows ingested
  await sender.close();
}

run().catch(console.error);
```

#### REST token authentication with HTTP transport

```typescript
import { Sender } from "@questdb/nodejs-client";

async function run() {
  // authentication details
  const TOKEN = "Xyvd3er6GF87ysaHk";

  // pass the authentication details to the sender
  // for secure connection use 'https' protocol instead of 'http'
  const sender = await Sender.fromConfig(
    `http::addr=127.0.0.1:9000;token=${TOKEN}`
  );

  // add rows to the buffer of the sender
  await sender
    .table("trades")
    .symbol("symbol", "ETH-USD")
    .symbol("side", "sell")
    .floatColumn("price", 2615.54)
    .floatColumn("amount", 0.00044)
    .at(Date.now(), "ms");

  // flush the buffer of the sender, sending the data to QuestDB
  await sender.flush();

  // close the connection after all rows ingested
  await sender.close();
}

run().catch(console.error);
```

#### JWK token authentication with TCP transport

```typescript
import { Sender } from "@questdb/nodejs-client";

async function run() {
  // authentication details
  const CLIENT_ID = "admin";
  const PRIVATE_KEY = "ZRxmCOQBpZoj2fZ-lEtqzVDkCre_ouF3ePpaQNDwoQk";

  // pass the authentication details to the sender
  const sender = await Sender.fromConfig(
    `tcp::addr=127.0.0.1:9009;username=${CLIENT_ID};token=${PRIVATE_KEY}`
  );
  await sender.connect();

  // add rows to the buffer of the sender
  await sender
    .table("trades")
    .symbol("symbol", "BTC-USD")
    .symbol("side", "sell")
    .floatColumn("price", 39269.98)
    .floatColumn("amount", 0.001)
    .at(Date.now(), "ms");

  // flush the buffer of the sender, sending the data to QuestDB
  await sender.flush();

  // close the connection after all rows ingested
  await sender.close();
}

run().catch(console.error);
```

### Array usage example

```typescript
import { Sender } from "@questdb/nodejs-client";

async function run() {
  // create a sender
  const sender = await Sender.fromConfig('http::addr=localhost:9000');

  // order book snapshots to ingest
  const orderBooks = [
    {
      symbol: 'BTC-USD',
      exchange: 'Coinbase',
      timestamp: Date.now(),
      bidPrices: [50100.25, 50100.20, 50100.15, 50100.10, 50100.05],
      bidSizes: [0.5, 1.2, 2.1, 0.8, 3.5],
      askPrices: [50100.30, 50100.35, 50100.40, 50100.45, 50100.50],
      askSizes: [0.6, 1.5, 1.8, 2.2, 4.0]
    },
    {
      symbol: 'ETH-USD',
      exchange: 'Coinbase',
      timestamp: Date.now(),
      bidPrices: [2850.50, 2850.45, 2850.40, 2850.35, 2850.30],
      bidSizes: [5.0, 8.2, 12.5, 6.8, 15.0],
      askPrices: [2850.55, 2850.60, 2850.65, 2850.70, 2850.75],
      askSizes: [4.5, 7.8, 10.2, 8.5, 20.0]
    }
  ];

  try {
    // add rows to the buffer of the sender
    for (const orderBook of orderBooks) {
      await sender
        .table('order_book_l2')
        .symbol('symbol', orderBook.symbol)
        .symbol('exchange', orderBook.exchange)
        .arrayColumn('bid_prices', orderBook.bidPrices)
        .arrayColumn('bid_sizes', orderBook.bidSizes)
        .arrayColumn('ask_prices', orderBook.askPrices)
        .arrayColumn('ask_sizes', orderBook.askSizes)
        .at(orderBook.timestamp, 'ms');
    }

    // flush the buffer of the sender, sending the data to QuestDB
    // the buffer is cleared after the data is sent, and the sender is ready to accept new data
    await sender.flush();
  } finally {
    // close the connection after all rows ingested
    await sender.close();
  }
}

run().then(console.log).catch(console.error);
```

### Worker threads example

```typescript
import { Sender } from "@questdb/nodejs-client";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";

// fake venue
// generates random prices and amounts for a ticker for max 5 seconds, then the feed closes
function* venue(ticker) {
  let end = false;
  setTimeout(() => {
    end = true;
  }, rndInt(5000));
  while (!end) {
    yield { ticker, price: Math.random(), amount: Math.random() };
  }
}

// market data feed simulator
// uses the fake venue to deliver price and amount updates to the feed handler (onTick() callback)
async function subscribe(ticker, onTick) {
  const feed = venue(workerData.ticker);
  let tick;
  while ((tick = feed.next().value)) {
    await onTick(tick);
    await sleep(rndInt(30));
  }
}

async function run() {
  if (isMainThread) {
    const tickers = ["ETH-USD", "BTC-USD", "SOL-USD", "DOGE-USD"];
    // main thread to start a worker thread for each ticker
    for (let ticker of tickers) {
      new Worker(__filename, { workerData: { ticker: ticker } })
        .on("error", (err) => {
          throw err;
        })
        .on("exit", () => {
          console.log(`${ticker} thread exiting...`);
        })
        .on("message", (msg) => {
          console.log(`Ingested ${msg.count} prices for ticker ${msg.ticker}`);
        });
    }
  } else {
    // it is important that each worker has a dedicated sender object
    // threads cannot share the sender because they would write into the same buffer
    const sender = await Sender.fromConfig("http::addr=127.0.0.1:9000");

    // subscribe for the market data of the ticker assigned to the worker
    // ingest each price update into the database using the sender
    let count = 0;
    await subscribe(workerData.ticker, async (tick) => {
      await sender
        .table("trades")
        .symbol("symbol", tick.ticker)
        .symbol("side", "sell")
        .floatColumn("price", tick.price)
        .floatColumn("amount", tick.amount)
        .at(Date.now(), "ms");
      await sender.flush();
      count++;
    });

    // let the main thread know how many prices were ingested
    parentPort.postMessage({ ticker: workerData.ticker, count });

    // close the connection to the database
    await sender.close();
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rndInt(limit: number) {
  return Math.floor(Math.random() * limit + 1);
}

run().then(console.log).catch(console.error);
```

### Decimal usage example

Since v9.2.0, QuestDB supports the DECIMAL data type.
Decimals can be ingested with ILP protocol v3 using either textual or binary representation.

#### Textual representation

```typescript
import { Sender } from "@questdb/nodejs-client";

async function runDecimals() {
  const sender = await Sender.fromConfig(
    "tcp::addr=127.0.0.1:9009;protocol_version=3",
  );

  await sender
    .table("fx")
    // textual ILP form keeps the literal and its exact scale
    .decimalColumnText("mid", "1.234500")
    .atNow();

  await sender.flush();
  await sender.close();
}

runDecimals().catch(console.error);
// Resulting ILP line: fx mid=1.234500d
```

#### Binary representation

It is recommended to use the binary representation for better ingestion performance and reduced payload size (for bigger decimals).

```typescript
import { Sender } from "@questdb/nodejs-client";

async function runDecimals() {
  const sender = await Sender.fromConfig(
    "tcp::addr=127.0.0.1:9009;protocol_version=3",
  );

  await sender
    .table("fx")
    // textual ILP form keeps the literal and its exact scale
    .decimalColumnUnscaled("mid", 123456n, 3) // 123456 * 10^-3 = 123.456
    .atNow();

  await sender.flush();
  await sender.close();
}

runDecimals().catch(console.error);
```

## Community

If you need help, have additional questions or want to provide feedback, you
may find us on our [Community Forum](https://community.questdb.io/).

You can also [sign up to our mailing list](https://questdb.io/contributors/)
to get notified of new releases.
