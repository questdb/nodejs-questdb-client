import { describe, expect, it } from "vitest";
import {
  encodeQwpBinds,
  encodeQwpQueryRequest,
  QWP_COLUMN_TYPE,
  QWP_EGRESS_MESSAGE,
  QWP_MAX_COLUMNS_PER_TABLE,
  QwpBindValues,
  QwpByteReader,
  readQwpVarint,
} from "../../packages/client-core/src/qwp";

function expectNonNullHeader(reader: QwpByteReader, type: number): void {
  expect(reader.readUint8()).toBe(type);
  expect(reader.readUint8()).toBe(0);
}

function expectNullHeader(reader: QwpByteReader, type: number): void {
  expect(reader.readUint8()).toBe(type);
  expect(reader.readUint8()).toBe(1);
  expect(reader.readUint8()).toBe(1);
}

describe("QWP typed query binds", () => {
  it("encodes every supported non-null scalar in positional order", () => {
    const encoded = encodeQwpBinds((binds) =>
      binds
        .setBoolean(0, true)
        .setByte(1, -128)
        .setShort(2, -1234)
        .setChar(3, "Q")
        .setInt(4, -2_000_000)
        .setLong(5, 9_000_000_000n)
        .setFloat(6, 3.25)
        .setDouble(7, -2.5)
        .setDate(8, 1_700_000_000_000n)
        .setTimestampMicros(9, 1_700_000_000_000_000n)
        .setTimestampNanos(10, 1_700_000_000_123_456_789n)
        .setVarchar(11, "café")
        .setUuid(12, "123e4567-e89b-12d3-a456-426614174000")
        .setLong256(13, 1n, 2n, 3n, 4n)
        .setGeohash(14, 5, 0xffn)
        .setDecimal64(15, 4, 123_456_789n)
        .setDecimal128(16, 6, 123_456_789_123_456n, 0n)
        .setDecimal256(17, 10, 420_000_000_000n, 0n, 0n, 0n),
    );

    expect(encoded.count).toBe(18);
    const reader = new QwpByteReader(encoded.payload);

    expectNonNullHeader(reader, QWP_COLUMN_TYPE.BOOLEAN);
    expect(reader.readUint8()).toBe(1);
    expectNonNullHeader(reader, QWP_COLUMN_TYPE.BYTE);
    expect(reader.readInt8()).toBe(-128);
    expectNonNullHeader(reader, QWP_COLUMN_TYPE.SHORT);
    expect(reader.readInt16()).toBe(-1234);
    expectNonNullHeader(reader, QWP_COLUMN_TYPE.CHAR);
    expect(reader.readUint16()).toBe("Q".charCodeAt(0));
    expectNonNullHeader(reader, QWP_COLUMN_TYPE.INT);
    expect(reader.readInt32()).toBe(-2_000_000);
    expectNonNullHeader(reader, QWP_COLUMN_TYPE.LONG);
    expect(reader.readBigInt64()).toBe(9_000_000_000n);
    expectNonNullHeader(reader, QWP_COLUMN_TYPE.FLOAT);
    expect(reader.readFloat32()).toBe(3.25);
    expectNonNullHeader(reader, QWP_COLUMN_TYPE.DOUBLE);
    expect(reader.readFloat64()).toBe(-2.5);
    expectNonNullHeader(reader, QWP_COLUMN_TYPE.DATE);
    expect(reader.readBigInt64()).toBe(1_700_000_000_000n);
    expectNonNullHeader(reader, QWP_COLUMN_TYPE.TIMESTAMP);
    expect(reader.readBigInt64()).toBe(1_700_000_000_000_000n);
    expectNonNullHeader(reader, QWP_COLUMN_TYPE.TIMESTAMP_NANOS);
    expect(reader.readBigInt64()).toBe(1_700_000_000_123_456_789n);

    expectNonNullHeader(reader, QWP_COLUMN_TYPE.VARCHAR);
    expect(reader.readUint32()).toBe(0);
    const varcharLength = reader.readUint32();
    expect(varcharLength).toBe(5);
    expect(reader.readUtf8(varcharLength)).toBe("café");

    expectNonNullHeader(reader, QWP_COLUMN_TYPE.UUID);
    expect(reader.readBigUint64()).toBe(0xa456426614174000n);
    expect(reader.readBigUint64()).toBe(0x123e4567e89b12d3n);

    expectNonNullHeader(reader, QWP_COLUMN_TYPE.LONG256);
    expect([
      reader.readBigInt64(),
      reader.readBigInt64(),
      reader.readBigInt64(),
      reader.readBigInt64(),
    ]).toEqual([1n, 2n, 3n, 4n]);

    expectNonNullHeader(reader, QWP_COLUMN_TYPE.GEOHASH);
    expect(readQwpVarint(reader)).toBe(5n);
    expect(reader.readUint8()).toBe(0x1f);

    expectNonNullHeader(reader, QWP_COLUMN_TYPE.DECIMAL64);
    expect(reader.readUint8()).toBe(4);
    expect(reader.readBigInt64()).toBe(123_456_789n);
    expectNonNullHeader(reader, QWP_COLUMN_TYPE.DECIMAL128);
    expect(reader.readUint8()).toBe(6);
    expect(reader.readBigInt64()).toBe(123_456_789_123_456n);
    expect(reader.readBigInt64()).toBe(0n);
    expectNonNullHeader(reader, QWP_COLUMN_TYPE.DECIMAL256);
    expect(reader.readUint8()).toBe(10);
    expect([
      reader.readBigInt64(),
      reader.readBigInt64(),
      reader.readBigInt64(),
      reader.readBigInt64(),
    ]).toEqual([420_000_000_000n, 0n, 0n, 0n]);
    reader.expectEnd();
  });

  it("preserves explicit null types and decimal/geohash metadata", () => {
    const encoded = encodeQwpBinds((binds) =>
      binds
        .setNull(0, QWP_COLUMN_TYPE.BOOLEAN)
        .setVarchar(1, null)
        .setUuid(2, null)
        .setNullDecimal64(3, 4)
        .setNullDecimal128(4, 18)
        .setNullDecimal256(5, 76)
        .setNullGeohash(6, 60),
    );
    const reader = new QwpByteReader(encoded.payload);

    expectNullHeader(reader, QWP_COLUMN_TYPE.BOOLEAN);
    expectNullHeader(reader, QWP_COLUMN_TYPE.VARCHAR);
    expectNullHeader(reader, QWP_COLUMN_TYPE.UUID);
    expectNullHeader(reader, QWP_COLUMN_TYPE.DECIMAL64);
    expect(reader.readUint8()).toBe(4);
    expectNullHeader(reader, QWP_COLUMN_TYPE.DECIMAL128);
    expect(reader.readUint8()).toBe(18);
    expectNullHeader(reader, QWP_COLUMN_TYPE.DECIMAL256);
    expect(reader.readUint8()).toBe(76);
    expectNullHeader(reader, QWP_COLUMN_TYPE.GEOHASH);
    expect(readQwpVarint(reader)).toBe(60n);
    reader.expectEnd();
  });

  it("places typed binds into QUERY_REQUEST without exposing raw bytes", () => {
    const request = encodeQwpQueryRequest({
      requestId: 7,
      sql: "select $1::long, $2::varchar",
      binds: (binds) => binds.setLong(0, 42n).setVarchar(1, "browser"),
    });
    const reader = new QwpByteReader(request);
    expect(reader.readUint8()).toBe(QWP_EGRESS_MESSAGE.QUERY_REQUEST);
    expect(reader.readBigUint64()).toBe(7n);
    const sqlLength = Number(readQwpVarint(reader));
    expect(reader.readUtf8(sqlLength)).toBe("select $1::long, $2::varchar");
    expect(readQwpVarint(reader)).toBe(0n);
    expect(readQwpVarint(reader)).toBe(2n);
    expectNonNullHeader(reader, QWP_COLUMN_TYPE.LONG);
    expect(reader.readBigInt64()).toBe(42n);
    expectNonNullHeader(reader, QWP_COLUMN_TYPE.VARCHAR);
    expect(reader.readUint32()).toBe(0);
    const length = reader.readUint32();
    expect(reader.readUtf8(length)).toBe("browser");
    reader.expectEnd();
  });

  it("rejects invalid order, ranges, types, UUIDs, and raw/typed mixing", () => {
    expect(() => encodeQwpBinds((binds) => binds.setLong(1, 1n))).toThrow(
      /expected 0, got 1/,
    );
    expect(() => encodeQwpBinds((binds) => binds.setByte(0, 128))).toThrow(
      /BYTE/,
    );
    expect(() =>
      encodeQwpBinds((binds) => binds.setLong(0, Number.MAX_SAFE_INTEGER + 1)),
    ).toThrow(/safe integer/);
    expect(() => encodeQwpBinds((binds) => binds.setChar(0, "😀"))).toThrow(
      /UTF-16/,
    );
    expect(() =>
      encodeQwpBinds((binds) => binds.setGeohash(0, 61, 1n)),
    ).toThrow(/GEOHASH precision/);
    expect(() =>
      encodeQwpBinds((binds) => binds.setDecimal64(0, 19, 1n)),
    ).toThrow(/DECIMAL64 scale/);
    expect(() =>
      encodeQwpBinds((binds) => binds.setDecimal128(0, 39, 1n, 0n)),
    ).toThrow(/DECIMAL128 scale/);
    expect(() =>
      encodeQwpBinds((binds) => binds.setUuid(0, "not-a-uuid")),
    ).toThrow(/canonical UUID/);
    expect(() =>
      encodeQwpBinds(async (binds) => {
        binds.setInt(0, 1);
      }),
    ).toThrow(/synchronous/);
    expect(() =>
      new QwpBindValues().setNull(0, QWP_COLUMN_TYPE.BINARY as never),
    ).toThrow(/unsupported QWP bind type/);
    expect(() =>
      encodeQwpQueryRequest({
        requestId: 0,
        sql: "select $1",
        binds: (binds) => binds.setInt(0, 1),
        bindCount: 1,
      }),
    ).toThrow(/cannot be mixed/);
    expect(() =>
      encodeQwpQueryRequest({
        requestId: 0,
        sql: "select 1",
        bindCount: QWP_MAX_COLUMNS_PER_TABLE + 1,
      }),
    ).toThrow(/bindCount/);

    const reusable = new QwpBindValues();
    expect(() => reusable.setInt(0, 0x80000000)).toThrow(/INT/);
    expect(() => reusable.setInt(0, 7)).not.toThrow();
  });

  it("can be reset and enforces the server bind-count cap", () => {
    const binds = new QwpBindValues().setInt(0, 1).reset().setLong(0, 2n);
    expect(binds.count).toBe(1);

    const uuidBits = encodeQwpBinds((values) =>
      values.setUuid(0, 0xffffffffffffffffn, 0x8000000000000000n),
    );
    const uuidReader = new QwpByteReader(uuidBits.payload);
    expectNonNullHeader(uuidReader, QWP_COLUMN_TYPE.UUID);
    expect(uuidReader.readBigUint64()).toBe(0xffffffffffffffffn);
    expect(uuidReader.readBigUint64()).toBe(0x8000000000000000n);

    expect(() =>
      encodeQwpBinds((values) => {
        for (let index = 0; index <= QWP_MAX_COLUMNS_PER_TABLE; index++) {
          values.setBoolean(index, true);
        }
      }),
    ).toThrow(/too many binds/);
  });
});
