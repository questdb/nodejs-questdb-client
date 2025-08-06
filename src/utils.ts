import { Agent } from "undici";

/**
 * Primitive types for QuestDB arrays. <br>
 * Currently only <i>number</i> arrays are supported by the server.
 */
type ArrayPrimitive = "number" | "boolean" | "string" | null;

/**
 * Supported timestamp units for QuestDB operations.
 */
type TimestampUnit = "ns" | "us" | "ms";

/**
 * Type guard to check if a value is a boolean.
 * @param value - The value to check
 * @returns True if the value is a boolean, false otherwise
 */
function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Type guard to check if a value is an integer within specified bounds.
 * @param value - The value to check
 * @param lowerBound - The minimum allowed value (inclusive)
 * @returns True if the value is an integer >= lowerBound, false otherwise
 */
function isInteger(value: unknown, lowerBound: number): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= lowerBound
  );
}

/**
 * Converts a timestamp from the specified unit to microseconds.
 * @param timestamp - The timestamp value as a bigint
 * @param unit - The source timestamp unit
 * @returns The timestamp converted to microseconds
 * @throws Error if the timestamp unit is unknown
 */
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

/**
 * Converts a timestamp from the specified unit to nanoseconds.
 * @param timestamp - The timestamp value as a bigint
 * @param unit - The source timestamp unit
 * @returns The timestamp converted to nanoseconds
 * @throws Error if the timestamp unit is unknown
 */
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

/**
 * Analyzes the dimensions of a nested array structure.
 * @param data - The array to analyze
 * @returns Array of dimension sizes at each nesting level
 * @throws Error if any dimension has zero length
 */
function getDimensions(data: unknown) {
  const dimensions: number[] = [];
  while (Array.isArray(data)) {
    dimensions.push(data.length);
    data = data[0];
  }
  return dimensions;
}

/**
 * Validates an array structure. <br>
 * Validation fails if:
 * - <i>data</i> is not an array
 * - the array is irregular: the length of its sub-arrays are different
 *  - the array is not homogenous: the array contains mixed types
 * @param data - The array to validate
 * @param dimensions - The shape of the array
 * @returns The primitive type of the array's elements
 * @throws Error if the validation fails
 */
function validateArray(data: unknown[], dimensions: number[]): ArrayPrimitive {
  if (data === null || data === undefined) {
    return null;
  }
  if (!Array.isArray(data)) {
    throw new Error(
      `The value must be an array [value=${JSON.stringify(data)}, type=${typeof data}]`,
    );
  }

  let expectedType: ArrayPrimitive = null;

  function checkArray(
    array: unknown[],
    depth: number = 0,
    path: string = "",
  ): void {
    const expectedLength = dimensions[depth];
    if (array.length !== expectedLength) {
      throw new Error(
        `Lengths of sub-arrays do not match [expected=${expectedLength}, actual=${array.length}, dimensions=[${dimensions}], path=${path}]`,
      );
    }

    if (depth < dimensions.length - 1) {
      // intermediate level, expecting arrays
      for (let i = 0; i < array.length; i++) {
        if (!Array.isArray(array[i])) {
          throw new Error(
            `Mixed types found [expected=array, current=${typeof array[i]}, path=${path}[${i}]]`,
          );
        }
        checkArray(array[i] as unknown[], depth + 1, `${path}[${i}]`);
      }
    } else {
      // leaf level, expecting primitives
      if (expectedType === null && array[0] !== undefined) {
        expectedType = typeof array[0] as ArrayPrimitive;
      }

      for (let i = 0; i < array.length; i++) {
        const currentType = typeof array[i] as ArrayPrimitive;
        if (currentType !== expectedType) {
          throw new Error(
            expectedType !== null
              ? `Mixed types found [expected=${expectedType}, current=${currentType}, path=${path}[${i}]]`
              : `Unsupported array type [type=${currentType}]`,
          );
        }
      }
    }
  }

  checkArray(data);
  return expectedType;
}

/**
 * Fetches JSON data from a URL.
 * @template T - The expected type of the JSON response
 * @param url - The URL to fetch from
 * @param agent - HTTP agent to be used for the request
 * @param timeout - Request timeout, query will be aborted if not finished in time
 * @returns Promise resolving to the parsed JSON data
 * @throws Error if the request fails or returns a non-OK status
 */
async function fetchJson<T>(
  url: string,
  timeout: number,
  agent: Agent,
): Promise<T> {
  const controller = new AbortController();
  const { signal } = controller;
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      dispatcher: agent,
      signal,
    });
  } catch (error) {
    throw new Error(`Failed to load ${url} [error=${error}]`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(
      `Failed to load ${url} [statusCode=${response.status} (${response.statusText})]`,
    );
  }
  return (await response.json()) as T;
}

export {
  isBoolean,
  isInteger,
  timestampToMicros,
  timestampToNanos,
  TimestampUnit,
  fetchJson,
  getDimensions,
  validateArray,
  ArrayPrimitive,
};
