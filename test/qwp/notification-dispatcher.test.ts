import { describe, expect, it, vi } from "vitest";
import { QwpNotificationDispatcher } from "../../src/_qwp/_internal/notification-dispatcher";

describe("QwpNotificationDispatcher", () => {
  it("delivers outside the protocol call stack in FIFO order", async () => {
    const received: number[] = [];
    const dispatcher = new QwpNotificationDispatcher<number>(
      (value) => received.push(value),
      4,
    );

    dispatcher.offer(1);
    dispatcher.offer(2);
    expect(received).toEqual([]);

    await vi.waitFor(() => expect(received).toEqual([1, 2]));
    expect(dispatcher.metrics).toMatchObject({ delivered: 2, dropped: 0 });
    await dispatcher.close();
  });

  it("drops the oldest pending item and retains the newest tail", async () => {
    const received: number[] = [];
    const dispatcher = new QwpNotificationDispatcher<number>(
      (value) => received.push(value),
      2,
    );

    dispatcher.offer(1);
    dispatcher.offer(2);
    dispatcher.offer(3);

    expect(dispatcher.metrics).toMatchObject({ pending: 2, dropped: 1 });
    await vi.waitFor(() => expect(received).toEqual([2, 3]));
    await dispatcher.close();
  });

  it("contains callback failures and continues dispatching", async () => {
    const received: number[] = [];
    const dispatcher = new QwpNotificationDispatcher<number>((value) => {
      received.push(value);
      if (value === 1) throw new Error("observer failed");
    }, 4);

    dispatcher.offer(1);
    dispatcher.offer(2);
    await vi.waitFor(() => expect(received).toEqual([1, 2]));
    expect(dispatcher.metrics.delivered).toBe(2);
    await dispatcher.close();
  });

  it("contains a rejected promise from an async handler", async () => {
    const rejections: unknown[] = [];
    const listener = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const delivered: number[] = [];
      const dispatcher = new QwpNotificationDispatcher<number>((value) => {
        delivered.push(value);
        // An async observer that rejects must not escape the inbox as an
        // unhandled rejection and terminate the host process.
        return Promise.reject(new Error(`observer ${value} rejected`));
      }, 4);

      dispatcher.offer(1);
      dispatcher.offer(2);
      await vi.waitFor(() => expect(delivered).toEqual([1, 2]));
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(rejections).toEqual([]);
      expect(dispatcher.metrics.delivered).toBe(2);
      await dispatcher.close();
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("drains retained notifications and rejects post-close offers", async () => {
    const received: number[] = [];
    const dispatcher = new QwpNotificationDispatcher<number>(
      (value) => received.push(value),
      4,
    );
    dispatcher.offer(1);
    dispatcher.offer(2);

    await dispatcher.close();
    expect(received).toEqual([1, 2]);
    expect(dispatcher.offer(3)).toBe(false);
    expect(dispatcher.metrics.closed).toBe(true);
  });
});
