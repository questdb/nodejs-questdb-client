type TimestampUnit = "ns" | "us" | "ms";

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isInteger(value: unknown, lowerBound: number): value is number {
  return (
      typeof value === "number" && Number.isInteger(value) && value >= lowerBound
  );
}

function timestampToMicros(timestamp: bigint, unit: TimestampUnit) {
  switch (unit) {
    case "ns":
      return timestamp / 1000n;
    case "us":
      return timestamp;
    case "ms":
      return timestamp * 1000n;
    default:
      throw new Error(`Unknown timestamp unit: ${unit}`);
  }
}

function timestampToNanos(timestamp: bigint, unit: TimestampUnit) {
  switch (unit) {
    case "ns":
      return timestamp;
    case "us":
      return timestamp * 1000n;
    case "ms":
      return timestamp * 1000_000n;
    default:
      throw new Error(`Unknown timestamp unit: ${unit}`);
  }
}

export { isBoolean, isInteger, timestampToMicros, timestampToNanos, TimestampUnit };
