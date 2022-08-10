'use strict';

/**
 * A Node.js client for QuestDB.
 *
 * @module @questdb/nodejs-client
 */

const { Sender } = require('./src/sender');
const { Row } = require("./src/row");
const { Micros, Nanos } = require('./src/timestamp');

module.exports = { Sender, Row, Micros, Nanos };
