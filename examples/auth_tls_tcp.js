const { Sender } = require("@questdb/nodejs-client");

async function run() {
  // authentication details
  const CLIENT_ID = "admin";
  const PRIVATE_KEY = "ZRxmCOQBpZoj2fZ-lEtqzVDkCre_ouF3ePpaQNDwoQk";

  // pass the authentication details to the sender
  const sender = await Sender.fromConfig(
    `tcps::addr=127.0.0.1:9009;username=${CLIENT_ID};token=${PRIVATE_KEY}`
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