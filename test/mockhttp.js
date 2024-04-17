'use strict';

const http = require('http');
const https = require('https');

class MockHttp {
    server;
    mockConfig;
    numOfRequests = 0;

    constructor(mockConfig) {
        if (!mockConfig) {
            throw new Error('Missing mock config');
        }
        this.mockConfig = mockConfig;
    }

    async start(listenPort, secure = false, options = undefined) {
        const createServer = secure ? https.createServer : http.createServer;
        this.server = createServer(options, (req, res) => {
            const authFailed = checkAuthHeader(this.mockConfig, req);

            const body = [];
            req.on('data', chunk => {
                body.push(chunk);
            });

            req.on('end', async () => {
                console.info(`Received data: ${Buffer.concat(body)}`);
                this.numOfRequests++;

                if (this.mockConfig.responseDelay) {
                    await sleep(this.mockConfig.responseDelay);
                }

                const responseCode = authFailed ? 401 : (
                    this.mockConfig.responseCodes ? this.mockConfig.responseCodes.pop() : 204
                );
                res.writeHead(responseCode);
                res.end();
            });
        })

        this.server.listen(listenPort, () => {
            console.info(`Server is running on port ${listenPort}`);
        });
    }

    async stop() {
        if (this.server) {
            this.server.close();
        }
    }
}

function checkAuthHeader(mockConfig, req) {
    let authFailed = false;
    const header = (req.headers.authorization || '').split(/\s+/);
    switch (header[0]) {
        case 'Basic':
            const auth = Buffer.from(header[1], 'base64').toString().split(/:/);
            if (mockConfig.username !== auth[0] || mockConfig.password !== auth[1]) {
                authFailed = true;
            }
            break;
        case 'Bearer':
            if (mockConfig.token !== header[1]) {
                authFailed = true;
            }
            break;
        default:
            if (mockConfig.username || mockConfig.password || mockConfig.token) {
                authFailed = true;
            }
    }
    return authFailed;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

exports.MockHttp = MockHttp;
