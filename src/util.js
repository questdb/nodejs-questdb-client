const QuestDBMaxFileNameLength = 127;

function validateTableName(name) {
    const len = name.length;
    if (len > QuestDBMaxFileNameLength) {
        throw "Table name is too long, max length is " + QuestDBMaxFileNameLength;
    }
    if (len === 0) {
        throw "Empty string is not allowed as table name";
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
                    throw "Table name cannot start or end with a dot and only a single dot allowed";
                break;
            case '?':
            case ',':
            case '\'':
            case '\"':
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
                throw "Invalid character in table name: " + ch;
        }
    }
}

function validateColumnName(name) {
    const len = name.length;
    if (len > QuestDBMaxFileNameLength) {
        throw "Column name is too long, max length is " + QuestDBMaxFileNameLength;
    }
    if (len === 0) {
        throw "Empty string is not allowed as column name";
    }
    for (let ch of name) {
        switch (ch) {
            case '?':
            case '.':
            case ',':
            case '\'':
            case '\"':
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
                throw "Invalid character in column name: " + ch;
        }
    }
}

exports.validateTableName = validateTableName;
exports.validateColumnName = validateColumnName;
