## QuestDB Node.js Client

## Installation
```shell
npm install @questdb/nodejs-client
```

## Examples

### Basic API usage
```javascript
const { Sender } = require("@questdb/nodejs-client");

async function run() {
    // create a sender with a 4k buffer
    // it is important to size the buffer correctly so messages can fit
    const sender = new Sender({bufferSize: 4096});

    // connect to QuestDB
    // host and port are required in connect options
    await sender.connect({port: 9009, host: "localhost"});

    // add rows to the buffer of the sender
    sender.table("prices").symbol("instrument", "EURUSD")
        .floatColumn("bid", 1.0195).floatColumn("ask", 1.0221).atNow();
    sender.table("prices").symbol("instrument", "GBPUSD")
        .floatColumn("bid", 1.2076).floatColumn("ask", 1.2082).atNow();

    // flush the buffer of the sender, sending the data to QuestDB
    // the buffer is cleared after the data is sent and the sender is ready to accept new data
    await sender.flush();

    // add rows to the buffer again and send it to the server
    sender.table("prices").symbol("instrument", "EURUSD")
        .floatColumn("bid", 1.0197).floatColumn("ask", 1.0224).atNow();
    await sender.flush();

    // close the connection after all rows ingested
    await sender.close();
    return new Promise(resolve => resolve(0));
}

run().then(value => console.log(value)).catch(err => console.log(err));
```

### Authentication and secure connection
```javascript
const { Sender } = require("@questdb/nodejs-client");

async function run() {
    // construct a JsonWebKey
    const CLIENT_ID = "testapp";
    const PRIVATE_KEY = "9b9x5WhJywDEuo1KGQWSPNxtX-6X6R2BRCKhYMMY6n8";
    const PUBLIC_KEY = {
        x: "aultdA0PjhD_cWViqKKyL5chm6H1n-BiZBo_48T-uqc",
        y: "__ptaol41JWSpTTL525yVEfzmY8A6Vi_QrW1FjKcHMg"
    };
    const JWK = {
        ...PUBLIC_KEY,
        d: PRIVATE_KEY,
        kid: CLIENT_ID,
        kty: "EC",
        crv: "P-256",
    };

    // pass the JsonWebKey to the sender
    // will use it for authentication
    const sender = new Sender({bufferSize: 4096, jwk: JWK});

    // connect() takes an optional second argument
    // if 'true' passed the connection is secured with TLS encryption
    await sender.connect({port: 9009, host: "localhost"}, true);

    // send the data over the authenticated and secure connection
    sender.table("prices").symbol("instrument", "EURUSD")
        .floatColumn("bid", 1.0197).floatColumn("ask", 1.0224).atNow();
    await sender.flush();

    // close the connection after all rows ingested
    await sender.close();
    return new Promise(resolve => resolve(0));
}

run().then(value => console.log(value)).catch(err => console.log(err));
```

### TypeScript example
```typescript
import { Sender } from "@questdb/nodejs-client";

async function run(): Promise<number> {
    // construct a JsonWebKey
    const CLIENT_ID: string = "testapp";
    const PRIVATE_KEY: string = "9b9x5WhJywDEuo1KGQWSPNxtX-6X6R2BRCKhYMMY6n8";
    const PUBLIC_KEY: { x: string, y: string } = {
        x: "aultdA0PjhD_cWViqKKyL5chm6H1n-BiZBo_48T-uqc",
        y: "__ptaol41JWSpTTL525yVEfzmY8A6Vi_QrW1FjKcHMg"
    };
    const JWK: { x: string, y: string, kid: string, kty: string, d: string, crv: string } = {
        ...PUBLIC_KEY,
        d: PRIVATE_KEY,
        kid: CLIENT_ID,
        kty: "EC",
        crv: "P-256",
    };

    // pass the JsonWebKey to the sender
    // will use it for authentication
    const sender: Sender = new Sender({bufferSize: 4096, jwk: JWK});

    // connect() takes an optional second argument
    // if 'true' passed the connection is secured with TLS encryption
    await sender.connect({port: 9009, host: "localhost"}, true);

    // send the data over the authenticated and secure connection
    sender.table("prices").symbol("instrument", "EURUSD")
        .floatColumn("bid", 1.0197).floatColumn("ask", 1.0224).atNow();
    await sender.flush();

    // close the connection after all rows ingested
    await sender.close();
    return new Promise(resolve => resolve(0));
}

run().then(value => console.log(value)).catch(err => console.log(err));
```

### Worker threads example
```javascript
const { Sender } = require("@questdb/nodejs-client");
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

// fake venue
// generates random prices for a ticker for max 5 seconds, then the feed closes
function* venue(ticker) {
    let end = false;
    setTimeout(() => { end = true; }, rndInt(5000));
    while (!end) {
        yield {"ticker": ticker, "price": Math.random()};
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
        const tickers = ["t1", "t2", "t3", "t4"];
        // main thread to start a worker thread for each ticker
        for (let ticker in tickers) {
            const worker = new Worker(__filename, { workerData: { ticker: ticker } })
                .on('error', (err) => { throw err; })
                .on('exit', () => { console.log(`${ticker} thread exiting...`); })
                .on('message', (msg) => { console.log("Ingested " + msg.count + " prices for ticker " + msg.ticker); });
        }
    } else {
        // it is important that each worker has a dedicated sender object
        // threads cannot share the sender because they would write into the same buffer
        const sender = new Sender({ bufferSize: 4096 });
        await sender.connect({ port: 9009, host: "localhost" });

        // subscribe for the market data of the ticker assigned to the worker
        // ingest each price update into the database using the sender
        let count = 0;
        await subscribe(workerData.ticker, async (tick) => {
            sender
                .table("prices")
                .symbol("ticker", tick.ticker)
                .floatColumn("price", tick.price)
                .atNow();
            await sender.flush();
            count++;
        });

        // let the main thread know how many prices were ingested
        parentPort.postMessage({"ticker": workerData.ticker, "count": count});

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

run().catch((err) => console.log(err));
```
