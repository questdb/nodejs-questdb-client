## QuestDB Node.js Client

## Installation
```shell
npm install @questdb/nodejs-client
```

## Examples

### Basic API usage
```javascript
const { Sender } = require("@questdb/nodejs-client");

async function run() {
    // create a sender with a 4k buffer
    // it is important to size the buffer correctly so messages can fit
    const sender = new Sender(4096);

    // connect to QuestDB
    // host and port are required in connect options
    await sender.connect({port: 9009, host: "127.0.0.1"});

    // add rows to the buffer of the sender either in JSON format or as Row objects
    // if adding a single row no need to pass it as an array
    sender.rows([
        new Row("prices", {"instrument": "EURUSD"}, {"bid": 1.0195, "ask": 1.0221}),
        new Row("prices", {"instrument": "GBPUSD"}, {"bid": 1.2076, "ask": 1.2082})
    ]);
    sender.rows({
        "table": "prices",
        "symbols": {"instrument": "USDJPY"},
        "columns": {"bid": 134.9730, "ask": 135.1450}
    });

    // flush the buffer of the sender, sending the data to QuestDB
    // the buffer is cleared after the data is sent and the sender is ready to accept new data
    await sender.flush();

    // close the connection after all rows ingested
    await sender.close();
    return new Promise(resolve => resolve(0));
}

run().then(value => console.log(value)).catch(err => console.log(err));
```

### Authentication and secure connection
```javascript
const { Sender, Row } = require("@questdb/nodejs-client");

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
    const sender = new Sender(4096, JWK);

    // connect() takes an optional second argument
    // if 'true' passed the connection is secured with TLS encryption
    await sender.connect({port: 9009, host: "127.0.0.1"}, true);

    // send the data over the authenticated and secure connection
    sender.rows(new Row("prices", { "instrument": "EURUSD" }, { "bid": 1.0195, "ask": 1.0221 }));
    await sender.flush();

    // close the connection after all rows ingested
    await sender.close();
    return new Promise(resolve => resolve(0));
}

run().then(value => console.log(value)).catch(err => console.log(err));
```

### Typescript example
```typescript
import { Sender, Row } from "@questdb/nodejs-client";

async function run(): Promise<number> {
    // construct a JsonWebKey
    const CLIENT_ID: string = "testapp";
    const PRIVATE_KEY: string = "9b9x5WhJywDEuo1KGQWSPNxtX-6X6R2BRCKhYMMY6n8";
    const PUBLIC_KEY: { x: string, y: string } = {
        x: "aultdA0PjhD_cWViqKKyL5chm6H1n-BiZBo_48T-uqc",
        y: "__ptaol41JWSpTTL525yVEfzmY8A6Vi_QrW1FjKcHMg"
    };
    const JWK: { x: string, y: string, kid: string, kty: string, d: string, crv: string } = {
        ...PUBLIC_KEY,
        d: PRIVATE_KEY,
        kid: CLIENT_ID,
        kty: "EC",
        crv: "P-256",
    };

    // pass the JsonWebKey to the sender
    // will use it for authentication
    const sender: Sender = new Sender(4096, JWK);

    // connect() takes an optional second argument
    // if 'true' passed the connection is secured with TLS encryption
    await sender.connect({port: 9009, host: "127.0.0.1"}, true);

    // send the data over the authenticated and secure connection
    sender.rows(new Row("prices", { "instrument": "EURUSD" }, { "bid": 1.0195, "ask": 1.0221 }));
    await sender.flush();

    // close the connection after all rows ingested
    await sender.close();
    return new Promise(resolve => resolve(0));
}

run().then(value => console.log(value)).catch(err => console.log(err));
```
