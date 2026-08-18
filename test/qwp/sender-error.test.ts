import { describe, expect, it } from "vitest";
import {
  createQwpDataLossSenderError,
  createQwpSenderError,
  QWP_SENDER_ERROR_CATEGORY,
  QWP_SENDER_ERROR_POLICY,
  QWP_STATUS,
} from "../../src/qwp";

describe("QWP typed sender errors", () => {
  it.each([
    [
      QWP_STATUS.SCHEMA_MISMATCH,
      QWP_SENDER_ERROR_CATEGORY.SCHEMA_MISMATCH,
      QWP_SENDER_ERROR_POLICY.TERMINAL,
    ],
    [
      QWP_STATUS.PARSE_ERROR,
      QWP_SENDER_ERROR_CATEGORY.PARSE_ERROR,
      QWP_SENDER_ERROR_POLICY.TERMINAL,
    ],
    [
      QWP_STATUS.INTERNAL_ERROR,
      QWP_SENDER_ERROR_CATEGORY.INTERNAL_ERROR,
      QWP_SENDER_ERROR_POLICY.RETRIABLE,
    ],
    [
      QWP_STATUS.SECURITY_ERROR,
      QWP_SENDER_ERROR_CATEGORY.SECURITY_ERROR,
      QWP_SENDER_ERROR_POLICY.TERMINAL,
    ],
    [
      QWP_STATUS.WRITE_ERROR,
      QWP_SENDER_ERROR_CATEGORY.WRITE_ERROR,
      QWP_SENDER_ERROR_POLICY.RETRIABLE,
    ],
    [
      QWP_STATUS.NOT_WRITABLE,
      QWP_SENDER_ERROR_CATEGORY.NOT_WRITABLE,
      QWP_SENDER_ERROR_POLICY.RETRIABLE_OTHER,
    ],
    [
      QWP_STATUS.DICTIONARY_GAP,
      QWP_SENDER_ERROR_CATEGORY.DICTIONARY_GAP,
      QWP_SENDER_ERROR_POLICY.RETRIABLE,
    ],
    [
      0xfe,
      QWP_SENDER_ERROR_CATEGORY.UNKNOWN,
      QWP_SENDER_ERROR_POLICY.RETRIABLE,
    ],
  ])("maps status 0x%s to %s / %s", (status, category, appliedPolicy) => {
    const error = createQwpSenderError(
      {
        status,
        sequence: 7n,
        tables: [{ name: "trades", sequenceTransaction: 11n }],
        errorMessage: "rejected",
      },
      { fromFsn: 41n, toFsn: 43n },
    );

    expect(error).toMatchObject({
      category,
      appliedPolicy,
      serverStatusByte: status,
      serverMessage: "rejected",
      messageSequence: 7n,
      fromFsn: 41n,
      toFsn: 43n,
      tableName: "trades",
    });
    expect(Object.isFrozen(error)).toBe(true);
  });

  it("reports abandoned bytes with their quarantine path", () => {
    expect(
      createQwpDataLossSenderError("corrupt journal", "/qwp/slot.bad"),
    ).toMatchObject({
      category: QWP_SENDER_ERROR_CATEGORY.DATA_LOSS,
      appliedPolicy: QWP_SENDER_ERROR_POLICY.ABANDONED,
      serverMessage: "corrupt journal",
      quarantinedPath: "/qwp/slot.bad",
    });
  });
});
