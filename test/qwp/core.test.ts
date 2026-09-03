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
  QWP_MAX_COLUMNS_PER_TABLE,
  QWP_MAX_ROWS_PER_TABLE,
  QWP_MAX_SYMBOL_DICTIONARY_SIZE,
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
  QwpProtocolError,
  QwpSymbolDictionary,
  QwpTableBuffer,
  qwpGorillaSize,
  qwpVarintSize,
  readQwpVarint,
  writeQwpVarint,
} from "../../packages/client-core/src/qwp";
import {
  encodeUtf8,
  utf8Length,
} from "../../packages/client-core/src/_qwp/_core/bytes";

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

  it("measures UTF-8 byte length identically to encoding it", () => {
    // utf8Length feeds frame sizing, so it must count exactly what encodeUtf8()
    // writes -- including the 3-byte replacement for an unpaired surrogate --
    // rather than diverge and mis-size a VARCHAR column.
    for (const value of [
      "",
      "order_12345",
      "héllo",
      "€uro",
      "smile 😀 mix",
      "\uD800", // lone high surrogate
      "\uDC00", // lone low surrogate
      "a\uD800b", // high surrogate not followed by a low one
      "😀", // a valid surrogate pair
    ]) {
      expect(utf8Length(value)).toBe(encodeUtf8(value).length);
    }
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
  it("applies Java-compatible table and column identifier rules", () => {
    for (const name of [
      "",
      " leading",
      "trailing ",
      ".hidden",
      "trailing.",
      "double..dot",
      "bad/name",
      "bad\nname",
      "bad\ufeffname",
    ]) {
      expect(() => new QwpTableBuffer(name)).toThrow(
        /table name (cannot be empty|contains illegal characters)/,
      );
    }
    for (const name of [
      "bad.column",
      "bad-column",
      "bad/name",
      "bad\tname",
      "bad\u007fname",
    ]) {
      const table = new QwpTableBuffer("valid table.csv");
      expect(() => table.getOrCreateColumn(name, QWP_COLUMN_TYPE.LONG)).toThrow(
        /column name contains illegal characters/,
      );
    }

    const atByteLimit = `${"é".repeat(63)}a`;
    const overByteLimit = "é".repeat(64);
    expect(() => new QwpTableBuffer(atByteLimit)).not.toThrow();
    expect(() => new QwpTableBuffer(overByteLimit)).toThrow(
      /table name too long.*maxLength=127/,
    );
    const unicode = new QwpTableBuffer("t");
    expect(() =>
      unicode.getOrCreateColumn(atByteLimit, QWP_COLUMN_TYPE.LONG),
    ).not.toThrow();
    expect(() =>
      unicode.getOrCreateColumn(overByteLimit, QWP_COLUMN_TYPE.LONG),
    ).toThrow(/column name too long.*maxLength=127/);

    expect(() => new QwpTableBuffer("😀", 4)).not.toThrow();
    expect(() => new QwpTableBuffer("😀", 3)).toThrow(
      /table name too long.*maxLength=3/,
    );
  });

  it("tracks columns case-insensitively and preserves first spelling", () => {
    const table = new QwpTableBuffer("events");
    const first = table.getOrCreateColumn("Value", QWP_COLUMN_TYPE.LONG)!;
    first.values.push(1n);
    expect(table.getOrCreateColumn("VALUE", QWP_COLUMN_TYPE.LONG)).toBeNull();
    table.nextRow();

    const second = table.getOrCreateColumn("value", QWP_COLUMN_TYPE.LONG)!;
    expect(second).toBe(first);
    second.values.push(2n);
    table.nextRow();

    expect(table.columns).toHaveLength(1);
    expect(table.columns[0]).toMatchObject({
      name: "Value",
      values: [1n, 2n],
      nulls: [false, false],
    });
    expect(() =>
      table.getOrCreateColumn("vAlUe", QWP_COLUMN_TYPE.DOUBLE),
    ).toThrow(/column type mismatch/);
  });

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

  it("slices a null-free column without walking the rows before it", () => {
    // `values` holds non-null entries only, so a row index becomes a value
    // index by counting the nulls before it. Doing that by scanning from row
    // zero costs O(start) per column on every slice, which makes any caller
    // that walks a table in ascending slices -- the UDP datagram splitter, the
    // ingress batch-cap bisector -- quadratic in the row count. A column with
    // no nulls needs no scan at all, and that is the common case.
    const table = new QwpTableBuffer("events");
    const rows = 5_000;
    for (let row = 0; row < rows; row++) {
      table.getOrCreateColumn("value", QWP_COLUMN_TYPE.LONG)!.values.push(1n);
      table.nextRow();
    }
    const column = table.columns[0];
    let indexReads = 0;
    column.nulls = new Proxy(column.nulls, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) indexReads++;
        return Reflect.get(target, key, receiver);
      },
    });

    const sliced = table.sliceRows(rows - 10, rows);

    expect(sliced.rowCount).toBe(10);
    expect(sliced.columns[0].values).toHaveLength(10);
    // Scanning would touch every row before the slice; the shortcut touches
    // none of them.
    expect(indexReads).toBeLessThan(rows / 10);
  });

  it("slices a sparse column incrementally across an ascending walk", () => {
    // A column with nulls cannot use the dense shortcut, so its value offset
    // was recounted from row zero on every slice -- O(start) per call, and
    // O(rows^2) across a bisector that walks the table in ascending slices. The
    // offset is now memoized and advanced only over newly covered rows, so each
    // null flag is read a bounded number of times over the whole walk.
    const table = new QwpTableBuffer("events");
    const rows = 4_000;
    for (let row = 0; row < rows; row++) {
      const column = table.getOrCreateColumn("value", QWP_COLUMN_TYPE.LONG)!;
      if (row % 3 === 0) column.nulls[row] = true;
      else column.values.push(BigInt(row));
      table.nextRow();
    }
    const column = table.columns[0];
    let indexReads = 0;
    column.nulls = new Proxy(column.nulls, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) indexReads++;
        return Reflect.get(target, key, receiver);
      },
    });

    const step = 50;
    for (let start = 0; start < rows; start += step) {
      table.sliceRows(start, Math.min(rows, start + step));
    }

    // Amortized O(1) reads per row (advance the offset, count the slice, copy
    // the bitmap), so the walk is linear. The from-zero rescan was ~rows^2/step
    // -- about 160k reads here -- so this bound only holds with the memo.
    expect(indexReads).toBeLessThan(rows * 4);
  });

  it("slices identically whether or not the offset memo is warm", () => {
    // The memo must never change what a slice returns: an ascending walk warms
    // it, a later out-of-order slice falls back to a from-zero recount, and
    // both must match a fresh table's slice byte for byte.
    const build = () => {
      const table = new QwpTableBuffer("events");
      for (let row = 0; row < 40; row++) {
        const column = table.getOrCreateColumn("v", QWP_COLUMN_TYPE.LONG)!;
        if (row % 4 === 0) column.nulls[row] = true;
        else column.values.push(BigInt(row));
        table.nextRow();
      }
      return table;
    };
    const warmed = build();
    for (let start = 0; start < 40; start += 10)
      warmed.sliceRows(start, start + 10);

    for (const [start, end] of [
      [12, 27],
      [0, 40],
      [5, 6],
      [30, 40],
    ] as const) {
      const fromWarm = warmed.sliceRows(start, end).columns[0];
      const fromFresh = build().sliceRows(start, end).columns[0];
      expect(fromWarm.values).toEqual(fromFresh.values);
      expect(fromWarm.nulls).toEqual(fromFresh.nulls);
    }
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

  it("encodes a full inline symbol dictionary with dense first-seen IDs", () => {
    // Without a connection dictionary the encoder emits a per-column dictionary
    // and one ID per row. Resolving each row used to be O(rows x distinct) via
    // Array.indexOf; a Map keyed by text makes it linear without changing the
    // bytes -- the dictionary stays in first-seen order and IDs index into it.
    const table = new QwpTableBuffer("t");
    for (const symbol of ["a", "b", "a", "c", "b"]) {
      table.getOrCreateColumn("s", QWP_COLUMN_TYPE.SYMBOL)!.values.push(symbol);
      table.nextRow();
    }
    const frame = decodeQwpFrame(encodeQwpIngressFrame([table]));
    const reader = new QwpByteReader(frame.payload);
    expect(reader.readUtf8(Number(readQwpVarint(reader)))).toBe("t");
    expect(readQwpVarint(reader)).toBe(5n); // rows
    expect(readQwpVarint(reader)).toBe(1n); // columns
    expect(reader.readUtf8(Number(readQwpVarint(reader)))).toBe("s");
    expect(reader.readUint8()).toBe(QWP_COLUMN_TYPE.SYMBOL);
    expect(reader.readUint8()).toBe(0); // no nulls

    const entries: string[] = [];
    const dictSize = Number(readQwpVarint(reader));
    for (let index = 0; index < dictSize; index++) {
      entries.push(reader.readUtf8(Number(readQwpVarint(reader))));
    }
    expect(entries).toEqual(["a", "b", "c"]);

    const ids: number[] = [];
    for (let row = 0; row < 5; row++) ids.push(Number(readQwpVarint(reader)));
    expect(ids).toEqual([0, 1, 0, 2, 1]);
    reader.expectEnd();
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

    const message = decodeQwpEgressMessage(
      encodeQwpFrame(payload.toUint8Array()),
    );
    expect(message).toMatchObject({
      kind: "server-info",
      role: 1,
      epoch: 3n,
      clusterId: "cluster-a",
      nodeId: "node-1",
      zoneId: "eu-west-1a",
      compressionCodec: QWP_COMPRESSION_CODEC.ZSTD,
      compressionLevel: 3,
    });
    expect(Object.isFrozen(message)).toBe(true);
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

describe("protocol caps", () => {
  // Every one of these guards could be deleted, or its boundary flipped, with
  // the whole suite green. They are the client's own defence against building
  // a frame the server will reject, so each needs its boundary pinned.

  it("accepts the last column and rejects the next", () => {
    const table = new QwpTableBuffer("t");
    for (let index = 0; index < QWP_MAX_COLUMNS_PER_TABLE; index++) {
      expect(
        table.getOrCreateColumn(`c${index}`, QWP_COLUMN_TYPE.LONG),
      ).not.toBeNull();
    }
    expect(() =>
      table.getOrCreateColumn("one_too_many", QWP_COLUMN_TYPE.LONG),
    ).toThrow(`column count exceeds maximum ${QWP_MAX_COLUMNS_PER_TABLE}`);
  });

  it("accepts the last dictionary entry and rejects the next", () => {
    for (const add of ["getOrAdd", "addRecovered"] as const) {
      const dictionary = new QwpSymbolDictionary();
      // Fill the backing array without materialising a million strings; the
      // guard reads its length.
      (dictionary as unknown as { values: string[] }).values.length =
        QWP_MAX_SYMBOL_DICTIONARY_SIZE - 1;
      expect(() => dictionary[add]("last")).not.toThrow();
      expect(() => dictionary[add]("one too many")).toThrow(
        `symbol dictionary exceeds maximum size ${QWP_MAX_SYMBOL_DICTIONARY_SIZE}`,
      );
    }
  });

  it("rejects a frame with more than 65535 tables", () => {
    const table = new QwpTableBuffer("t");
    table.getOrCreateColumn("c", QWP_COLUMN_TYPE.LONG);
    // The guard runs before any encoding, so the same buffer can stand in for
    // every entry.
    expect(() => encodeQwpIngressFrame(new Array(65_536).fill(table))).toThrow(
      "more than 65535 tables",
    );
    expect(() =>
      encodeQwpIngressFrame(new Array(65_535).fill(table)),
    ).not.toThrow("more than 65535 tables");
  });

  it("rejects a table above the row cap", () => {
    // A million real rows would dominate the suite; the guard reads rowCount,
    // and a column-less table clears the consistency check that precedes it.
    const oversized = {
      name: "t",
      rowCount: QWP_MAX_ROWS_PER_TABLE + 1,
      columns: [],
    } as unknown as QwpTableBuffer;
    expect(() => encodeQwpIngressFrame([oversized])).toThrow(
      `maximum is ${QWP_MAX_ROWS_PER_TABLE}`,
    );
  });

  it("bounds a NACK message by its frame, not by a fixed ceiling", () => {
    // A 1024-byte ceiling used to sit on this path and it rejected frames the
    // server is allowed to send. QwpIngressProcessorState truncates ingress
    // error text at (http.send.buffer.size - 100) / 1.5 characters -- about
    // 1.4M at the 2 MB default -- so any length the u16 field can express is
    // legal. The rejection surfaced as a QwpProtocolError, which the
    // reconnecting transport rethrows as terminal, so a verbose explanation on
    // an otherwise retriable WRITE_ERROR killed a running producer. The Java
    // client checks the declared length against the frame and nothing else.
    const nack = (declared: number, present = declared) =>
      new QwpByteWriter()
        .writeUint8(QWP_STATUS.WRITE_ERROR)
        .writeBigUint64(0n)
        .writeUint16(declared)
        .writeBytes(new Uint8Array(present).fill(0x78))
        .toUint8Array();

    for (const length of [0, 1, 1024, 1025, 8192, 65535]) {
      const response = decodeQwpIngressResponse(nack(length));
      expect(response.status).toBe(QWP_STATUS.WRITE_ERROR);
      expect(response.errorMessage).toHaveLength(length);
    }

    // The frame remains the bound: a length the payload cannot satisfy is
    // still rejected before anything is copied.
    expect(() => decodeQwpIngressResponse(nack(65535, 16))).toThrow(
      QwpProtocolError,
    );
  });
});

describe("QWP ingress symbol encoding", () => {
  it("rejects a bare symbol ID when no dictionary gives it meaning", () => {
    // The delta encoder resolves a numeric SYMBOL value against the dictionary
    // it is handed. The non-delta encoder builds its inline dictionary out of
    // the values' text, and reading `.text` off a number gives undefined --
    // which TextEncoder encodes as zero bytes. Two distinct symbols used to
    // collapse into a single empty-string entry and be acknowledged OK.
    const dictionary = new QwpSymbolDictionary();
    const eth = dictionary.getOrAdd("ETH-USD");
    const btc = dictionary.getOrAdd("BTC-USD");

    const table = new QwpTableBuffer("trades");
    for (const id of [eth, btc, eth]) {
      table
        .getOrCreateColumn("symbol", QWP_COLUMN_TYPE.SYMBOL)!
        .values.push(id);
      table.nextRow();
    }

    expect(() =>
      encodeQwpIngressFrame([table], { dictionary, confirmedMaxSymbolId: -1 }),
    ).not.toThrow();
    expect(() => encodeQwpIngressFrame([table])).toThrow(
      /needs a symbol dictionary/,
    );
  });
});
