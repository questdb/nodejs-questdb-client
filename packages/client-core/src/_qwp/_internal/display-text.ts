/** Upper bound, in UTF-16 code units, on server text once sanitized. */
export const QWP_MAX_DISPLAY_TEXT_LENGTH = 256;

const TRUNCATION_MARKER = "...";

/**
 * Code points that must not reach an error message or a log line raw: C0 and
 * C1 controls, CR and LF among them, format characters (bidirectional
 * overrides and isolates, zero-width joiners, the BOM), lone surrogates, and
 * the Unicode line and paragraph separators. The same set the Java client's
 * `DisplaySafe` rejects.
 */
const UNSAFE_FOR_DISPLAY = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

/**
 * Prepares text a server, or a proxy in front of it, wrote -- the body of a
 * rejected upgrade, a header it echoed -- for an error message: removes every
 * code point that could forge or hide what a reader sees, and caps the result
 * at {@link QWP_MAX_DISPLAY_TEXT_LENGTH} characters, ending in `...` when it
 * had to cut. Mirrors the Java client's `CredentialRedaction.sanitizeErrorText`.
 *
 * It cannot remove a secret the text already carries.
 */
export function sanitizeQwpDisplayText(text: string): string {
  const safe = text.replace(UNSAFE_FOR_DISPLAY, "");
  if (safe.length <= QWP_MAX_DISPLAY_TEXT_LENGTH) return safe;
  const budget = QWP_MAX_DISPLAY_TEXT_LENGTH - TRUNCATION_MARKER.length;
  let cut = "";
  // By code point, so a surrogate pair is never split.
  for (const codePoint of safe) {
    if (cut.length + codePoint.length > budget) break;
    cut += codePoint;
  }
  return cut + TRUNCATION_MARKER;
}
