export const QWP_ZSTD_MIN_COMPRESSION_LEVEL = 1;
export const QWP_ZSTD_MAX_COMPRESSION_LEVEL = 22;

export type QwpEgressCompression = "raw" | "zstd" | "auto";

export type QwpNegotiatedEgressCompression =
  | {
      readonly codec: "raw";
      readonly level: 0;
    }
  | {
      readonly codec: "zstd";
      readonly level: number;
    }
  | {
      readonly codec: "unknown";
      readonly level: 0;
      readonly contentEncoding: string;
    };

/** Builds the Node upgrade header for an egress compression preference. */
export function encodeQwpAcceptEncoding(
  preference: QwpEgressCompression,
  level = QWP_ZSTD_MIN_COMPRESSION_LEVEL,
): string | undefined {
  if (preference !== "raw" && preference !== "zstd" && preference !== "auto") {
    throw new RangeError("compression must be one of raw, zstd, or auto");
  }
  if (
    !Number.isSafeInteger(level) ||
    level < QWP_ZSTD_MIN_COMPRESSION_LEVEL ||
    level > QWP_ZSTD_MAX_COMPRESSION_LEVEL
  ) {
    throw new RangeError(
      `compressionLevel must be an integer between ${QWP_ZSTD_MIN_COMPRESSION_LEVEL} and ${QWP_ZSTD_MAX_COMPRESSION_LEVEL}`,
    );
  }
  return preference === "raw" ? undefined : `zstd;level=${level},raw`;
}

/**
 * Parses the server's `X-QWP-Content-Encoding` response. Unknown values remain
 * observable but do not claim that Zstd was negotiated; RESULT_BATCH flags
 * remain authoritative for each individual batch.
 */
export function decodeQwpContentEncoding(
  value: string | undefined,
): QwpNegotiatedEgressCompression {
  const contentEncoding = value?.trim();
  if (!contentEncoding) return { codec: "raw", level: 0 };
  if (/^(?:raw|identity)$/i.test(contentEncoding)) {
    return { codec: "raw", level: 0 };
  }

  const match = /^zstd\s*;\s*level\s*=\s*(\d+)$/i.exec(contentEncoding);
  if (match) {
    const level = Number(match[1]);
    if (Number.isSafeInteger(level) && level > 0) {
      return { codec: "zstd", level };
    }
  }
  return { codec: "unknown", level: 0, contentEncoding };
}
