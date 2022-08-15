'use strict';

const QuestDBMaxFileNameLength = 127;

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
    for (let i = 0; i < len; i++) {
        let ch = name[i];
        switch (ch) {
            case '.':
                if (i === 0 || i === len - 1 || name[i - 1] === '.')
                    // single dot is allowed in the middle only
                    // starting with a dot hides directory in Linux
                    // ending with a dot can be trimmed by some Windows versions / file systems
                    // double or triple dot looks suspicious
                    // single dot allowed as compatibility,
                    // when someone uploads 'file_name.csv' the file name used as the table name
                    throw new Error("Table name cannot start or end with a dot and only a single dot allowed");
                break;
            case '?':
            case ',':
            case '\'':
            case '"':
            case '\\':
            case '/':
            case ':':
            case ')':
            case '(':
            case '+':
            case '*':
            case '%':
            case '~':
            case '\u0000':
            case '\u0001':
            case '\u0002':
            case '\u0003':
            case '\u0004':
            case '\u0005':
            case '\u0006':
            case '\u0007':
            case '\u0008':
            case '\u0009': // control characters, except \n.
            case '\u000B': // new line allowed for compatibility, there are tests to make sure it works
            case '\u000c':
            case '\r':
            case '\n':
            case '\u000e':
            case '\u000f':
            case '\u007f':
            case '\ufeff': // UTF-8 BOM (Byte Order Mark) can appear at the beginning of a character stream
                throw new Error(`Invalid character in table name: ${ch}`);
        }
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
    for (const ch of name) {
        switch (ch) {
            case '?':
            case '.':
            case ',':
            case '\'':
            case '"':
            case '\\':
            case '/':
            case ':':
            case ')':
            case '(':
            case '+':
            case '-':
            case '*':
            case '%':
            case '~':
            case '\u0000':
            case '\u0001':
            case '\u0002':
            case '\u0003':
            case '\u0004':
            case '\u0005':
            case '\u0006':
            case '\u0007':
            case '\u0008':
            case '\u0009': // control characters, except \n
            case '\u000B':
            case '\u000c':
            case '\r':
            case '\n':
            case '\u000e':
            case '\u000f':
            case '\u007f':
            case '\ufeff': // UTF-8 BOM (Byte Order Mark) can appear at the beginning of a character stream
                throw new Error(`Invalid character in column name: ${ch}`);
        }
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
    for (let i = 0; i < len; i++) {
        let ch = timestamp[i];
        if (ch < '0' || ch > '9') {
            throw new Error(`Invalid character in designated timestamp: ${ch}`);
        }
    }
}

exports.validateTableName = validateTableName;
exports.validateColumnName = validateColumnName;
exports.validateDesignatedTimestamp = validateDesignatedTimestamp;
