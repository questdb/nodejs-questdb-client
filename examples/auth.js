const { Sender } = require('@questdb/nodejs-client');

async function run() {
  // construct a JsonWebKey
  const CLIENT_ID = 'testapp';
  const PRIVATE_KEY = '9b9x5WhJywDEuo1KGQWSPNxtX-6X6R2BRCKhYMMY6n8';
  const PUBLIC_KEY = {
    x: 'aultdA0PjhD_cWViqKKyL5chm6H1n-BiZBo_48T-uqc',
    y: '__ptaol41JWSpTTL525yVEfzmY8A6Vi_QrW1FjKcHMg',
  };
  const JWK = {
    ...PUBLIC_KEY,
    d: PRIVATE_KEY,
    kid: CLIENT_ID,
    kty: 'EC',
    crv: 'P-256',
  };

  // pass the JsonWebKey to the sender
  // will use it for authentication
  const sender = new Sender({ bufferSize: 4096, jwk: JWK });

  // connect() takes an optional second argument
  // if 'true' passed the connection is secured with TLS encryption
  await sender.connect({ port: 9009, host: 'localhost' }, false);

  // send the data over the authenticated connection
  let bday = Date.parse('1856-07-10');
  sender
    .table('inventors')
    .symbol('born', 'Austrian Empire')
    .timestampColumn('birthday', bday, 'ms') // epoch in millis
    .intColumn('id', 0)
    .stringColumn('name', 'Nicola Tesla')
    .at(Date.now(), 'ms'); // epoch in millis
  bday = Date.parse('1847-02-11');
  sender
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
