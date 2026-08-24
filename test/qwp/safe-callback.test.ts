import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPromiseLike,
  safelyInvoke,
} from "../../src/_qwp/_internal/safe-callback";

/**
 * Runs `body`, then waits long enough for Node to surface any orphaned
 * rejection, and returns the reasons of every `unhandledRejection` seen in the
 * window. An empty array proves a rejection handler was attached synchronously
 * -- the exact thing that keeps an async observability callback from
 * terminating the host process (Node >= 15 exits on unhandled rejection).
 */
async function unhandledRejectionsDuring(
  body: () => void,
  settleMs = 25,
): Promise<unknown[]> {
  const reasons: unknown[] = [];
  const listener = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on("unhandledRejection", listener);
  try {
    body();
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  } finally {
    process.off("unhandledRejection", listener);
  }
  return reasons;
}

describe("safelyInvoke", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is a no-op for an absent callback", async () => {
    const onFailure = vi.fn();
    const seen = await unhandledRejectionsDuring(() => {
      safelyInvoke(undefined, "event", onFailure);
    });
    expect(seen).toEqual([]);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("delivers the event to a well-behaved callback", () => {
    const received: string[] = [];
    safelyInvoke((event: string) => received.push(event), "payload");
    expect(received).toEqual(["payload"]);
  });

  it("contains a synchronous throw and reports it", () => {
    const boom = new Error("sync observer failed");
    const onFailure = vi.fn();
    expect(() =>
      safelyInvoke(
        () => {
          throw boom;
        },
        undefined,
        onFailure,
      ),
    ).not.toThrow();
    expect(onFailure).toHaveBeenCalledWith(boom);
  });

  it("contains a rejected promise from an async callback without crashing", async () => {
    const boom = new Error("async observer rejected");
    const onFailure = vi.fn();
    const seen = await unhandledRejectionsDuring(() => {
      safelyInvoke(() => Promise.reject(boom), undefined, onFailure);
    });
    expect(seen).toEqual([]);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(boom);
  });

  it("leaves a resolving async callback alone", async () => {
    const onFailure = vi.fn();
    const seen = await unhandledRejectionsDuring(() => {
      safelyInvoke(() => Promise.resolve("done"), undefined, onFailure);
    });
    expect(seen).toEqual([]);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("swallows a throwing failure handler on the synchronous path", () => {
    expect(() =>
      safelyInvoke(
        () => {
          throw new Error("callback");
        },
        undefined,
        () => {
          throw new Error("fallback also failed");
        },
      ),
    ).not.toThrow();
  });

  it("swallows a throwing failure handler on the async path", async () => {
    const seen = await unhandledRejectionsDuring(() => {
      safelyInvoke(
        () => Promise.reject(new Error("callback rejected")),
        undefined,
        () => {
          throw new Error("fallback also failed");
        },
      );
    });
    expect(seen).toEqual([]);
  });

  it("ignores a non-thenable return value", () => {
    const onFailure = vi.fn();
    expect(() => safelyInvoke(() => 42, undefined, onFailure)).not.toThrow();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("contains a foreign thenable that rejects", async () => {
    const boom = new Error("thenable rejected");
    const onFailure = vi.fn();
    const seen = await unhandledRejectionsDuring(() => {
      // A bare thenable that exposes only `then`, not `catch`.
      const thenable = {
        then(_onFulfilled: unknown, onRejected: (reason: unknown) => void) {
          onRejected(boom);
        },
      };
      safelyInvoke(() => thenable, undefined, onFailure);
    });
    expect(seen).toEqual([]);
    expect(onFailure).toHaveBeenCalledWith(boom);
  });
});

describe("isPromiseLike", () => {
  it("accepts native promises and bare thenables", () => {
    expect(isPromiseLike(Promise.resolve().catch(() => undefined))).toBe(true);
    expect(isPromiseLike({ then: () => undefined })).toBe(true);
  });

  it("rejects non-thenables", () => {
    expect(isPromiseLike(null)).toBe(false);
    expect(isPromiseLike(undefined)).toBe(false);
    expect(isPromiseLike(42)).toBe(false);
    expect(isPromiseLike({})).toBe(false);
    expect(isPromiseLike({ then: 1 })).toBe(false);
  });
});
