import { bench, describe } from "vitest";
import {
  decodeQwpEgressMessage,
  encodeQwpFrame,
  encodeQwpGorilla,
  QWP_COLUMN_TYPE,
  QWP_EGRESS_MESSAGE,
  QWP_FLAG_DELTA_SYMBOL_DICTIONARY,
  QWP_FLAG_GORILLA,
  QWP_FLAG_ZSTD,
  QwpByteWriter,
  QwpResultBatchDecoder,
  writeQwpVarint,
} from "../packages/client-core/src/_qwp/_core";

const ROWS = 10_000;
let sink = 0;

function writeString(writer: QwpByteWriter, value: string): void {
  const bytes = new TextEncoder().encode(value);
  writeQwpVarint(writer, bytes.byteLength);
  writer.writeBytes(bytes);
}

function resultFrame(rowCount: number): Uint8Array {
  const payload = new QwpByteWriter();
  payload.writeUint8(QWP_EGRESS_MESSAGE.RESULT_BATCH).writeBigUint64(1n);
  writeQwpVarint(payload, 0); // batch sequence
  writeString(payload, "bench_result");
  writeQwpVarint(payload, rowCount);
  writeQwpVarint(payload, 4);
  for (const [name, type] of [
    ["id", QWP_COLUMN_TYPE.INT],
    ["price", QWP_COLUMN_TYPE.DOUBLE],
    ["name", QWP_COLUMN_TYPE.VARCHAR],
    ["timestamp", QWP_COLUMN_TYPE.TIMESTAMP],
  ] as const) {
    writeString(payload, name);
    payload.writeUint8(type);
  }

  payload.writeUint8(0); // no INT nulls
  for (let row = 0; row < rowCount; row++) payload.writeInt32(row);

  payload.writeUint8(0); // no DOUBLE nulls
  for (let row = 0; row < rowCount; row++) {
    payload.writeFloat64(1000 + (row % 1000) / 10);
  }

  payload.writeUint8(0); // no VARCHAR nulls
  const text = Array.from(
    { length: rowCount },
    (_, row) => `value-${row % 100}`,
  );
  let textOffset = 0;
  payload.writeUint32(0);
  for (const value of text) {
    textOffset += new TextEncoder().encode(value).byteLength;
    payload.writeUint32(textOffset);
  }
  for (const value of text) payload.writeUtf8(value);

  payload.writeUint8(0).writeUint8(1); // no nulls, Gorilla encoded
  payload.writeBytes(
    encodeQwpGorilla(
      Array.from(
        { length: rowCount },
        (_, row) => 1_700_000_000_000_000n + BigInt(row) * 1000n,
      ),
    ),
  );
  return encodeQwpFrame(payload.toUint8Array(), QWP_FLAG_GORILLA, 1);
}

// A standard Zstd frame containing a 100-row QWP INT result body.
const COMPRESSED_INT_RESULT_BODY = Uint8Array.from([
  40, 181, 47, 253, 96, 153, 0, 157, 0, 0, 96, 0, 0, 0, 100, 1, 1, 120, 4, 0,
  42, 0, 0, 1, 0, 138, 171, 46, 9,
]);

function compressedResultFrame(): Uint8Array {
  const payload = new QwpByteWriter();
  payload.writeUint8(QWP_EGRESS_MESSAGE.RESULT_BATCH).writeBigUint64(1n);
  writeQwpVarint(payload, 0);
  payload.writeBytes(COMPRESSED_INT_RESULT_BODY);
  return encodeQwpFrame(
    payload.toUint8Array(),
    QWP_FLAG_DELTA_SYMBOL_DICTIONARY | QWP_FLAG_ZSTD,
    1,
  );
}

const decoded = decodeQwpEgressMessage(resultFrame(ROWS));
if (decoded.kind !== "result-batch") {
  throw new Error("benchmark frame is not a result batch");
}
const compressed = decodeQwpEgressMessage(compressedResultFrame());
if (compressed.kind !== "result-batch") {
  throw new Error("compressed benchmark frame is not a result batch");
}

describe("QWP egress batch decoding", () => {
  bench(`materialized / ${ROWS} rows`, () => {
    const batch = new QwpResultBatchDecoder().decode(decoded);
    sink += batch.rowCount + batch.columns.length;
  });

  const viewDecoder = new QwpResultBatchDecoder();
  bench(`reusable column views / ${ROWS} rows`, () => {
    viewDecoder.resetQuerySchema();
    const batch = viewDecoder.decodeView(decoded);
    sink += batch.rowCount + batch.columnCount;
  });

  const columnDecoder = new QwpResultBatchDecoder();
  bench(`column-view traversal / ${ROWS} rows`, () => {
    columnDecoder.resetQuerySchema();
    const batch = columnDecoder.decodeView(decoded);
    const ids = batch.column(0);
    const prices = batch.column(1);
    const names = batch.column(2);
    for (let row = 0; row < batch.rowCount; row++) {
      sink += ids.getInt(row) + prices.getDouble(row);
      sink += names.getString(row)?.length ?? 0;
    }
  });

  const rowDecoder = new QwpResultBatchDecoder();
  bench(`row-view traversal / ${ROWS} rows`, () => {
    rowDecoder.resetQuerySchema();
    const batch = rowDecoder.decodeView(decoded);
    batch.forEachRow((row) => {
      sink += row.getInt(0) + row.getDouble(1);
      sink += row.getString(2)?.length ?? 0;
    });
  });

  bench("Zstd decompress + materialize / 100 INT rows", () => {
    const batch = new QwpResultBatchDecoder().decode(compressed);
    sink += batch.rowCount + Number(batch.columns[0].values[0]);
  });
});

export const egressBenchmarkSink = (): number => sink;
