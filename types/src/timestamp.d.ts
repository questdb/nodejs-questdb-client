/** @classdesc Micros representing a timestamp in microseconds.
 * <p>
 * Timestamp value can be passed to the constructor in the form of a BigInt, string or number. <br>
 * If the parameter is omitted the instance will be initialized with the current time in microseconds.
 * </p>
 * <p>
 * Base class: {@link Timestamp}
 * </p>
 */
export class Micros extends Timestamp {
    /**
     * Creates an instance of Micros.
     *
     * @param {bigint | number | string} [micros=Current time in micros, i.e. Date.now() * 1000] - Timestamp in microseconds.
     */
    constructor(micros?: bigint | number | string);
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
export class Nanos extends Timestamp {
    /**
     * Creates an instance of Nanos.
     *
     * @param {bigint | number | string} [nanos=Current time in nanos, i.e. Date.now() * 1000000] - Timestamp in nanoseconds.
     */
    constructor(nanos?: bigint | number | string);
}
/** @classdesc Abstract class representing a timestamp. <br>
 * Intended to be used as a base class of more specific Timestamp representations.
 * <p>
 * Derived classes: {@link Micros}, {@link Nanos}
 * </p>
 *
 * @abstract
 */
declare class Timestamp {
    /**
     * Creates an instance of Timestamp.
     * @hideconstructor
     *
     * @param {bigint | number | string} timestamp - The timestamp value.
     */
    constructor(timestamp: bigint | number | string);
    /** @private */
    private timestamp;
    /**
     * @return {string} String representation of the timestamp.
     */
    toString(): string;
}
export {};
//# sourceMappingURL=timestamp.d.ts.map