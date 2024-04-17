const { Sender } = require('@questdb/nodejs-client');

async function run() {
  // configure the sender
  const sender = Sender.fromConfig('http::addr=localhost:9000');

  // add rows to the buffer of the sender
  let bday = Date.parse('1856-07-10');
  await sender
    .table('inventors')
    .symbol('born', 'Austrian Empire')
    .timestampColumn('birthday', bday, 'ms') // epoch in millis
    .intColumn('id', 0)
    .stringColumn('name', 'Nicola Tesla')
    .at(Date.now(), 'ms'); // epoch in millis
  bday = Date.parse('1847-02-11');
  await sender
    .table('inventors')
    .symbol('born', 'USA')
    .timestampColumn('birthday', bday, 'ms')
    .intColumn('id', 1)
    .stringColumn('name', 'Thomas Alva Edison')
    .at(Date.now(), 'ms');

  // flush the buffer of the sender, sending the data to QuestDB
  // the buffer is cleared after the data is sent and the sender is ready to accept new data
  await sender.flush();

  // close the connection after all rows were sent
  await sender.close();
}

run().catch(console.error);
