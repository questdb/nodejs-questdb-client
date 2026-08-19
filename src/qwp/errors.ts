import { STATUS } from "./protocol/response";

export enum Category {
  SCHEMA_MISMATCH = "SCHEMA_MISMATCH",
  PARSE_ERROR = "PARSE_ERROR",
  INTERNAL_ERROR = "INTERNAL_ERROR",
  SECURITY_ERROR = "SECURITY_ERROR",
  WRITE_ERROR = "WRITE_ERROR",
  NOT_WRITABLE = "NOT_WRITABLE",
  DICTIONARY_GAP = "DICTIONARY_GAP",
  PROTOCOL_VIOLATION = "PROTOCOL_VIOLATION",
  DATA_LOSS = "DATA_LOSS",
  UNKNOWN = "UNKNOWN",
}

export enum Policy {
  RETRIABLE = "RETRIABLE",
  RETRIABLE_OTHER = "RETRIABLE_OTHER",
  TERMINAL = "TERMINAL",
  ABANDONED = "ABANDONED",
}

export class SenderError extends Error {
  constructor(
    readonly category: Category,
    readonly policy: Policy,
    message: string,
    readonly serverStatus = -1,
    readonly fromFsn = -1,
    readonly toFsn = -1,
    readonly quarantinedPath?: string,
  ) {
    super(message);
    this.name = "SenderError";
  }
}

export function classify(status: number): Category {
  switch (status) {
    case STATUS.SCHEMA_MISMATCH: return Category.SCHEMA_MISMATCH;
    case STATUS.PARSE_ERROR: return Category.PARSE_ERROR;
    case STATUS.INTERNAL_ERROR: return Category.INTERNAL_ERROR;
    case STATUS.SECURITY_ERROR: return Category.SECURITY_ERROR;
    case STATUS.WRITE_ERROR: return Category.WRITE_ERROR;
    case STATUS.NOT_WRITABLE: return Category.NOT_WRITABLE;
    case STATUS.DICTIONARY_GAP: return Category.DICTIONARY_GAP;
    default: return Category.UNKNOWN;
  }
}

/**
 * There is no drop policy. UNKNOWN fails OPEN so a status byte from a newer
 * server degrades to a retry rather than a dead sender (spec 7.3).
 */
export function defaultPolicyFor(c: Category): Policy {
  switch (c) {
    case Category.WRITE_ERROR:
    case Category.INTERNAL_ERROR:
    case Category.DICTIONARY_GAP:
    case Category.UNKNOWN:
      return Policy.RETRIABLE;
    case Category.NOT_WRITABLE:
      return Policy.RETRIABLE_OTHER;
    case Category.DATA_LOSS:
      return Policy.ABANDONED;
    default:
      return Policy.TERMINAL;
  }
}
