import { QwpByteReader, QwpByteWriter } from "./bytes";
import { QWP_HEADER_SIZE, QWP_MAGIC, QWP_VERSION } from "./constants";
import { QwpProtocolError } from "./errors";

export interface QwpFrameHeader {
  version: number;
  flags: number;
  tableCount: number;
  payloadLength: number;
}

export interface QwpFrame extends QwpFrameHeader {
  payload: Uint8Array;
}

export function writeQwpFrameHeader(
  writer: QwpByteWriter,
  header: Omit<QwpFrameHeader, "version"> & { version?: number },
): void {
  const version = checkedUnsignedInteger(
    header.version ?? QWP_VERSION,
    0xff,
    "QWP version",
  );
  const flags = checkedUnsignedInteger(header.flags, 0xff, "QWP flags");
  const tableCount = checkedUnsignedInteger(
    header.tableCount,
    0xffff,
    "QWP table count",
  );
  const payloadLength = checkedUnsignedInteger(
    header.payloadLength,
    0xffffffff,
    "QWP payload length",
  );
  writer.writeUint32(QWP_MAGIC);
  writer.writeUint8(version);
  writer.writeUint8(flags);
  writer.writeUint16(tableCount);
  writer.writeUint32(payloadLength);
}

function checkedUnsignedInteger(
  value: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(
      `${name} must be an integer from 0 through ${maximum}`,
    );
  }
  return value;
}

export function encodeQwpFrame(
  payload: Uint8Array,
  flags = 0,
  tableCount = 0,
): Uint8Array {
  const writer = new QwpByteWriter(QWP_HEADER_SIZE + payload.length);
  writeQwpFrameHeader(writer, {
    flags,
    tableCount,
    payloadLength: payload.length,
  });
  writer.writeBytes(payload);
  return writer.toUint8Array();
}

export function decodeQwpFrame(bytes: Uint8Array): QwpFrame {
  if (bytes.length < QWP_HEADER_SIZE) {
    throw new QwpProtocolError("QWP frame is shorter than its 12-byte header");
  }
  const reader = new QwpByteReader(bytes);
  const magic = reader.readUint32("QWP magic");
  if (magic !== QWP_MAGIC) {
    throw new QwpProtocolError(
      `invalid QWP magic 0x${magic.toString(16).padStart(8, "0")}`,
    );
  }
  const version = reader.readUint8("QWP version");
  if (version !== QWP_VERSION) {
    throw new QwpProtocolError(`unsupported QWP version ${version}`);
  }
  const flags = reader.readUint8("QWP flags");
  const tableCount = reader.readUint16("QWP table count");
  const payloadLength = reader.readUint32("QWP payload length");
  if (payloadLength !== reader.remaining) {
    throw new QwpProtocolError(
      `QWP payload length mismatch [declared=${payloadLength}, actual=${reader.remaining}]`,
    );
  }
  return {
    version,
    flags,
    tableCount,
    payloadLength,
    payload: reader.readBytes(payloadLength, "QWP payload"),
  };
}
