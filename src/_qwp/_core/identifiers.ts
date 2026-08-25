function isIllegalCommonIdentifierCharacter(
  character: string,
  codeUnit: number,
): boolean {
  if (codeUnit <= 0x0f || codeUnit === 0x7f || codeUnit === 0xfeff) {
    return true;
  }
  switch (character) {
    case "?":
    case ",":
    case "'":
    case '"':
    case "\\":
    case "/":
    case ":":
    case ")":
    case "(":
    case "+":
    case "*":
    case "%":
    case "~":
      return true;
    default:
      return false;
  }
}

/** @internal Applies Java TableUtils table-name rules and UTF-16 length. */
export function validateQwpTableName(
  name: string,
  maxNameLength: number,
): void {
  if (name.length === 0) throw new Error("table name cannot be empty");
  if (name.length > maxNameLength) {
    throw new Error(`table name too long [maxLength=${maxNameLength}]`);
  }
  if (name.charAt(0) === " " || name.charAt(name.length - 1) === " ") {
    throw new Error(`table name contains illegal characters: ${name}`);
  }
  for (let index = 0; index < name.length; index++) {
    const character = name.charAt(index);
    if (
      (character === "." &&
        (index === 0 ||
          index === name.length - 1 ||
          name.charAt(index - 1) === ".")) ||
      isIllegalCommonIdentifierCharacter(character, name.charCodeAt(index))
    ) {
      throw new Error(`table name contains illegal characters: ${name}`);
    }
  }
}

/** @internal Applies Java TableUtils column-name rules and UTF-16 length. */
export function validateQwpColumnName(
  name: string,
  maxNameLength: number,
): void {
  if (name.length === 0) throw new Error("column name cannot be empty");
  if (name.length > maxNameLength) {
    throw new Error(`column name too long [maxLength=${maxNameLength}]`);
  }
  for (let index = 0; index < name.length; index++) {
    const character = name.charAt(index);
    if (
      character === "." ||
      character === "-" ||
      isIllegalCommonIdentifierCharacter(character, name.charCodeAt(index))
    ) {
      throw new Error(`column name contains illegal characters: ${name}`);
    }
  }
}

/**
 * @internal Java's LowerCaseCharSequenceIntHashMap lowercases each UTF-16 code
 * unit independently. Taking the first code unit avoids JavaScript's one
 * expanding lowercase mapping (U+0130) and gives the same simple mapping.
 */
export function qwpColumnNameKey(name: string): string {
  // Fast path: a name of only lower-case-stable code units -- ASCII other than
  // A-Z -- already equals its key, so it is returned without rebuilding. The
  // first upper-case ASCII letter or non-ASCII code unit (which may lower-case
  // or expand) drops to the per-code-unit mapping below, resuming from the
  // stable prefix. This runs once per cell on the ingest path, so the common
  // all-lower-case name skips the character-by-character rebuild entirely.
  let index = 0;
  for (; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code >= 0x80 || (code >= 0x41 && code <= 0x5a)) break;
  }
  if (index === name.length) return name;

  let key = name.slice(0, index);
  for (; index < name.length; index++) {
    const character = name.charAt(index);
    key += character.toLowerCase().charAt(0);
  }
  return key;
}
