import { describe, it, expect } from "vitest";
import { Category, Policy, classify, defaultPolicyFor } from "../../src/qwp/errors";
import { STATUS } from "../../src/qwp/protocol/response";

describe("error classification", () => {
  it("maps wire statuses to categories", () => {
    expect(classify(STATUS.SCHEMA_MISMATCH)).toBe(Category.SCHEMA_MISMATCH);
    expect(classify(STATUS.DICTIONARY_GAP)).toBe(Category.DICTIONARY_GAP);
    expect(classify(0x7f)).toBe(Category.UNKNOWN);
  });

  it("fails OPEN on an unknown status", () => {
    expect(defaultPolicyFor(Category.UNKNOWN)).toBe(Policy.RETRIABLE);
  });

  it("treats deterministic rejections as terminal", () => {
    for (const c of [Category.SCHEMA_MISMATCH, Category.PARSE_ERROR, Category.SECURITY_ERROR]) {
      expect(defaultPolicyFor(c)).toBe(Policy.TERMINAL);
    }
  });

  it("routes DICTIONARY_GAP to retriable, not terminal", () => {
    expect(defaultPolicyFor(Category.DICTIONARY_GAP)).toBe(Policy.RETRIABLE);
  });

  it("maps NOT_WRITABLE to RETRIABLE_OTHER and DATA_LOSS to ABANDONED", () => {
    expect(defaultPolicyFor(Category.NOT_WRITABLE)).toBe(Policy.RETRIABLE_OTHER);
    expect(defaultPolicyFor(Category.DATA_LOSS)).toBe(Policy.ABANDONED);
  });
});
