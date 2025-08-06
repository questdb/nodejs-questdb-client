import { Agent } from "undici";

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
};
