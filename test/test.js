const questdb = require('../index');

const sender = questdb.createSender();
const connected = sender.endpoint('localhost', 9009)
//    .enableTLS()
//    .withAuth('', '', '', '')
    .connect();

if (connected) {
    for (let i = 0; i < 3; i++) {
        sender.table('cars')
            .symbol('id', 'testID' + i)
            .boolean('booked', i % 2 === 0)
            .timestamp('when', 1657674694000000)
            .int64('passengers', i)
            .float64('x', 3.5 + i / 10)
            .string('driver', 'driver' + i)
            .at(1657674694000000000n + BigInt(i) * 1000000000n);
        sender.flush();
    }
}
sender.close();
