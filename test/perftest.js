'use strict';

const { Sender } = require("../index");
const { readFileSync } = require('fs');
const http = require("http");

const HTTP_OK = 200;

const PORT = 9009;
const HOST = "127.0.0.1";

const PRIVATE_KEY = "9b9x5WhJywDEuo1KGQWSPNxtX-6X6R2BRCKhYMMY6n8";
const PUBLIC_KEY = {
    x: "aultdA0PjhD_cWViqKKyL5chm6H1n-BiZBo_48T-uqc",
    y: "__ptaol41JWSpTTL525yVEfzmY8A6Vi_QrW1FjKcHMg"
};
const JWK = {
    ...PUBLIC_KEY,
    kid: "testapp",
    kty: "EC",
    d: PRIVATE_KEY,
    crv: "P-256",
};

const senderTLS = {
    host: HOST,
    port: PORT,
    ca: readFileSync('certs/ca/ca.crt') // necessary only if the server uses self-signed certificate
};

async function run() {
    const tableName = "test";
    await query(`drop table "${tableName}"`);

    const sender = new Sender({bufferSize: 131072, jwk: JWK});
    await sender.connect(senderTLS);
    const numOfRows = 1000000;
    for (let i = 0; i < numOfRows; i++) {
        sender.table(tableName)
            .symbol("location", `emea${i}`).symbol("city", `budapest${i}`)
            .stringColumn("hoppa", `hello${i}`).stringColumn("hippi", `hel${i}`).stringColumn("hippo", `haho${i}`)
            // .symbol("location", "emea").symbol("city", "budapest")
            // .stringColumn("hoppa", "hello").stringColumn("hippi", "hel").stringColumn("hippo", "haho")
            .floatColumn("temperature", 12.1).intColumn("intcol", i)
            .atNow();
        if (i % 1000 === 0) {
            await sender.flush();
        }
    }
    await sender.flush();
    await sender.close();
    console.info(`mem usage: ${getMemory()}`);

    await waitForData(tableName, numOfRows);

    const selectMin = await query(`select * from "${tableName}" where intcol=0`);
    const dateMin = new Date(selectMin.dataset[0][7]);
    const selectMax = await query(`select * from "${tableName}" where intcol=${numOfRows - 1}`);
    const dateMax = new Date(selectMax.dataset[0][7]);
    const elapsed = (dateMax.getTime() - dateMin.getTime()) / 1000;
    console.info(`took: ${elapsed}, rate: ${numOfRows / elapsed} rows/s`);

    return 0;
}

async function query(query) {
    const options = {
        hostname: "127.0.0.1",
        port: 9000,
        path: `/exec?query=${encodeURIComponent(query)}`,
        method: 'GET',
    };

    return new Promise((resolve, reject) => {
        const req = http.request(options, response => {
            if (response.statusCode === HTTP_OK) {
                response.on('data', data => {
                    resolve(JSON.parse(data.toString()));
                });
            } else {
                reject(new Error(`HTTP request failed, statusCode=${response.statusCode}, query=${query}`));
            }
        });

        req.on('error', error => {
            reject(error);
        });

        req.end();
    });
}

async function waitForData(table, expectedRowCount, timeout = 90000) {
    const interval = 500;
    const num = timeout / interval;
    let selectResult;
    for (let i = 0; i < num; i++) {
        selectResult = await query(`select count(*) from "${table}"`);
        if (selectResult && selectResult.dataset[0][0] === expectedRowCount) {
            return selectResult;
        }
        await sleep(interval);
    }
    throw new Error(`Timed out while waiting for ${expectedRowCount} rows, table='${table}'`);
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getMemory() {
    return Object.entries(process.memoryUsage()).reduce((carry, [key, value]) => {
        return `${carry}${key}:${Math.round(value / 1024 / 1024 * 100) / 100}MB;`;
    }, "");
}

run().then(value => console.log(value))
    .catch(err => console.log(err));
