const { Sender } = require("@questdb/nodejs-client");

async function run() {
  // create a sender using HTTP protocol
  const sender = Sender.fromConfig("http::addr=127.0.0.1:9000");

  // add rows to the buffer of the sender
  await sender
    .table("trades")
    .symbol("symbol", "ETH-USD")
    .symbol("side", "sell")
    .floatColumn("price", 2615.54)
    .floatColumn("amount", 0.00044)
    .at(Date.now(), "ms");

  // flush the buffer of the sender, sending the data to QuestDB
  // the buffer is cleared after the data is sent, and the sender is ready to accept new data
  await sender.flush();

  // close the connection after all rows ingested
  // unflushed data will be lost
  await sender.close();
}

run().then(console.log).catch(console.error);
