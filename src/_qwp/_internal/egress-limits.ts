import { QWP_MAX_BATCH_ROWS_UPPER_BOUND } from "../_core";

export function validateQwpMaxBatchRows(
  value: number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > QWP_MAX_BATCH_ROWS_UPPER_BOUND
  ) {
    throw new RangeError(
      `maxBatchRows must be an integer between 1 and ${QWP_MAX_BATCH_ROWS_UPPER_BOUND}`,
    );
  }
  return value;
}
