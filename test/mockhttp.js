'use strict';

const http = require('http');
const https = require('https');

class MockHttp {
    constructor(mockConfig) {
        if (!mockConfig) {
            throw new Error('Missing mock config');
        }
        this.mockConfig = mockConfig;
    }

    async start(listenPort, tlsOptions = undefined) {
        const createServer = tlsOptions ? https.createServer : http.createServer;
        this.server = createServer((req, res) => {
            const body = [];
            req.on('data', chunk => {
                body.push(chunk);
            });
            req.on('end', () => {
                console.info(`Received data: ${Buffer.concat(body)}`);
                const responseCode = this.mockConfig.responseCodes ? this.mockConfig.responseCodes.pop() : 204;
                res.writeHead(responseCode);
                res.end();
            });
        })
        this.server.listen(listenPort, () => {
            console.info(`Server is running on port ${listenPort}`);
        });
    }

    async stop() {
        this.server.close();
    }
}

exports.MockHttp = MockHttp;
