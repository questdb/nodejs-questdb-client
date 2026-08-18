import { describe, expect, it } from "vitest";
import {
  decodeQwpEgressMessage,
  decodeQwpContentEncoding,
  decodeQwpFrame,
  decodeQwpIngressResponse,
  decodeQwpIngressServerInfo,
  decodeQwpIngressSymbolDictionaryDelta,
  decodeQwpVarint,
  addQwpDurableAckWebSocketProtocol,
  encodeQwpCancel,
  encodeQwpAcceptEncoding,
  encodeQwpCredit,
  encodeQwpDurableAckPollFrame,
  encodeQwpFrame,
  encodeQwpGorilla,
  encodeQwpIngressFrame,
  encodeQwpQueryRequest,
  encodeQwpVarint,
  QWP_COLUMN_TYPE,
  QWP_COMPRESSION_CODEC,
  QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL,
  QWP_EGRESS_CAPABILITY,
  QWP_EGRESS_MESSAGE,
  QWP_FLAG_GORILLA,
  QWP_FLAG_DURABLE_ACK_POLL,
  QWP_HEADER_SIZE,
  QWP_MAGIC,
  QWP_STATUS,
  QwpByteReader,
  QwpByteWriter,
  QwpSymbolDictionary,
  QwpTableBuffer,
  qwpGorillaSize,
  qwpVarintSize,
  readQwpVarint,
  writeQwpVarint,
} from "../../src/qwp";

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function writeU16String(writer: QwpByteWriter, value: string): void {
  const bytes = new TextEncoder().encode(value);
  writer.writeUint16(bytes.length).writeBytes(bytes);
}

describe("QWP browser-safe byte core", () => {
  it("round-trips little-endian scalars without Buffer", () => {
    const writer = new QwpByteWriter(1);
    writer
      .writeUint16(0x1234)
      .writeInt32(-7)
      .writeBigUint64(0xffffffffffffffffn)
      .writeFloat64(1.5);

    const reader = new QwpByteReader(writer.toUint8Array());
    expect(reader.readUint16()).toBe(0x1234);
    expect(reader.readInt32()).toBe(-7);
    expect(reader.readBigUint64()).toBe(0xffffffffffffffffn);
    expect(reader.readFloat64()).toBe(1.5);
    reader.expectEnd();
  });

  it("round-trips uint64 LEB128 values and rejects overflow", () => {
    for (const value of [0n, 127n, 128n, 300n, 1_000_000n, 2n ** 63n]) {
      const encoded = encodeQwpVarint(value);
      expect(encoded.length).toBe(qwpVarintSize(value));
      expect(decodeQwpVarint(encoded)).toEqual({
        value,
        offset: encoded.length,
      });
    }
    expect(() =>
      decodeQwpVarint(Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80])),
    ).toThrow(/truncated/i);
    expect(() =>
      decodeQwpVarint(
        Uint8Array.from([
          0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02,
        ]),
      ),
    ).toThrow(/uint64/i);
  });
});

describe("QWP browser durable-ACK negotiation", () => {
  it("adds the capability token without mutating or duplicating protocols", () => {
    expect(addQwpDurableAckWebSocketProtocol(undefined)).toBe(
      QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL,
    );
    expect(addQwpDurableAckWebSocketProtocol("application.v1")).toEqual([
      "application.v1",
      QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL,
    ]);
    const protocols = ["application.v1"];
    expect(addQwpDurableAckWebSocketProtocol(protocols)).toEqual([
      "application.v1",
      QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL,
    ]);
    expect(protocols).toEqual(["application.v1"]);
    expect(
      addQwpDurableAckWebSocketProtocol([
        "application.v1",
        QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL,
      ]),
    ).toEqual(["application.v1", QWP_DURABLE_ACK_WEBSOCKET_PROTOCOL]);
  });

  it("encodes a side-effect-free table-less durable progress poll", () => {
    expect(decodeQwpFrame(encodeQwpDurableAckPollFrame())).toMatchObject({
      flags: QWP_FLAG_DURABLE_ACK_POLL,
      tableCount: 0,
      payloadLength: 0,
      payload: new Uint8Array(),
    });
  });

  it("decodes the browser ingress SERVER_INFO batch cap", () => {
    const payload = new QwpByteWriter()
      .writeUint8(QWP_STATUS.SERVER_INFO)
      .writeUint32(1_048_576)
      .toUint8Array();
    expect(decodeQwpIngressServerInfo(payload)).toBe(1_048_576);
    expect(
      decodeQwpIngressServerInfo(Uint8Array.from([QWP_STATUS.OK])),
    ).toBeUndefined();
  });
});

describe("QWP egress compression negotiation", () => {
  it("builds raw and Zstd upgrade preferences", () => {
    expect(encodeQwpAcceptEncoding("raw", 1)).toBeUndefined();
    expect(encodeQwpAcceptEncoding("zstd", 1)).toBe("zstd;level=1,raw");
    expect(encodeQwpAcceptEncoding("auto", 22)).toBe("zstd;level=22,raw");
  });

  it.each([0, 23, 1.5, Number.NaN])(
    "rejects invalid Zstd tuning level %s",
    (level) => {
      expect(() => encodeQwpAcceptEncoding("zstd", level)).toThrow(
        /between 1 and 22/,
      );
    },
  );

  it("parses the effective server codec and level", () => {
    expect(decodeQwpContentEncoding(undefined)).toEqual({
      codec: "raw",
      level: 0,
    });
    expect(decodeQwpContentEncoding(" identity ")).toEqual({
      codec: "raw",
      level: 0,
    });
    expect(decodeQwpContentEncoding("ZSTD; level = 7")).toEqual({
      codec: "zstd",
      level: 7,
    });
    expect(decodeQwpContentEncoding("zstd;level=bogus")).toEqual({
      codec: "unknown",
      level: 0,
      contentEncoding: "zstd;level=bogus",
    });
    expect(decodeQwpContentEncoding("br")).toEqual({
      codec: "unknown",
      level: 0,
      contentEncoding: "br",
    });
  });
});

describe("QWP frame envelope", () => {
  it("writes and validates the common 12-byte header", () => {
    const encoded = encodeQwpFrame(Uint8Array.from([1, 2, 3]), 4, 2);
    const view = dataView(encoded);
    expect(view.getUint32(0, true)).toBe(QWP_MAGIC);
    expect(encoded.length).toBe(QWP_HEADER_SIZE + 3);
    expect(decodeQwpFrame(encoded)).toMatchObject({
      version: 1,
      flags: 4,
      tableCount: 2,
      payloadLength: 3,
    });
  });

  it("rejects bad magic and payload length mismatches", () => {
    const badMagic = encodeQwpFrame(new Uint8Array());
    badMagic[0] = 0;
    expect(() => decodeQwpFrame(badMagic)).toThrow(/magic/i);

    const badLength = encodeQwpFrame(Uint8Array.of(1));
    dataView(badLength).setUint32(8, 2, true);
    expect(() => decodeQwpFrame(badLength)).toThrow(/length mismatch/i);
  });
});

describe("QWP ingress codec", () => {
  it("slices compacted table rows without losing null positions", () => {
    const table = new QwpTableBuffer("events");
    table.getOrCreateColumn("value", QWP_COLUMN_TYPE.LONG)!.values.push(10n);
    table.nextRow();
    table.nextRow();
    table.getOrCreateColumn("value", QWP_COLUMN_TYPE.LONG)!.values.push(30n);
    table.nextRow();

    const sliced = table.sliceRows(1, 3);
    expect(sliced.rowCount).toBe(2);
    expect(sliced.columns[0]).toMatchObject({
      name: "value",
      values: [30n],
      nulls: [true, false],
      size: 2,
    });
    expect(() => encodeQwpIngressFrame([sliced])).not.toThrow();
    expect(() => table.sliceRows(-1, 2)).toThrow(/invalid.*row range/i);
  });

  it("encodes a compacted LONG column with an LSB-first null bitmap", () => {
    const table = new QwpTableBuffer("t");
    table.getOrCreateColumn("a", QWP_COLUMN_TYPE.LONG)!.values.push(1n);
    table.nextRow();
    table.nextRow();

    const frame = decodeQwpFrame(
      encodeQwpIngressFrame([table], { gorilla: false }),
    );
    const reader = new QwpByteReader(frame.payload);
    expect(readQwpVarint(reader)).toBe(1n);
    expect(reader.readUtf8(1)).toBe("t");
    expect(readQwpVarint(reader)).toBe(2n);
    expect(readQwpVarint(reader)).toBe(1n);
    expect(readQwpVarint(reader)).toBe(1n);
    expect(reader.readUtf8(1)).toBe("a");
    expect(reader.readUint8()).toBe(QWP_COLUMN_TYPE.LONG);
    expect(reader.readUint8()).toBe(1);
    expect(reader.readUint8()).toBe(0b00000010);
    expect(reader.readBigInt64()).toBe(1n);
    reader.expectEnd();
  });

  it("sets the Gorilla flag and emits the donor-compatible timestamp prefix", () => {
    const table = new QwpTableBuffer("events");
    const timestamps = [1000n, 2000n, 3000n, 4000n];
    for (const timestamp of timestamps) {
      table
        .getOrCreateColumn("ts", QWP_COLUMN_TYPE.TIMESTAMP)!
        .values.push(timestamp);
      table.nextRow();
    }
    const encoded = encodeQwpIngressFrame([table]);
    expect(encoded[5] & QWP_FLAG_GORILLA).toBe(QWP_FLAG_GORILLA);
    expect(qwpGorillaSize(timestamps)).toBe(17);
    const gorilla = encodeQwpGorilla(timestamps);
    expect(dataView(gorilla).getBigInt64(0, true)).toBe(1000n);
    expect(dataView(gorilla).getBigInt64(8, true)).toBe(2000n);
    expect(gorilla[16]).toBe(0);
  });

  it("assigns string symbols stable global IDs and emits only new deltas", () => {
    const dictionary = new QwpSymbolDictionary();
    const first = new QwpTableBuffer("trades");
    for (const symbol of ["ETH-USD", "BTC-USD"]) {
      first
        .getOrCreateColumn("symbol", QWP_COLUMN_TYPE.SYMBOL)!
        .values.push(symbol);
      first.nextRow();
    }
    const firstFrame = encodeQwpIngressFrame([first], {
      dictionary,
      confirmedMaxSymbolId: -1,
    });
    expect(decodeQwpIngressSymbolDictionaryDelta(firstFrame)).toEqual({
      startId: 0,
      entries: ["ETH-USD", "BTC-USD"],
    });

    const second = new QwpTableBuffer("trades");
    for (const symbol of ["BTC-USD", "SOL-USD"]) {
      second
        .getOrCreateColumn("symbol", QWP_COLUMN_TYPE.SYMBOL)!
        .values.push(symbol);
      second.nextRow();
    }
    const secondFrame = encodeQwpIngressFrame([second], {
      dictionary,
      confirmedMaxSymbolId: 1,
    });
    expect(decodeQwpIngressSymbolDictionaryDelta(secondFrame)).toEqual({
      startId: 2,
      entries: ["SOL-USD"],
    });
    expect(dictionary.entriesFrom(0)).toEqual([
      "ETH-USD",
      "BTC-USD",
      "SOL-USD",
    ]);
  });

  it("rolls back tentative symbols when frame encoding fails", () => {
    const dictionary = new QwpSymbolDictionary();
    const table = new QwpTableBuffer("broken");
    table
      .getOrCreateColumn("symbol", QWP_COLUMN_TYPE.SYMBOL)!
      .values.push("ETH-USD");
    table
      .getOrCreateColumn("payload", QWP_COLUMN_TYPE.BINARY)!
      .values.push("not binary");
    table.nextRow();

    expect(() => encodeQwpIngressFrame([table], { dictionary })).toThrow(
      /Uint8Array/,
    );
    expect(dictionary.size).toBe(0);
  });

  it("refuses to encode incomplete column state", () => {
    const table = new QwpTableBuffer("broken");
    table.getOrCreateColumn("value", QWP_COLUMN_TYPE.LONG);
    table.nextRow();
    expect(() => encodeQwpIngressFrame([table])).toThrow(/non-null row/i);

    const unfinished = new QwpTableBuffer("unfinished");
    unfinished
      .getOrCreateColumn("value", QWP_COLUMN_TYPE.LONG)!
      .values.push(1n);
    expect(() => encodeQwpIngressFrame([unfinished])).toThrow(
      /unfinished row/i,
    );
  });

  it("decodes ACK, durable ACK, and NACK payloads", () => {
    const ack = new QwpByteWriter();
    ack.writeUint8(QWP_STATUS.OK).writeBigUint64(7n).writeUint16(1);
    writeU16String(ack, "trades");
    ack.writeBigInt64(42n);
    expect(decodeQwpIngressResponse(ack.toUint8Array())).toEqual({
      status: QWP_STATUS.OK,
      sequence: 7n,
      tables: [{ name: "trades", sequenceTransaction: 42n }],
    });

    const durable = new QwpByteWriter();
    durable.writeUint8(QWP_STATUS.DURABLE_ACK).writeUint16(0);
    expect(decodeQwpIngressResponse(durable.toUint8Array())).toEqual({
      status: QWP_STATUS.DURABLE_ACK,
      sequence: null,
      tables: [],
    });

    const nack = new QwpByteWriter();
    nack.writeUint8(QWP_STATUS.WRITE_ERROR).writeBigUint64(8n);
    writeU16String(nack, "boom");
    expect(decodeQwpIngressResponse(nack.toUint8Array())).toMatchObject({
      status: QWP_STATUS.WRITE_ERROR,
      sequence: 8n,
      errorMessage: "boom",
    });
  });
});

describe("QWP egress codec", () => {
  it("encodes QUERY_REQUEST, CANCEL, and CREDIT payloads", () => {
    const query = encodeQwpQueryRequest({
      requestId: 9n,
      sql: "select 42",
      initialCredit: 1024,
      queryFlags: 1,
    });
    const reader = new QwpByteReader(query);
    expect(reader.readUint8()).toBe(QWP_EGRESS_MESSAGE.QUERY_REQUEST);
    expect(reader.readBigUint64()).toBe(9n);
    const sqlLength = Number(readQwpVarint(reader));
    expect(reader.readUtf8(sqlLength)).toBe("select 42");
    expect(readQwpVarint(reader)).toBe(1024n);
    expect(readQwpVarint(reader)).toBe(0n);
    expect(readQwpVarint(reader)).toBe(1n);
    reader.expectEnd();

    expect(encodeQwpCancel(9n)).toEqual(
      Uint8Array.from([QWP_EGRESS_MESSAGE.CANCEL, 9, 0, 0, 0, 0, 0, 0, 0]),
    );
    const credit = new QwpByteReader(encodeQwpCredit(9n, 300));
    expect(credit.readUint8()).toBe(QWP_EGRESS_MESSAGE.CREDIT);
    expect(credit.readBigUint64()).toBe(9n);
    expect(readQwpVarint(credit)).toBe(300n);
  });

  it("decodes SERVER_INFO including the optional zone", () => {
    const payload = new QwpByteWriter();
    payload
      .writeUint8(QWP_EGRESS_MESSAGE.SERVER_INFO)
      .writeUint8(1)
      .writeBigUint64(3n)
      .writeUint32(
        QWP_EGRESS_CAPABILITY.ZONE | QWP_EGRESS_CAPABILITY.COMPRESSION,
      )
      .writeBigInt64(123n);
    writeU16String(payload, "cluster-a");
    writeU16String(payload, "node-1");
    writeU16String(payload, "eu-west-1a");
    payload.writeUint8(QWP_COMPRESSION_CODEC.ZSTD).writeUint8(3);

    expect(
      decodeQwpEgressMessage(encodeQwpFrame(payload.toUint8Array())),
    ).toMatchObject({
      kind: "server-info",
      role: 1,
      epoch: 3n,
      clusterId: "cluster-a",
      nodeId: "node-1",
      zoneId: "eu-west-1a",
      compressionCodec: QWP_COMPRESSION_CODEC.ZSTD,
      compressionLevel: 3,
    });
  });

  it("decodes RESULT_END and rejects truncated control frames", () => {
    const payload = new QwpByteWriter();
    payload.writeUint8(QWP_EGRESS_MESSAGE.RESULT_END).writeBigUint64(11n);
    writeQwpVarint(payload, 4);
    writeQwpVarint(payload, 123);
    expect(
      decodeQwpEgressMessage(encodeQwpFrame(payload.toUint8Array())),
    ).toMatchObject({
      kind: "result-end",
      requestId: 11n,
      finalSequence: 4n,
      totalRows: 123n,
    });

    expect(() =>
      decodeQwpEgressMessage(
        encodeQwpFrame(Uint8Array.of(QWP_EGRESS_MESSAGE.QUERY_ERROR)),
      ),
    ).toThrow(/truncated/i);
  });
});
