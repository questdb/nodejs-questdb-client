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

/**
 * Rejects `target` and `zone` where only ingress would read them.
 *
 * Writes can only land on the primary, which the ingress sweep reaches through
 * the 421 each replica answers the upgrade with, so both keys route query
 * sessions alone. The option types have no such fields; this names the
 * mistake for a JavaScript caller rather than silently dropping a routing
 * request.
 */
export function assertNoQwpIngressRouting(
  options: object | null | undefined,
  spelling: string,
  remedy: string,
): void {
  const fields = options as Record<string, unknown> | null | undefined;
  for (const name of ["target", "zone"] as const) {
    if (fields?.[name] === undefined) continue;
    throw new TypeError(
      `${spelling}${name} is not an ingress option: QuestDB accepts writes on the primary alone, so ${name} routes query sessions only; ${remedy}`,
    );
  }
}
