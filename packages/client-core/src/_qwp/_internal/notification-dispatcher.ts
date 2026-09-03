import { isPromiseLike } from "./safe-callback";

export interface QwpNotificationDispatcherMetrics {
  readonly pending: number;
  readonly delivered: number;
  readonly dropped: number;
  readonly closing: boolean;
  readonly closed: boolean;
}

/**
 * Browser-safe, bounded callback mailbox.
 *
 * One notification is delivered per event-loop turn so protocol work already
 * queued by the WebSocket is not performed inside user callback stacks. When
 * the inbox fills, the oldest pending notification is discarded and the most
 * recent state is retained, matching the Java QWP dispatchers.
 */
export class QwpNotificationDispatcher<T> {
  private readonly queue: T[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private closePromise?: Promise<void>;
  private resolveClose?: () => void;
  private dispatching = false;
  private closing = false;
  private closed = false;
  private delivered = 0;
  private dropped = 0;

  constructor(
    private readonly handler: (notification: T) => unknown,
    private readonly capacity: number,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError(
        "QWP notification inbox capacity must be a positive safe integer",
      );
    }
  }

  get metrics(): QwpNotificationDispatcherMetrics {
    return Object.freeze({
      pending: this.queue.length,
      delivered: this.delivered,
      dropped: this.dropped,
      closing: this.closing,
      closed: this.closed,
    });
  }

  /** Non-blocking enqueue with drop-oldest overflow. */
  offer(notification: T): boolean {
    if (this.closing || this.closed) return false;
    if (this.queue.length >= this.capacity) {
      this.queue.shift();
      this.dropped++;
    }
    this.queue.push(notification);
    this.schedule();
    return true;
  }

  /**
   * Stops accepting new notifications and best-effort drains the retained
   * tail. Any entries still pending at the deadline are counted as dropped.
   */
  close(drainDeadlineMs = 100): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (!Number.isFinite(drainDeadlineMs) || drainDeadlineMs < 0) {
      return Promise.reject(
        new RangeError(
          "QWP notification drain deadline must be non-negative and finite",
        ),
      );
    }
    this.closing = true;
    this.closePromise = new Promise((resolve) => {
      this.resolveClose = resolve;
    });
    if (this.queue.length === 0 && !this.dispatching) {
      this.finishClose();
      return this.closePromise;
    }
    this.schedule();
    // Deliberately ref'd, unlike the idle timer below. close() resolves only
    // from this timer or from the drain finishing, so unref'ing it made the
    // returned promise unsettleable whenever the QWP client held the last
    // ref'd handle: the loop emptied, neither timer fired, and Node exited
    // with everything sequenced after `await close()` skipped. The wait is
    // bounded by drainDeadlineMs, and close() is an explicit caller action, so
    // holding the loop open for that window is the correct trade.
    this.closeTimer = setTimeout(() => {
      this.closeTimer = undefined;
      this.dropped += this.queue.length;
      this.queue.length = 0;
      if (!this.dispatching) this.finishClose();
    }, drainDeadlineMs);
    return this.closePromise;
  }

  private schedule(): void {
    if (this.timer || this.dispatching || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.dispatchOne();
    }, 0);
    // An idle observer must never hold the process open, but once closing has
    // started this timer is one of the two things that can settle close().
    if (!this.closing) unrefTimer(this.timer);
  }

  private dispatchOne(): void {
    if (this.closed || this.dispatching) return;
    const notification = this.queue.shift();
    if (notification === undefined) {
      if (this.closing) this.finishClose();
      return;
    }
    this.dispatching = true;
    this.delivered++;
    try {
      const result = this.handler(notification);
      if (isPromiseLike(result)) void result.then(undefined, () => undefined);
    } catch {
      // Observability callbacks never participate in protocol progress.
    } finally {
      this.dispatching = false;
    }
    if (this.queue.length > 0) {
      this.schedule();
    } else if (this.closing) {
      this.finishClose();
    }
  }

  private finishClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.timer = undefined;
    this.closeTimer = undefined;
    this.resolveClose?.();
    this.resolveClose = undefined;
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
}
