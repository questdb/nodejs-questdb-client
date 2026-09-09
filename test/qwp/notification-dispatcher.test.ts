import { describe, expect, it, vi } from "vitest";
import { QwpNotificationDispatcher } from "../../packages/client-core/src/_qwp/_internal/notification-dispatcher";
import {
  QWP_RECONNECT_EVENT_KIND,
  type QwpReconnectEvent,
} from "../../packages/client-core/src/qwp";
import { orphanIngressSessionOptions } from "../../packages/nodejs-client/src/qwp-node/orphan-session-options";

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

  it("holds the event loop open until close() settles", async () => {
    // close() resolves only from its drain deadline or from the drain
    // finishing, and both timers were unref'd. In a process whose only
    // remaining handles belonged to the QWP client -- a batch job, or a
    // SIGTERM shutdown -- the loop then emptied, neither timer fired, and Node
    // exited with the awaited close() never settling: the `finally` blocks,
    // the shutdown log and any process.exitCode after it were all skipped.
    // A single pending notification was enough. vitest's own handles keep the
    // loop alive and so hide the symptom entirely, which is why this asserts
    // the ref state rather than trying to observe the hang.
    const refdTimeouts = (): number =>
      process.getActiveResourcesInfo().filter((kind) => kind === "Timeout")
        .length;

    const baseline = refdTimeouts();
    const dispatcher = new QwpNotificationDispatcher<number>(() => {}, 8);
    dispatcher.offer(1);
    dispatcher.offer(2);
    // An idle observer must still never keep the process alive by itself.
    expect(refdTimeouts()).toBe(baseline);

    const closing = dispatcher.close();
    expect(refdTimeouts()).toBeGreaterThan(baseline);

    await closing;
    expect(dispatcher.metrics.closed).toBe(true);
    expect(refdTimeouts()).toBe(baseline);
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

  it("runs an async observer one notification at a time", async () => {
    // Clearing the in-flight flag when the synchronous prefix returned meant
    // an async observer was re-entered once per event-loop turn however far
    // behind it fell: the queue never held more than one entry, so `capacity`
    // bounded nothing and `dropped` stayed zero. The bound only means
    // something if a slow observer applies backpressure to the inbox.
    let live = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const dispatcher = new QwpNotificationDispatcher<number>(async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise<void>((resolve) => release.push(resolve));
      live--;
    }, 4);

    for (let index = 0; index < 12; index++) dispatcher.offer(index);
    await vi.waitFor(() => expect(live).toBe(1));
    // Give the scheduler several turns to re-enter the handler if it would.
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(peak).toBe(1);
    expect(dispatcher.metrics).toMatchObject({ delivered: 1, dropped: 8 });
    for (const resolve of release.splice(0)) resolve();
    await dispatcher.close();
  });

  it("does not let an unsettled observer hold close() open", async () => {
    // The drain is best-effort and bounded by drainDeadlineMs. Serialising on
    // the handler's promise must not turn an observer that never settles into
    // a close() that never resolves.
    const dispatcher = new QwpNotificationDispatcher<number>(
      () => new Promise<void>(() => undefined),
      4,
    );
    dispatcher.offer(1);
    await vi.waitFor(() => expect(dispatcher.metrics.delivered).toBe(1));

    await expect(dispatcher.close(25)).resolves.toBeUndefined();
    expect(dispatcher.metrics.closed).toBe(true);
  });
});

/**
 * The inbox serializes an `async` observer only when its handler hands the
 * observer's promise back. An orphan-drained slot runs the caller's reconnect
 * observer behind a wrapper that also feeds the drainer's own listener, and
 * that wrapper used to discard both promises: the same callback was then
 * serialized on a foreground session and re-entered on an orphan-drained one,
 * so the behaviour depended on the transport rather than on the caller's code.
 * The inbox bound never engaged there either, because a queue drained on the
 * same turn never reaches its capacity.
 */
describe("orphan-drained reconnect observers", () => {
  const event = {
    kind: QWP_RECONNECT_EVENT_KIND.RECONNECTING,
    attempt: 1,
    timestampMs: 0,
  } as const;

  function gatedObserver() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let live = 0;
    let maxLive = 0;
    let calls = 0;
    const observer = async () => {
      calls++;
      live++;
      maxLive = Math.max(maxLive, live);
      await gate;
      live--;
    };
    return {
      observer,
      release,
      stats: () => ({ calls, maxLive }),
    };
  }

  it("serializes the caller's observer behind the orphan wrapper", async () => {
    const caller = gatedObserver();
    const drainer = gatedObserver();
    const options = orphanIngressSessionOptions(
      { reconnect: { onEvent: caller.observer } },
      drainer.observer,
    );
    const onEvent = (
      options.reconnect as { onEvent: (event: QwpReconnectEvent) => unknown }
    ).onEvent;
    const dispatcher = new QwpNotificationDispatcher<QwpReconnectEvent>(
      onEvent,
      8,
    );

    for (let i = 0; i < 4; i++) dispatcher.offer(event);
    await vi.waitFor(() => expect(caller.stats().calls).toBe(1));
    // Three events are still queued behind the outstanding observer, so the
    // bound is reachable and the drop counter can mean something.
    expect(dispatcher.metrics).toMatchObject({ pending: 3, dropped: 0 });
    expect(drainer.stats().calls).toBe(1);

    caller.release();
    drainer.release();
    await vi.waitFor(() => expect(caller.stats().calls).toBe(4));
    expect(caller.stats().maxLive).toBe(1);
    expect(drainer.stats().maxLive).toBe(1);
    await dispatcher.close();
  });

  it("settles the dispatch when neither observer is asynchronous", async () => {
    const seen: string[] = [];
    const options = orphanIngressSessionOptions(
      { reconnect: { onEvent: () => seen.push("caller") } },
      () => seen.push("drainer"),
    );
    const onEvent = (
      options.reconnect as { onEvent: (event: QwpReconnectEvent) => unknown }
    ).onEvent;
    expect(onEvent(event)).toBeUndefined();
    expect(seen).toEqual(["caller", "drainer"]);
  });

  it("contains a rejecting observer instead of orphaning it", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const options = orphanIngressSessionOptions(
        {
          reconnect: {
            onEvent: async () => {
              throw new Error("observer failed");
            },
          },
        },
        undefined,
      );
      const onEvent = (
        options.reconnect as { onEvent: (event: QwpReconnectEvent) => unknown }
      ).onEvent;
      const dispatcher = new QwpNotificationDispatcher<QwpReconnectEvent>(
        onEvent,
        4,
      );
      dispatcher.offer(event);
      dispatcher.offer(event);
      await vi.waitFor(() =>
        expect(dispatcher.metrics).toMatchObject({ delivered: 2, pending: 0 }),
      );
      await dispatcher.close();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
