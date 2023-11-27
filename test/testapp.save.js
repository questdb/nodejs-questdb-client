'use strict';

const { Sender } = require('../index');

const PORT = 9009;
const HOST = '127.0.0.1';

// const USER_NAME = 'testapp';
// const PRIVATE_KEY = '9b9x5WhJywDEuo1KGQWSPNxtX-6X6R2BRCKhYMMY6n8';
// const PUBLIC_KEY = {
//     x: 'aultdA0PjhD_cWViqKKyL5chm6H1n-BiZBo_48T-uqc',
//     y: '__ptaol41JWSpTTL525yVEfzmY8A6Vi_QrW1FjKcHMg'
// };

const USER_NAME = 'user1';
const PRIVATE_KEY = 'zhPiK3BkYMYJvRf5sqyrWNJwjDKHOWHnRbmQggUll6A';
// const PUBLIC_KEY = {
//     x: 'LYMCsNOm_62uKIK-6yFwWd7-cHBZhs_3_rNbZK0PNqc',
//     y: 'zlGEzcfTh0uQRy59-uwnGky8fULZxCGIu1Q-gro9q6I'
// };

// const USER_NAME = 'user2';
// const PRIVATE_KEY = 'hsg6Zm4kSBlIEvKUWT3kif-2y2Wxw-iWaGrJxrPXQhs';
// const PUBLIC_KEY = {
//     x: 'BtUXC_K3oAyGlsuPjTgkiwirMUJhuRQDfcUHeyoxFxU',
//     y: 'R8SOup-rrNofB7wJagy4HrJhTVfrVKmj061lNRk3bF8'
// };

// const JWK = {
//     ...PUBLIC_KEY,
//     kid: USER_NAME,
//     kty: 'EC',
//     d: PRIVATE_KEY,
//     crv: 'P-256'
// };

async function run() {
    const sender = new Sender({bufferSize: 1024, auth: {kid: USER_NAME, d: PRIVATE_KEY}});
    const connected = await sender.connect({host: HOST, port: PORT});
    if (connected) {
        sender.table('testTable')
            .symbol('location', 'emea').symbol('city', 'budapest')
            .stringColumn('hoppa', 'hello')
            .floatColumn('temperature', 14.1).intColumn('intcol', 56)
            .timestampColumn('tscol', Date.now(), 'ms')
            .atNow();

        console.log('sending:\n' + sender.toBuffer().toString());
        await sender.flush();
    }
    await sleep(1000);
    await sender.close();
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

run().catch(console.error);
