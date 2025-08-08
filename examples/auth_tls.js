const { Sender } = require("@questdb/nodejs-client");

async function run() {
  // authentication details
  const USER = "admin";
  const PWD = "quest";

  // pass the authentication details to the sender
  // for secure connection use 'https' protocol instead of 'http'
  const sender = await Sender.fromConfig(
    `https::addr=127.0.0.1:9000;username=${USER};password=${PWD}`
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