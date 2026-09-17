// Log level configuration with console methods and criticality levels. <br>
// Higher criticality values indicate more important messages.
const LOG_LEVELS = {
  error: { log: console.error, criticality: 3 },
  warn: { log: console.warn, criticality: 2 },
  info: { log: console.info, criticality: 1 },
  debug: { log: console.debug, criticality: 0 },
};

// Default logging criticality level. Messages with criticality below this level are ignored.
const DEFAULT_CRITICALITY = LOG_LEVELS.info.criticality;

/**
 * Logger function type definition.
 *
 * @param {'error'|'warn'|'info'|'debug'} level - The log level for the message
 * @param {string | Error} message - The message to log, either a string or Error object
 */
type Logger = (
  level: "error" | "warn" | "info" | "debug",
  message: string | Error,
) => void;

/**
 * Simple logger to write log messages to the console. <br>
 * Supported logging levels are `error`, `warn`, `info` and `debug`. <br>
 * Throws an error if logging level is invalid.
 *
 * @param {'error'|'warn'|'info'|'debug'} level - The log level for the message
 * @param {string | Error} message - The message to log, either a string or Error object
 */
function log(
  level: "error" | "warn" | "info" | "debug",
  message: string | Error,
): void {
  const logLevel = LOG_LEVELS[level];
  if (!logLevel) {
    throw new Error(`Invalid log level: '${level}'`);
  }
  if (logLevel.criticality >= DEFAULT_CRITICALITY) {
    logLevel.log(message);
  }
}

export { log, Logger };
