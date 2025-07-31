type ArrayPrimitive = "number" | "boolean" | "string" | null;

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

function getDimensions(data: unknown) {
  const dimensions: number[] = [];
  while (Array.isArray(data)) {
    if (data.length === 0) {
      throw new Error("Zero length array not supported");
    }
    dimensions.push(data.length);
    data = data[0];
  }
  return dimensions;
}

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
        `Length of arrays do not match [expected=${expectedLength}, actual=${array.length}, dimensions=[${dimensions}], path=${path}]`,
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
      if (expectedType === null) {
        expectedType = typeof array[0] as ArrayPrimitive;
      }

      for (let i = 0; i < array.length; i++) {
        const currentType = typeof array[i] as ArrayPrimitive;
        if (currentType !== expectedType) {
          throw new Error(
            `Mixed types found [expected=${expectedType}, current=${currentType}, path=${path}[${i}]]`,
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
 * @returns Promise resolving to the parsed JSON data
 * @throws Error if the request fails or returns a non-OK status
 */
async function fetchJson<T>(url: string): Promise<T> {
  let response: globalThis.Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`Failed to load ${url} [error=${error}]`);
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
