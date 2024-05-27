# QuestDB Node.js Client

Welcome to the QuestDB Node.js client documentation. This guide will help you integrate QuestDB into your Node.js applications.

## Requirements
Ensure you have Node.js v16 or newer installed. You can download it from [here](https://nodejs.org/).

## Installation
Install the QuestDB Node.js client via npm:
```sh
npm install @questdb/nodejs-client
```

# Basic API Usage
The following example demonstrates how to use the QuestDB Node.js client to send data to QuestDB.

## Step 1: Import the Sender

```javascript
const { Sender } = require('@questdb/nodejs-client');
```
## Step 2: Configure the Sender
Create a sender instance configured to connect to your QuestDB instance:
``` javascript
const sender = Sender.fromConfig('http::addr=localhost:9000');
```
## Step 3: Add Data to the Buffer
Add rows to the sender's buffer:
``` javascript
await sender.table('prices')
    .symbol('instrument', 'EURUSD')
    .floatColumn('bid', 1.0195)
    .floatColumn('ask', 1.0221)
    .at(Date.now(), 'ms');
```
## Step 4: Flush the Buffer
Send the data to QuestDB by flushing the buffer:
``` javascript
await sender.flush();
```
## Step 5: Close the Connection
After all data is ingested, close the sender to free up resources:
``` javascript
await sender.close();
```
## Complete Example
Here’s the complete example wrapped in an async function:
``` javascript
const { Sender } = require('@questdb/nodejs-client');

async function run() {
    try {
        const sender = Sender.fromConfig('http::addr=localhost:9000');
        await sender.table('prices').symbol('instrument', 'EURUSD')
            .floatColumn('bid', 1.0195).floatColumn('ask', 1.0221)
            .at(Date.now(), 'ms');
        await sender.flush();
        await sender.close();
        console.log('Data successfully sent to QuestDB');
    } catch (err) {
        console.error('Error:', err);
    }
}

run();
```
# Advanced Usage
## Authentication and Secure Connection
To connect to QuestDB over HTTPS with authentication:
``` javascript
const sender = Sender.fromConfig('https::addr=localhost:9000;username=user1;password=pwd');
```
## TypeScript Example
For TypeScript users, here's an example
``` typescript
import { Sender } from '@questdb/nodejs-client';

async function run(): Promise<void> {
    const sender: Sender = Sender.fromConfig('https::addr=localhost:9000;token=Xyvd3er6GF87ysaHk');
    await sender.table('prices').symbol('instrument', 'EURUSD')
        .floatColumn('bid', 1.0197).floatColumn('ask', 1.0224)
        .at(Date.now(), 'ms');
    await sender.flush();
    await sender.close();
}

run().catch(console.error);
```
## Worker Threads Example
For more advanced usage with worker threads:
``` javascript
const { Sender } = require('@questdb/nodejs-client');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (isMainThread) {
    new Worker(__filename);
} else {
    async function run() {
        const sender = Sender.fromConfig('http::addr=localhost:9000');
        await sender.table('prices')
            .symbol('instrument', 'EURUSD')
            .floatColumn('bid', workerData.bid)
            .floatColumn('ask', workerData.ask)
            .at(Date.now(), 'ms');
        await sender.flush();
        await sender.close();
        parentPort.postMessage('done');
    }
    run().catch(console.error);
}
```
# Troubleshooting
If you encounter issues, ensure your QuestDB instance is running and accessible. Check network configurations and ensure the correct ports are open.

## Common Issues
**Connection Errors**: Verify the host and port in the connection string. <br>
**Authentication Failures**: Ensure correct username and password, if applicable. <br>
**Data Not Appearing**: Check the table name and column names in your queries.

## Logs and Debugging
Enable detailed logging in your application to troubleshoot issues more effectively. You can also check QuestDB server logs for more information on errors.

## Conclusion
By following these steps, you can effectively use the QuestDB Node.js client in your applications. We hope this guide has been helpful. If you have any questions or need further assistance, don't hesitate to reach out via the provided resources.
