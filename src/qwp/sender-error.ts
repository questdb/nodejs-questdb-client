import { QWP_STATUS, type QwpIngressResponse } from "./core";

export const QWP_SENDER_ERROR_CATEGORY = {
  SCHEMA_MISMATCH: "schema-mismatch",
  PARSE_ERROR: "parse-error",
  INTERNAL_ERROR: "internal-error",
  SECURITY_ERROR: "security-error",
  WRITE_ERROR: "write-error",
  NOT_WRITABLE: "not-writable",
  DICTIONARY_GAP: "dictionary-gap",
  PROTOCOL_VIOLATION: "protocol-violation",
  DATA_LOSS: "data-loss",
  UNKNOWN: "unknown",
} as const;

export type QwpSenderErrorCategory =
  (typeof QWP_SENDER_ERROR_CATEGORY)[keyof typeof QWP_SENDER_ERROR_CATEGORY];

export const QWP_SENDER_ERROR_POLICY = {
  RETRIABLE: "retriable",
  RETRIABLE_OTHER: "retriable-other",
  TERMINAL: "terminal",
  ABANDONED: "abandoned",
} as const;

export type QwpSenderErrorPolicy =
  (typeof QWP_SENDER_ERROR_POLICY)[keyof typeof QWP_SENDER_ERROR_POLICY];

/** Immutable Java-parity context for an ingress rejection or data loss. */
export interface QwpSenderError {
  readonly category: QwpSenderErrorCategory;
  readonly appliedPolicy: QwpSenderErrorPolicy;
  readonly serverStatusByte?: number;
  readonly serverMessage?: string;
  readonly messageSequence?: bigint;
  /** Inclusive stable store-and-forward frame-sequence range. */
  readonly fromFsn?: bigint;
  readonly toFsn?: bigint;
  readonly tableName?: string;
  readonly detectedAtMs: number;
  /** Preserved on-disk bytes for a data-loss/quarantine notification. */
  readonly quarantinedPath?: string;
}

export interface QwpSenderErrorResponseContext {
  readonly appliedPolicy?: QwpSenderErrorPolicy;
  readonly messageSequence?: bigint;
  readonly fromFsn?: bigint;
  readonly toFsn?: bigint;
  readonly tableName?: string;
  readonly detectedAtMs?: number;
}

export function createQwpSenderError(
  response: QwpIngressResponse,
  context: QwpSenderErrorResponseContext = {},
): QwpSenderError {
  const category = qwpSenderErrorCategory(response.status);
  const sequence = response.sequence ?? undefined;
  const fromFsn = context.fromFsn ?? sequence;
  return Object.freeze({
    category,
    appliedPolicy:
      context.appliedPolicy ?? qwpDefaultSenderErrorPolicy(category),
    serverStatusByte: response.status,
    serverMessage: response.errorMessage,
    messageSequence: context.messageSequence ?? sequence,
    fromFsn,
    toFsn: context.toFsn ?? fromFsn,
    tableName:
      context.tableName ??
      (response.tables.length === 1 ? response.tables[0].name : undefined),
    detectedAtMs: context.detectedAtMs ?? Date.now(),
  });
}

export function createQwpProtocolViolationSenderError(
  message: string,
  fromFsn?: bigint,
  toFsn = fromFsn,
): QwpSenderError {
  return Object.freeze({
    category: QWP_SENDER_ERROR_CATEGORY.PROTOCOL_VIOLATION,
    appliedPolicy: QWP_SENDER_ERROR_POLICY.TERMINAL,
    serverMessage: message,
    fromFsn,
    toFsn,
    detectedAtMs: Date.now(),
  });
}

export function createQwpDataLossSenderError(
  message: string,
  quarantinedPath: string,
): QwpSenderError {
  return Object.freeze({
    category: QWP_SENDER_ERROR_CATEGORY.DATA_LOSS,
    appliedPolicy: QWP_SENDER_ERROR_POLICY.ABANDONED,
    serverMessage: message,
    detectedAtMs: Date.now(),
    quarantinedPath,
  });
}

export function qwpSenderErrorCategory(status: number): QwpSenderErrorCategory {
  switch (status) {
    case QWP_STATUS.SCHEMA_MISMATCH:
      return QWP_SENDER_ERROR_CATEGORY.SCHEMA_MISMATCH;
    case QWP_STATUS.PARSE_ERROR:
      return QWP_SENDER_ERROR_CATEGORY.PARSE_ERROR;
    case QWP_STATUS.INTERNAL_ERROR:
      return QWP_SENDER_ERROR_CATEGORY.INTERNAL_ERROR;
    case QWP_STATUS.SECURITY_ERROR:
      return QWP_SENDER_ERROR_CATEGORY.SECURITY_ERROR;
    case QWP_STATUS.WRITE_ERROR:
      return QWP_SENDER_ERROR_CATEGORY.WRITE_ERROR;
    case QWP_STATUS.NOT_WRITABLE:
      return QWP_SENDER_ERROR_CATEGORY.NOT_WRITABLE;
    case QWP_STATUS.DICTIONARY_GAP:
      return QWP_SENDER_ERROR_CATEGORY.DICTIONARY_GAP;
    default:
      return QWP_SENDER_ERROR_CATEGORY.UNKNOWN;
  }
}

export function qwpDefaultSenderErrorPolicy(
  category: QwpSenderErrorCategory,
): QwpSenderErrorPolicy {
  switch (category) {
    case QWP_SENDER_ERROR_CATEGORY.WRITE_ERROR:
    case QWP_SENDER_ERROR_CATEGORY.INTERNAL_ERROR:
    case QWP_SENDER_ERROR_CATEGORY.DICTIONARY_GAP:
    case QWP_SENDER_ERROR_CATEGORY.UNKNOWN:
      return QWP_SENDER_ERROR_POLICY.RETRIABLE;
    case QWP_SENDER_ERROR_CATEGORY.NOT_WRITABLE:
      return QWP_SENDER_ERROR_POLICY.RETRIABLE_OTHER;
    case QWP_SENDER_ERROR_CATEGORY.DATA_LOSS:
      return QWP_SENDER_ERROR_POLICY.ABANDONED;
    default:
      return QWP_SENDER_ERROR_POLICY.TERMINAL;
  }
}
