/** @classdesc Abstract class representing a timestamp. <br>
 * Intended to be used as a base class of more specific Timestamp representations.
 * <p>
 * Derived classes: {@link Micros}, {@link Nanos}
 * </p>
 *
 * @abstract
 */
class Timestamp {

    /**
     * Creates an instance of Timestamp.
     * @hideconstructor
     *
     * @param {bigint | number | string} timestamp - The timestamp value.
     */
    constructor(timestamp) {
        switch (typeof timestamp) {
            case "bigint":
                /** @private */
                this.timestamp = timestamp;
                break;
            case "string":
            case "number":
                this.timestamp = BigInt(timestamp);
                break;
            default:
                throw `BigInt, string or number expected, received ${typeof timestamp}`;
        }
    }

    /**
     * @return {string} String representation of the timestamp.
     */
    toString() {
        return this.timestamp.toString();
    }
}

/** @classdesc Micros representing a timestamp in microseconds.
 * <p>
 * Timestamp value can be passed to the constructor in the form of a BigInt, string or number. <br>
 * If the parameter is omitted the instance will be initialized with the current time in microseconds.
 * </p>
 * <p>
 * Base class: {@link Timestamp}
 * </p>
 */
class Micros extends Timestamp {

    /**
     * Creates an instance of Micros.
     *
     * @param {bigint | number | string} [micros=Current time in micros, i.e. Date.now() * 1000] - Timestamp in microseconds.
     */
    constructor(micros = BigInt(Date.now()) * 1000n) {
        super(micros);
    }
}

/** @classdesc Nanos representing a timestamp in nanoseconds.
 * <p>
 * Timestamp value can be passed to the constructor in the form of a BigInt, string or number. <br>
 * If the parameter is omitted the instance will be initialized with the current time in nanoseconds.
 * </p>
 * <p>
 * Base class: {@link Timestamp}
 * </p>
 */
class Nanos extends Timestamp {

    /**
     * Creates an instance of Nanos.
     *
     * @param {bigint | number | string} [nanos=Current time in nanos, i.e. Date.now() * 1000000] - Timestamp in nanoseconds.
     */
    constructor(nanos = BigInt(Date.now()) * 1000000n) {
        super(nanos);
    }
}

exports.Micros = Micros;
exports.Nanos = Nanos;
