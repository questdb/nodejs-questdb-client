/// <reference types="node" />
export class Builder {
    constructor(bufferSize: any);
    resize(bufferSize: any): void;
    bufferSize: any;
    buffer: Buffer;
    reset(): Builder;
    position: number;
    addTable(table: any): Builder;
    hasTable: boolean;
    addSymbol(name: any, value: any): Builder;
    hasSymbols: boolean;
    addString(name: any, value: any): Builder;
    addBoolean(name: any, value: any): Builder;
    addFloat(name: any, value: any): Builder;
    addInteger(name: any, value: any): Builder;
    addTimestamp(name: any, value: any): Builder;
    at(timestamp: any): void;
    atNow(): void;
    addRows(rows: any): void;
    addRow(row: any): void;
    toBuffer(): Buffer;
}
import { Buffer } from "buffer";
//# sourceMappingURL=builder.d.ts.map