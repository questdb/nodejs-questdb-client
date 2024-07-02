# QuestDB Node.js Client

## Requirements

The client requires Node.js v16 or newer version.

## Installation
```shell
npm i -s @questdb/nodejs-client
```

## Configuration options

Detailed description of the client's configuration options can be found in
the <a href="SenderOptions.html">SenderOptions</a> documentation.

## Examples

The examples below demonstrate how to use the client. <br>
For more details, please, check the <a href="Sender.html">Sender</a>'s documentation.

### Basic API usage

```javascript
const { Sender } = require('@questdb/nodejs-client');

async function run() {
    // create a sender using HTTP protocol
    const sender = Sender.fromConfig('http::addr=localhost:9000');

    // add rows to the buffer of the sender
    await sender.table('prices').symbol('instrument', 'EURUSD')
        .floatColumn('bid', 1.0195).floatColumn('ask', 1.0221)
        .at(Date.now(), 'ms');
    await sender.table('prices').symbol('instrument', 'GBPUSD')
        .floatColumn('bid', 1.2076).floatColumn('ask', 1.2082)
        .at(Date.now(), 'ms');

    // flush the buffer of the sender, sending the data to QuestDB
    // the buffer is cleared after the data is sent, and the sender is ready to accept new data
    await sender.flush();

    // add rows to the buffer again, and send it to the server
    await sender.table('prices').symbol('instrument', 'EURUSD')
        .floatColumn('bid', 1.0197).floatColumn('ask', 1.0224)
        .at(Date.now(), 'ms');
    await sender.flush();

    // close the connection after all rows ingested
    await sender.close();
}

run()
    .then(console.log)
    .catch(console.error);
```

### Authentication and secure connection

```javascript
const { Sender } = require('@questdb/nodejs-client');

async function run() {
    // create a sender using HTTPS protocol with username and password authentication
    const sender = Sender.fromConfig('https::addr=localhost:9000;username=user1;password=pwd');

    // send the data over the authenticated and secure connection
    await sender.table('prices').symbol('instrument', 'EURUSD')
        .floatColumn('bid', 1.0197).floatColumn('ask', 1.0224)
        .at(Date.now(), 'ms');
    await sender.flush();

    // close the connection after all rows ingested
    await sender.close();
}

run().catch(console.error);
```

### TypeScript example

```typescript
import { Sender } from '@questdb/nodejs-client';

async function run(): Promise<number> {
    // create a sender using HTTPS protocol with bearer token authentication
    const sender: Sender = Sender.fromConfig('https::addr=localhost:9000;token=Xyvd3er6GF87ysaHk');

    // send the data over the authenticated and secure connection
    sender.table('prices').symbol('instrument', 'EURUSD')
        .floatColumn('bid', 1.0197).floatColumn('ask', 1.0224).at(Date.now(), 'ms');
    await sender.flush();

    // close the connection after all rows ingested
    await sender.close();
}

run().catch(console.error);
```

### Worker threads example

```javascript
const { Sender } = require('@questdb/nodejs-client');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

// fake venue
// generates random prices for a ticker for max 5 seconds, then the feed closes
function* venue(ticker) {
    let end = false;
    setTimeout(() => { end = true; }, rndInt(5000));
    while (!end) {
        yield {'ticker': ticker, 'price': Math.random()};
    }
}

// market data feed simulator
// uses the fake venue to deliver price updates to the feed handler (onTick() callback)
async function subscribe(ticker, onTick) {
    const feed = venue(workerData.ticker);
    let tick;
    while (tick = feed.next().value) {
        await onTick(tick);
        await sleep(rndInt(30));
    }
}

async function run() {
    if (isMainThread) {
        const tickers = ['t1', 't2', 't3', 't4'];
        // main thread to start a worker thread for each ticker
        for (let ticker in tickers) {
            const worker = new Worker(__filename, { workerData: { ticker: ticker } })
                .on('error', (err) => { throw err; })
                .on('exit', () => { console.log(`${ticker} thread exiting...`); })
                .on('message', (msg) => {
                    console.log(`Ingested ${msg.count} prices for ticker ${msg.ticker}`);
                });
        }
    } else {
        // it is important that each worker has a dedicated sender object
        // threads cannot share the sender because they would write into the same buffer
        const sender = Sender.fromConfig('http::addr=localhost:9000');

        // subscribe for the market data of the ticker assigned to the worker
        // ingest each price update into the database using the sender
        let count = 0;
        await subscribe(workerData.ticker, async (tick) => {
            await sender
                .table('prices')
                .symbol('ticker', tick.ticker)
                .floatColumn('price', tick.price)
                .at(Date.now(), 'ms');
            await sender.flush();
            count++;
        });

        // let the main thread know how many prices were ingested
        parentPort.postMessage({'ticker': workerData.ticker, 'count': count});

        // close the connection to the database
        await sender.close();
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function rndInt(limit) {
    return Math.floor((Math.random() * limit) + 1);
}

run()
    .then(console.log)
    .catch(console.error);
```

## Community

If you need help, have additional questions or want to provide feedback, you
may find us on our [Community Forum](https://community.questdb.io/).

You can also [sign up to our mailing list](https://questdb.io/contributors/)
to get notified of new releases.
