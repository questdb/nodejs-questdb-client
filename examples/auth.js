const { Sender } = require("@questdb/nodejs-client");

async function run() {
  // construct a JsonWebKey
  const CLIENT_ID = "testapp";
  const PRIVATE_KEY = "9b9x5WhJywDEuo1KGQWSPNxtX-6X6R2BRCKhYMMY6n8";
  const PUBLIC_KEY = {
    x: "aultdA0PjhD_cWViqKKyL5chm6H1n-BiZBo_48T-uqc",
    y: "__ptaol41JWSpTTL525yVEfzmY8A6Vi_QrW1FjKcHMg"
  };
  const JWK = {
    ...PUBLIC_KEY,
    d: PRIVATE_KEY,
    kid: CLIENT_ID,
    kty: "EC",
    crv: "P-256",
  };

  // pass the JsonWebKey to the sender
  // will use it for authentication
  const sender = new Sender({bufferSize: 4096, jwk: JWK});

  // connect() takes an optional second argument
  // if 'true' passed the connection is secured with TLS encryption
  await sender.connect({port: 9009, host: "127.0.0.1"}, false);

  // send the data over the authenticated connection
  sender.table("prices").symbol("instrument", "EURUSD")
      .floatColumn("bid", 1.0197).floatColumn("ask", 1.0224).atNow();
  await sender.flush();

  // close the connection after all rows ingested
  await sender.close();
  return 0;
}

run().then(value => console.log(value)).catch(err => console.log(err));