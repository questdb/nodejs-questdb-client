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
  let key = "";
  for (let index = 0; index < name.length; index++) {
    const character = name.charAt(index);
    key += character.toLowerCase().charAt(0);
  }
  return key;
}
