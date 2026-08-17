import { encodeUtf8, QwpByteReader, QwpByteWriter } from "./bytes";
import { encodeQwpBinds, QwpBindSetter } from "./binds";
import {
  QWP_EGRESS_CAPABILITY,
  QWP_EGRESS_MESSAGE,
  QWP_MAX_COLUMNS_PER_TABLE,
} from "./constants";
import { decodeQwpFrame, QwpFrameHeader } from "./frame";
import { QwpProtocolError } from "./errors";
import { readQwpVarint, writeQwpVarint } from "./varint";

export interface QwpQueryRequest {
  requestId: number | bigint;
  sql: string;
  /** Zero means unbounded. */
  initialCredit?: number | bigint;
  /** Browser-safe typed positional binds. */
  binds?: QwpBindSetter;
  /** Advanced escape hatch for an already encoded bind section. */
  bindCount?: number;
  /** Advanced escape hatch for an already encoded bind section. */
  bindPayload?: Uint8Array;
  /** Append only after SERVER_INFO advertises QUERY_FLAGS. */
  queryFlags?: number | bigint;
}

export interface QwpServerInfoMessage extends QwpFrameHeader {
  kind: "server-info";
  role: number;
  epoch: bigint;
  capabilities: number;
  serverWallNanoseconds: bigint;
  clusterId: string;
  nodeId: string;
  zoneId: string | null;
}

export interface QwpResultBatchMessage extends QwpFrameHeader {
  kind: "result-batch";
  requestId: bigint;
  batchSequence: bigint;
  /**
   * Raw or Zstd-compressed delta dictionary and columnar table block; decoded
   * by the batch decoder according to the frame flags.
   */
  body: Uint8Array;
}

export interface QwpResultEndMessage extends QwpFrameHeader {
  kind: "result-end";
  requestId: bigint;
  finalSequence: bigint;
  totalRows: bigint;
}

export interface QwpQueryErrorMessage extends QwpFrameHeader {
  kind: "query-error";
  requestId: bigint;
  status: number;
  message: string;
}

export interface QwpExecDoneMessage extends QwpFrameHeader {
  kind: "exec-done";
  requestId: bigint;
  operationType: number;
  rowsAffected: bigint;
}

export interface QwpCacheResetMessage extends QwpFrameHeader {
  kind: "cache-reset";
  resetMask: number;
}

export type QwpEgressMessage =
  | QwpServerInfoMessage
  | QwpResultBatchMessage
  | QwpResultEndMessage
  | QwpQueryErrorMessage
  | QwpExecDoneMessage
  | QwpCacheResetMessage;

function requestId(value: number | bigint): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("requestId must be a non-negative safe integer");
    }
    return BigInt(value);
  }
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new RangeError("requestId must fit in uint64");
  }
  return value;
}

/** Encodes the unframed client-to-server QUERY_REQUEST payload. */
export function encodeQwpQueryRequest(request: QwpQueryRequest): Uint8Array {
  if (
    request.binds !== undefined &&
    (request.bindCount !== undefined || request.bindPayload !== undefined)
  ) {
    throw new Error(
      "typed binds cannot be mixed with raw bindCount/bindPayload",
    );
  }
  const encodedBinds = request.binds
    ? encodeQwpBinds(request.binds)
    : undefined;
  const bindCount = encodedBinds?.count ?? request.bindCount ?? 0;
  if (
    !Number.isSafeInteger(bindCount) ||
    bindCount < 0 ||
    bindCount > QWP_MAX_COLUMNS_PER_TABLE
  ) {
    throw new RangeError(
      `bindCount must be an integer between 0 and ${QWP_MAX_COLUMNS_PER_TABLE}`,
    );
  }
  const bindPayload =
    encodedBinds?.payload ?? request.bindPayload ?? new Uint8Array();
  if (bindCount === 0 && bindPayload.length !== 0) {
    throw new Error("bindPayload requires a non-zero bindCount");
  }

  const sql = encodeUtf8(request.sql);
  const writer = new QwpByteWriter(32 + sql.length + bindPayload.length);
  writer.writeUint8(QWP_EGRESS_MESSAGE.QUERY_REQUEST);
  writer.writeBigUint64(requestId(request.requestId));
  writeQwpVarint(writer, sql.length);
  writer.writeBytes(sql);
  writeQwpVarint(writer, request.initialCredit ?? 0);
  writeQwpVarint(writer, bindCount);
  writer.writeBytes(bindPayload);
  if ((request.queryFlags ?? 0) !== 0) {
    writeQwpVarint(writer, request.queryFlags!);
  }
  return writer.toUint8Array();
}

/** Encodes the unframed client-to-server CANCEL payload. */
export function encodeQwpCancel(request: number | bigint): Uint8Array {
  const writer = new QwpByteWriter(9);
  writer.writeUint8(QWP_EGRESS_MESSAGE.CANCEL);
  writer.writeBigUint64(requestId(request));
  return writer.toUint8Array();
}

/** Encodes the unframed client-to-server CREDIT payload. */
export function encodeQwpCredit(
  request: number | bigint,
  additionalBytes: number | bigint,
): Uint8Array {
  const writer = new QwpByteWriter(19);
  writer.writeUint8(QWP_EGRESS_MESSAGE.CREDIT);
  writer.writeBigUint64(requestId(request));
  writeQwpVarint(writer, additionalBytes);
  return writer.toUint8Array();
}

function readUint16Utf8(reader: QwpByteReader, label: string): string {
  const length = reader.readUint16(`${label} length`);
  return reader.readUtf8(length, label);
}

/** Decodes one QWP-framed server-to-client egress message. */
export function decodeQwpEgressMessage(bytes: Uint8Array): QwpEgressMessage {
  const frame = decodeQwpFrame(bytes);
  const reader = new QwpByteReader(frame.payload);
  const messageKind = reader.readUint8("egress message kind");
  const header: QwpFrameHeader = {
    version: frame.version,
    flags: frame.flags,
    tableCount: frame.tableCount,
    payloadLength: frame.payloadLength,
  };

  switch (messageKind) {
    case QWP_EGRESS_MESSAGE.SERVER_INFO: {
      const role = reader.readUint8("server role");
      const epoch = reader.readBigUint64("server epoch");
      const capabilities = reader.readUint32("server capabilities");
      const serverWallNanoseconds = reader.readBigInt64("server wall clock");
      const clusterId = readUint16Utf8(reader, "cluster ID");
      const nodeId = readUint16Utf8(reader, "node ID");
      const zoneId =
        (capabilities & QWP_EGRESS_CAPABILITY.ZONE) !== 0
          ? readUint16Utf8(reader, "zone ID")
          : null;
      reader.expectEnd("SERVER_INFO");
      return {
        ...header,
        kind: "server-info",
        role,
        epoch,
        capabilities,
        serverWallNanoseconds,
        clusterId,
        nodeId,
        zoneId,
      };
    }
    case QWP_EGRESS_MESSAGE.RESULT_BATCH: {
      const requestId = reader.readBigUint64("result request ID");
      const batchSequence = readQwpVarint(reader);
      const body = reader.readBytes(reader.remaining, "result batch body");
      return {
        ...header,
        kind: "result-batch",
        requestId,
        batchSequence,
        body,
      };
    }
    case QWP_EGRESS_MESSAGE.RESULT_END: {
      const requestId = reader.readBigUint64("result request ID");
      const finalSequence = readQwpVarint(reader);
      const totalRows = readQwpVarint(reader);
      reader.expectEnd("RESULT_END");
      return {
        ...header,
        kind: "result-end",
        requestId,
        finalSequence,
        totalRows,
      };
    }
    case QWP_EGRESS_MESSAGE.QUERY_ERROR: {
      const requestId = reader.readBigUint64("query error request ID");
      const status = reader.readUint8("query error status");
      const length = reader.readUint16("query error message length");
      const message = reader.readUtf8(length, "query error message");
      reader.expectEnd("QUERY_ERROR");
      return {
        ...header,
        kind: "query-error",
        requestId,
        status,
        message,
      };
    }
    case QWP_EGRESS_MESSAGE.EXEC_DONE: {
      const requestId = reader.readBigUint64("exec request ID");
      const operationType = reader.readUint8("operation type");
      const rowsAffected = readQwpVarint(reader);
      reader.expectEnd("EXEC_DONE");
      return {
        ...header,
        kind: "exec-done",
        requestId,
        operationType,
        rowsAffected,
      };
    }
    case QWP_EGRESS_MESSAGE.CACHE_RESET: {
      const resetMask = reader.readUint8("cache reset mask");
      reader.expectEnd("CACHE_RESET");
      return { ...header, kind: "cache-reset", resetMask };
    }
    default:
      throw new QwpProtocolError(
        `unsupported QWP egress message kind 0x${messageKind.toString(16)}`,
      );
  }
}
