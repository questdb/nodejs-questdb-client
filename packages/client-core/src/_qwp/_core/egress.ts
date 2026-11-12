import { encodeUtf8, QwpByteReader, QwpByteWriter } from "./bytes";
import { encodeQwpBinds, QwpBindSetter } from "./binds";
import {
  QWP_EGRESS_CAPABILITY,
  QWP_EGRESS_MESSAGE,
  QWP_MAX_COLUMNS_PER_TABLE,
  QWP_QUERY_FLAG_COUNT_ROWS,
  QWP_QUERY_FLAG_ERROR_POSITION,
  QWP_QUERY_FLAG_MAX_ROWS,
  QWP_QUERY_FLAG_SKIP_ROWS,
  QWP_QUERY_FLAG_STATS,
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
  /**
   * Append only after SERVER_INFO advertises QUERY_FLAGS, and set the
   * query-details bits only after it advertises QUERY_DETAILS: a server
   * without that capability ignores them, and streams every row whatever
   * `skipRows` and `maxRows` say.
   */
  queryFlags?: number | bigint;
  /**
   * `skip_rows`, the rows to leave out at the start of the result set.
   * Required by, and only allowed with, `QWP_QUERY_FLAG_SKIP_ROWS` in
   * `queryFlags`. At most 2^63 - 1.
   */
  skipRows?: number | bigint;
  /**
   * `max_rows`, the most rows to stream. Required by, and only allowed with,
   * `QWP_QUERY_FLAG_MAX_ROWS` in `queryFlags`. At most 2^63 - 1.
   */
  maxRows?: number | bigint;
}

/**
 * Execution statistics of one query, measured on the server. A completion
 * carries them when its query asked for them (`QWP_QUERY_FLAG_STATS`).
 */
export interface QwpQueryStats {
  /**
   * Nanoseconds spent compiling the SQL, every attempt included; zero when
   * the server reused a cached plan.
   */
  readonly compileNanos: bigint;
  /**
   * Nanoseconds from the server receiving the request to its terminal
   * response. Includes the other three durations.
   */
  readonly executeNanos: bigint;
  /**
   * Nanoseconds spent counting the rows a row window left out, for
   * `QWP_QUERY_FLAG_COUNT_ROWS`.
   */
  readonly countNanos: bigint;
  /**
   * Nanoseconds the query waited for the client: to read results, or to grant
   * flow-control credit.
   */
  readonly clientWaitNanos: bigint;
  /** Whether the query's filter ran as JIT-compiled native code. */
  readonly jitCompiled: boolean;
}

/** Immutable endpoint metadata from the most recent successful egress bind. */
export interface QwpServerInfoMessage extends QwpFrameHeader {
  kind: "server-info";
  role: number;
  epoch: bigint;
  capabilities: number;
  serverWallNanoseconds: bigint;
  clusterId: string;
  nodeId: string;
  zoneId: string | null;
  compressionCodec: number | null;
  compressionLevel: number | null;
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
  /** Rows the stream carried: those the row window let through. */
  totalRows: bigint;
  /**
   * Rows in the whole result set, whatever the row window left out of the
   * stream. Present when the query asked for it (`QWP_QUERY_FLAG_COUNT_ROWS`).
   */
  rowCount?: bigint;
  /** Present when the query asked for it (`QWP_QUERY_FLAG_STATS`). */
  stats?: QwpQueryStats;
}

export interface QwpQueryErrorMessage extends QwpFrameHeader {
  kind: "query-error";
  requestId: bigint;
  status: number;
  message: string;
  /**
   * UTF-16 offset into the SQL text the error points at: an index into the
   * JavaScript string the query was issued with. Present when the query asked
   * for it (`QWP_QUERY_FLAG_ERROR_POSITION`) and the error points into the SQL
   * text, which a protocol error, a cancellation or an oversized row does not.
   */
  position?: number;
}

export interface QwpExecDoneMessage extends QwpFrameHeader {
  kind: "exec-done";
  requestId: bigint;
  operationType: number;
  rowsAffected: bigint;
  /** Present when the query asked for it (`QWP_QUERY_FLAG_STATS`). */
  stats?: QwpQueryStats;
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

const MAX_UINT64 = 0xffffffffffffffffn;
/**
 * Largest `skip_rows` and `max_rows`. QuestDB reads both into a signed long
 * and rejects a varint of 2^63 or more.
 */
const MAX_ROW_WINDOW_BOUND = 0x7fffffffffffffffn;
/** `stats_flags` bit of the statistics block: the filter ran JIT-compiled. */
const QUERY_STATS_FLAG_JIT_COMPILED = 0x01;

function requestId(value: number | bigint): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("requestId must be a non-negative safe integer");
    }
    return BigInt(value);
  }
  if (value < 0n || value > MAX_UINT64) {
    throw new RangeError("requestId must fit in uint64");
  }
  return value;
}

function queryFlagBits(value: number | bigint): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("queryFlags must be a non-negative safe integer");
    }
    return BigInt(value);
  }
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT64) {
    throw new RangeError("queryFlags must fit in uint64");
  }
  return value;
}

function hasQueryFlag(queryFlags: bigint, flag: number): boolean {
  return (queryFlags & BigInt(flag)) !== 0n;
}

/**
 * Validates a `skip_rows` or `max_rows` value: a non-negative safe integer,
 * or a bigint no greater than 2^63 - 1.
 *
 * @internal Shared with the query session, which validates its options before
 * a request exists. Not re-exported from the `_core` barrel.
 */
export function validateQwpRowWindowBound(
  value: number | bigint,
  name: string,
): number | bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
    return value;
  }
  if (typeof value !== "bigint" || value < 0n || value > MAX_ROW_WINDOW_BOUND) {
    throw new RangeError(
      `${name} must be a bigint between 0 and ${MAX_ROW_WINDOW_BOUND}`,
    );
  }
  return value;
}

/**
 * The row-window value a flag carries, which the request must supply exactly
 * when the flag is set: a flag without its value would make the server read
 * whatever follows as the value, and a value without its flag would never be
 * sent.
 */
function rowWindowField(
  queryFlags: bigint,
  flag: number,
  flagName: string,
  value: number | bigint | undefined,
  name: string,
): number | bigint | undefined {
  const flagged = hasQueryFlag(queryFlags, flag);
  if (flagged && value === undefined) {
    throw new Error(`${flagName} in queryFlags requires ${name}`);
  }
  if (!flagged && value !== undefined) {
    throw new Error(`${name} requires ${flagName} in queryFlags`);
  }
  return value === undefined
    ? undefined
    : validateQwpRowWindowBound(value, name);
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
  // The mirror of the check above. Only one direction was guarded, so a count
  // supplied without its payload encoded a QUERY_REQUEST declaring N binds and
  // carrying none: the server then read whatever follows the bind section --
  // the queryFlags varint -- as the first bind's type byte, and answered with
  // a parse error where the symmetric mistake was caught here. The two fields
  // are documented as one escape hatch, so neither is usable on its own.
  if (bindCount !== 0 && bindPayload.length === 0) {
    throw new Error("bindCount requires a non-empty bindPayload");
  }

  // The field is typed `number | bigint`, and `0n !== 0`: testing against the
  // number zero alone once made a bigint zero look like a flag and append a
  // trailing varint that 0 omitted. Read as a bigint, both spellings of "no
  // flags" omit it.
  const queryFlags = queryFlagBits(request.queryFlags ?? 0);
  // The row-window values follow the flags in ascending order of their bits.
  // Null is unset, as it is for the other optional fields.
  const skipRows = rowWindowField(
    queryFlags,
    QWP_QUERY_FLAG_SKIP_ROWS,
    "QWP_QUERY_FLAG_SKIP_ROWS",
    request.skipRows ?? undefined,
    "skipRows",
  );
  const maxRows = rowWindowField(
    queryFlags,
    QWP_QUERY_FLAG_MAX_ROWS,
    "QWP_QUERY_FLAG_MAX_ROWS",
    request.maxRows ?? undefined,
    "maxRows",
  );

  const sql = encodeUtf8(request.sql);
  const writer = new QwpByteWriter(32 + sql.length + bindPayload.length);
  writer.writeUint8(QWP_EGRESS_MESSAGE.QUERY_REQUEST);
  writer.writeBigUint64(requestId(request.requestId));
  writeQwpVarint(writer, sql.length);
  writer.writeBytes(sql);
  writeQwpVarint(writer, request.initialCredit ?? 0);
  writeQwpVarint(writer, bindCount);
  writer.writeBytes(bindPayload);
  if (queryFlags !== 0n) {
    writeQwpVarint(writer, queryFlags);
    if (skipRows !== undefined) writeQwpVarint(writer, skipRows);
    if (maxRows !== undefined) writeQwpVarint(writer, maxRows);
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

function readQueryStats(reader: QwpByteReader): QwpQueryStats {
  const compileNanos = readQwpVarint(reader);
  const executeNanos = readQwpVarint(reader);
  const countNanos = readQwpVarint(reader);
  const clientWaitNanos = readQwpVarint(reader);
  // Bits this client does not know are ignored: they report, they do not
  // change how anything is read.
  const statsFlags = reader.readUint8("query statistics flags");
  return {
    compileNanos,
    executeNanos,
    countNanos,
    clientWaitNanos,
    jitCompiled: (statsFlags & QUERY_STATS_FLAG_JIT_COMPILED) !== 0,
  };
}

/**
 * Decodes one QWP-framed server-to-client egress message. RESULT_END, EXEC_DONE
 * and QUERY_ERROR are read without the trailers that query-details flags add,
 * and rejected if they carry any: decode the responses to a request sent with
 * those flags with {@link decodeQwpEgressMessageWithQueryFlags}.
 */
export function decodeQwpEgressMessage(bytes: Uint8Array): QwpEgressMessage {
  // One parameter, as published: `map()` and `Array.from()` pass the index as
  // a second argument, which a second parameter would read as query flags,
  // rejecting valid frames.
  return decodeEgressMessage(bytes, 0n, true);
}

/**
 * Decodes one QWP-framed server-to-client egress message answering a
 * QUERY_REQUEST sent with `queryFlags`.
 *
 * The flags decide the trailers RESULT_END, EXEC_DONE and QUERY_ERROR end with
 * -- the row count, the statistics and the error position -- which are read
 * into the message and must be the last bytes of the frame. Other messages do
 * not depend on them, and with no flags set this decodes as
 * {@link decodeQwpEgressMessage} does.
 */
export function decodeQwpEgressMessageWithQueryFlags(
  bytes: Uint8Array,
  queryFlags: number | bigint,
): QwpEgressMessage {
  return decodeEgressMessage(bytes, queryFlagBits(queryFlags), true);
}

/**
 * Decodes one egress message without the trailers of RESULT_END, EXEC_DONE and
 * QUERY_ERROR, whose layout only the session that sent the request knows. The
 * rest of the frame is validated as decodeQwpEgressMessage() does.
 *
 * @internal The reconnecting egress transport reads the kind and request ID of
 * each message with it before the session decodes the whole frame. Not
 * re-exported from the `_core` barrel.
 */
export function decodeQwpEgressEnvelope(bytes: Uint8Array): QwpEgressMessage {
  return decodeEgressMessage(bytes, 0n, false);
}

function decodeEgressMessage(
  bytes: Uint8Array,
  queryFlags: bigint,
  readTrailers: boolean,
): QwpEgressMessage {
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
      const compressionCodec =
        (capabilities & QWP_EGRESS_CAPABILITY.COMPRESSION) !== 0
          ? reader.readUint8("egress compression codec")
          : null;
      const compressionLevel =
        compressionCodec !== null
          ? reader.readUint8("egress compression level")
          : null;
      reader.expectEnd("SERVER_INFO");
      return Object.freeze({
        ...header,
        kind: "server-info",
        role,
        epoch,
        capabilities,
        serverWallNanoseconds,
        clusterId,
        nodeId,
        zoneId,
        compressionCodec,
        compressionLevel,
      });
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
      const end: QwpResultEndMessage = {
        ...header,
        kind: "result-end",
        requestId,
        finalSequence,
        totalRows,
      };
      if (readTrailers) {
        // Each trailer the request asked for is always sent: RESULT_END only
        // answers a request the server has decoded, flags included.
        if (hasQueryFlag(queryFlags, QWP_QUERY_FLAG_COUNT_ROWS)) {
          end.rowCount = readQwpVarint(reader);
        }
        if (hasQueryFlag(queryFlags, QWP_QUERY_FLAG_STATS)) {
          end.stats = readQueryStats(reader);
        }
        reader.expectEnd("RESULT_END");
      }
      return end;
    }
    case QWP_EGRESS_MESSAGE.QUERY_ERROR: {
      const requestId = reader.readBigUint64("query error request ID");
      const status = reader.readUint8("query error status");
      const length = reader.readUint16("query error message length");
      const message = reader.readUtf8(length, "query error message");
      const error: QwpQueryErrorMessage = {
        ...header,
        kind: "query-error",
        requestId,
        status,
        message,
      };
      if (readTrailers) {
        // Optional even when asked for: a request the server rejects before
        // it has read the flags -- one that does not decode -- gets the
        // baseline frame, which ends with the message.
        if (
          hasQueryFlag(queryFlags, QWP_QUERY_FLAG_ERROR_POSITION) &&
          reader.remaining > 0
        ) {
          const position = reader.readInt32("query error position");
          // -1 marks an error that does not point into the SQL text.
          if (position >= 0) error.position = position;
        }
        reader.expectEnd("QUERY_ERROR");
      }
      return error;
    }
    case QWP_EGRESS_MESSAGE.EXEC_DONE: {
      const requestId = reader.readBigUint64("exec request ID");
      const operationType = reader.readUint8("operation type");
      const rowsAffected = readQwpVarint(reader);
      const done: QwpExecDoneMessage = {
        ...header,
        kind: "exec-done",
        requestId,
        operationType,
        rowsAffected,
      };
      if (readTrailers) {
        if (hasQueryFlag(queryFlags, QWP_QUERY_FLAG_STATS)) {
          done.stats = readQueryStats(reader);
        }
        reader.expectEnd("EXEC_DONE");
      }
      return done;
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
