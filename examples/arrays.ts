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
