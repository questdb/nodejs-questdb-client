const { Sender } = require("@questdb/nodejs-client");
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
