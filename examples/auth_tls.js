const { Sender } = require('@questdb/nodejs-client');

async function run() {
  // configure the sender to use HTTPS and authentication
  const sender = Sender.fromConfig('https::addr=localhost:9000;username=ingest;password=pwd');

  // send the data over the authenticated and secure connection
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
  await sender.flush();

  // close the connection after all rows ingested
  await sender.close();
}

run().catch(console.error);
