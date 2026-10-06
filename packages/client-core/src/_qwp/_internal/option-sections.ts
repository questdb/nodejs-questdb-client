/**
 * Rejects an unknown key on an object whose keys name option sections.
 *
 * A misnamed section -- or one from an earlier shape of these options -- would
 * otherwise be skipped whole, and every setting inside it with it, without a
 * word. TypeScript rejects such a key at compile time; this tells a JavaScript
 * caller, or one past a cast.
 */
export function assertKnownQwpOptionSections(
  owner: string,
  options: object | null | undefined,
  sections: readonly string[],
): void {
  if (options === undefined || options === null) return;
  for (const key of Object.keys(options)) {
    if (!sections.includes(key)) {
      throw new TypeError(
        `unknown ${owner} section '${key}'; expected one of ${sections
          .map((name) => `'${name}'`)
          .join(", ")}`,
      );
    }
  }
}
