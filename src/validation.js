'use strict';

const QuestDBMaxFileNameLength = 127;

// eslint-disable-next-line no-control-regex
const INVALID_COLUMN_REGEX = /[?.,'"\\/:()+\-*%~\r\n\u{0000}\u{0001}\u{0002}\u{0003}\u{0004}\u{0005}\u{0006}\u{0007}\u{0008}\u{0009}\u{000B}\u{000C}\u{000E}\u{000F}\u{007F}\u{FEFF}]/u;
// eslint-disable-next-line no-control-regex
const INVALID_TABLE_REGEX = /[?,'"\\/:()+*%~\r\n\u{0000}\u{0001}\u{0002}\u{0003}\u{0004}\u{0005}\u{0006}\u{0007}\u{0008}\u{0009}\u{000B}\u{000C}\u{000E}\u{000F}\u{007F}\u{FEFF}]/u;
const INVALID_TABLE_START_DOT_REGEX = /^\./;
const INVALID_TABLE_END_DOT_REGEX = /\.$/;
const INVALID_TABLE_MORE_DOTS_REGEX = /\.\./;
const INVALID_DESIGNATED_REGEX = /\D/;

/**
 * Validates a table name. <br>
 * Throws an error if table name is invalid.
 *
 * @param {string} name - The table name to validate.
 */
function validateTableName(name) {
    const len = name.length;
    if (len > QuestDBMaxFileNameLength) {
        throw new Error(`Table name is too long, max length is ${QuestDBMaxFileNameLength}`);
    }
    if (len === 0) {
        throw new Error("Empty string is not allowed as table name");
    }
    if (INVALID_TABLE_REGEX.test(name)) {
        throw new Error(`Invalid character in table name: ${name}`);
    }
    if (INVALID_TABLE_START_DOT_REGEX.test(name)) {
        throw new Error(`Table name cannot start with a dot: ${name}`);
    }
    if (INVALID_TABLE_END_DOT_REGEX.test(name)) {
        throw new Error(`Table name cannot end with a dot: ${name}`);
    }
    if (INVALID_TABLE_MORE_DOTS_REGEX.test(name)) {
        throw new Error(`Only single dots allowed in table name: ${name}`);
    }
}

/**
 * Validates a column name. <br>
 * Throws an error if column name is invalid.
 *
 * @param {string} name - The column name to validate.
 */
function validateColumnName(name) {
    const len = name.length;
    if (len > QuestDBMaxFileNameLength) {
        throw new Error(`Column name is too long, max length is ${QuestDBMaxFileNameLength}`);
    }
    if (len === 0) {
        throw new Error("Empty string is not allowed as column name");
    }
    if (INVALID_COLUMN_REGEX.test(name)) {
        throw new Error(`Invalid character in column name: ${name}`);
    }
}

/**
 * Validates a designated timestamp. The value must contain only digits.<br>
 * Throws an error if the value is invalid.
 *
 * @param {string} timestamp - The table name to validate.
 */
function validateDesignatedTimestamp(timestamp) {
    const len = timestamp.length;
    if (len === 0) {
        throw new Error("Empty string is not allowed as designated timestamp");
    }
    if (INVALID_DESIGNATED_REGEX.test(timestamp)) {
        throw new Error(`Invalid character in designated timestamp: ${timestamp}`);
    }
}

exports.validateTableName = validateTableName;
exports.validateColumnName = validateColumnName;
exports.validateDesignatedTimestamp = validateDesignatedTimestamp;
