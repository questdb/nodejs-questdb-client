const { Sender } = require("@questdb/nodejs-client");

async function run() {
  // authentication details
  const CLIENT_ID = "admin";
  const PRIVATE_KEY = "ZRxmCOQBpZoj2fZ-lEtqzVDkCre_ouF3ePpaQNDwoQk";
  const AUTH = {
    keyId: CLIENT_ID,
    token: PRIVATE_KEY,
  };

  // pass the authentication details to the sender
  const sender = new Sender({
    protocol: "tcps",
    host: "127.0.0.1",
    port: 9009,
    bufferSize: 4096,
    auth: AUTH,
  });
  await sender.connect();

  // send the data over the authenticated connection
  await sender
    .table("trades")
    .symbol("symbol", "ETH-USD")
    .symbol("side", "sell")
    .floatColumn("price", 2615.54)
    .floatColumn("amount", 0.00044)
    .at(Date.now(), "ms");

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
