const { Sender } = require("@questdb/nodejs-client");

async function run() {
  // create a sender with a 4k buffer
  const sender = new Sender({bufferSize: 4096});

  // connect to QuestDB
  // host and port are required in connect options
  await sender.connect({port: 9009, host: "127.0.0.1"});

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
  return 0;
}

run().then(value => console.log(value)).catch(err => console.log(err));