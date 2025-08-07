# QuestDB Node.js Client

## Requirements

The client requires Node.js v20 or newer version.

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

| QuestDB client version | Node.js version | HTTP Agent   |
|------------------------| --------------- |--------------|
| ^4.0.0                 | >=v20.X.X       | Undici Agent |
| ^3.0.0                 | <v20.X.X        | Http Agent   |

## Configuration options

Detailed description of the client's configuration options can be found in
the <a href="https://questdb.github.io/nodejs-questdb-client/SenderOptions.html">SenderOptions</a> documentation.

## Examples

The examples below demonstrate how to use the client. <br>
For more details, please, check the <a href="https://questdb.github.io/nodejs-questdb-client/Sender.html">Sender</a>'s documentation.

### Basic API usage

```javascript
import { Sender } from "@questdb/nodejs-client";

async function run() {
    // create a sender
    const sender = await Sender.fromConfig('http::addr=localhost:9000');

    // order book snapshots
    const orderBooks = [
        {
            symbol: 'BTC-USD',
            exchange: 'COINBASE',
            timestamp: Date.now(),
            bidPrices: [50100.25, 50100.20, 50100.15, 50100.10, 50100.05],
            bidSizes: [0.5, 1.2, 2.1, 0.8, 3.5],
            askPrices: [50100.30, 50100.35, 50100.40, 50100.45, 50100.50],
            askSizes: [0.6, 1.5, 1.8, 2.2, 4.0]
        },
        {
            symbol: 'ETH-USD',
            exchange: 'COINBASE',
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

### Authentication and secure connection

#### Username and password authentication

```javascript
import { Sender } from "@questdb/nodejs-client";

async function run() {
  // create a sender using HTTPS protocol with username and password authentication
  const sender = Sender.fromConfig(
    "https::addr=127.0.0.1:9000;username=admin;password=quest",
  );

  // send the data over the authenticated and secure connection
  await sender
    .table("trades")
    .symbol("symbol", "ETH-USD")
    .symbol("side", "sell")
    .floatColumn("price", 2615.54)
    .floatColumn("amount", 0.00044)
    .at(Date.now(), "ms");
  await sender.flush();

  // close the connection after all rows ingested
  await sender.close();
}

run().catch(console.error);
```

#### Token authentication

```typescript
import { Sender } from "@questdb/nodejs-client";

async function run(): Promise<void> {
  // create a sender using HTTPS protocol with bearer token authentication
  const sender: Sender = Sender.fromConfig(
    "https::addr=127.0.0.1:9000;token=Xyvd3er6GF87ysaHk",
  );

  // send the data over the authenticated and secure connection
  await sender
    .table("trades")
    .symbol("symbol", "ETH-USD")
    .symbol("side", "sell")
    .floatColumn("price", 2615.54)
    .floatColumn("amount", 0.00044)
    .at(Date.now(), "ms");
  await sender.flush();

  // close the connection after all rows ingested
  await sender.close();
}

run().catch(console.error);
```

### Worker threads example

```javascript
import { Sender } from "@questdb/nodejs-client";
const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require("worker_threads");

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
      const worker = new Worker(__filename, { workerData: { ticker: ticker } })
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
    const sender = Sender.fromConfig("http::addr=127.0.0.1:9000");

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rndInt(limit) {
  return Math.floor(Math.random() * limit + 1);
}

run().then(console.log).catch(console.error);
```

## Community

If you need help, have additional questions or want to provide feedback, you
may find us on our [Community Forum](https://community.questdb.io/).

You can also [sign up to our mailing list](https://questdb.io/contributors/)
to get notified of new releases.
