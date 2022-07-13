const questdbclient = require('./build/Release/questdbclient');

exports.createSender = function() {
    return new questdbclient.Sender();
}

// a mock sender just to declare interface
class Sender {
    connect(host, port) { return true; }
    table(table) { return this; }
    symbol(colName, symbol) { return this; }
    boolean(colName, value) { return this; }
    timestamp(colName, micros) { return this; }
    int64(colName, value) { return this; }
    float64(colName, value) { return this; }
    string(colName, value) { return this; }
    at(nanos) {}
    atNow() {}
    flush() {}
    close() {}
}
