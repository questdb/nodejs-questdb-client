const { Sender } = require("@questdb/nodejs-client");

async function run() {
  // create a sender with a 4KB buffer
  const sender = new Sender({ bufferSize: 4096 });

  // connect to QuestDB
  // host and port are required in connect options
  await sender.connect({ port: 9009, host: "localhost" });

  // add rows to the buffer of the sender
  let bday = Date.parse("1856-07-10");
  sender
    .table("inventors")
    .symbol("born", "Austrian Empire")
    .timestampColumn("birthday", BigInt(bday) * 1000n) // epoch in micros (BigInt)
    .intColumn("id", 0)
    .stringColumn("name", "Nicola Tesla")
    .at(BigInt(Date.now()) * 1000_000n); // epoch in nanos (BigInt)
  bday = Date.parse("1847-02-11");
  sender
    .table("inventors")
    .symbol("born", "USA")
    .timestampColumn("birthday", BigInt(bday) * 1000n)
    .intColumn("id", 1)
    .stringColumn("name", "Thomas Alva Edison")
    .atNow();

  // flush the buffer of the sender, sending the data to QuestDB
  // the buffer is cleared after the data is sent and the sender is ready to accept new data
  await sender.flush();

  // close the connection after all rows were sent
  await sender.close();
  return 0;
}

run()
  .then(console.log)
  .catch(console.error);
