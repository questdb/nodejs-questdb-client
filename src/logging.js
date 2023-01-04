'use strict';

const LOG_LEVELS = {
    error: { log: console.error, criticality: 3 },
    warn: { log: console.warn, criticality: 2 },
    info: { log: console.info, criticality: 1 },
    debug: { log: console.debug, criticality: 0 }
};

const DEFAULT_CRITICALITY = LOG_LEVELS.info.criticality;

/**
 * Simple logger to write log messages to the console. <br>
 * Supported logging levels are `error`, `warn`, `info` and `debug`. <br>
 * Throws an error if logging level is invalid.
 *
 * @param {'error'|'warn'|'info'|'debug'} level - The log level of the message.
 * @param {string} message - The log message.
 */
function log(level, message) {
    const logLevel = LOG_LEVELS[level];
    if (!logLevel) {
        throw new Error(`Invalid log level: '${level}'`);
    }
    if (logLevel.criticality >= DEFAULT_CRITICALITY) {
        logLevel.log(message);
    }
}

exports.log = log;
