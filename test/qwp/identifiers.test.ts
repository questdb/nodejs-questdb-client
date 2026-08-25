import { describe, expect, it } from "vitest";
import { qwpColumnNameKey } from "../../src/_qwp/_core/identifiers";

/**
 * The pre-optimization reference: lower-case each UTF-16 code unit
 * independently and keep only its first code unit. The all-lower-case-ASCII
 * fast path must produce byte-identical keys to this for every input, or two
 * spellings of one column would stop colliding on the same case-insensitive
 * key.
 */
function referenceKey(name: string): string {
  let key = "";
  for (let index = 0; index < name.length; index++) {
    key += name.charAt(index).toLowerCase().charAt(0);
  }
  return key;
}

describe("qwpColumnNameKey", () => {
  it("returns a lower-case-stable ASCII name unchanged", () => {
    for (const name of ["value", "a", "col_1", "trade99", ""]) {
      expect(qwpColumnNameKey(name)).toBe(name);
    }
  });

  it("matches the per-code-unit reference across mixed inputs", () => {
    const cases = [
      "value",
      "Value",
      "VALUE",
      "vAlUe",
      "abcDef", // resumes mapping only at the first upper-case letter
      "MixedCase123",
      "UPPER_lower",
      "Ünïcøde", // non-ASCII letters, already lower-case
      "Æß", // non-ASCII upper-case that lower-cases
      "SMILE😀SMILE", // a surrogate pair mid-string
      "  Spaced Name  ",
      "0123456789",
      "!@#$%^&*()",
      "",
    ];
    for (const name of cases) {
      expect(qwpColumnNameKey(name), name).toBe(referenceKey(name));
    }
  });

  it("keeps a case-insensitive key stable across spellings", () => {
    const key = qwpColumnNameKey("Value");
    expect(qwpColumnNameKey("value")).toBe(key);
    expect(qwpColumnNameKey("VALUE")).toBe(key);
    expect(qwpColumnNameKey("vAlUe")).toBe(key);
  });

  it("takes only the first code unit of an expanding lower-case (U+0130)", () => {
    // JS lower-cases 'İ' to 'i' + combining dot above; the key keeps just 'i'.
    expect(qwpColumnNameKey("İ")).toBe("i");
    expect(qwpColumnNameKey("İ")).toHaveLength(1);
  });
});
