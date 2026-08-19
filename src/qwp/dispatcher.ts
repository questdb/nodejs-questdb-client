/**
 * Bounded inbox that drops the OLDEST entry when full (spec 4.2). Watermarks
 * are monotonic, so the newest entry is always the most informative and
 * dropping the head compresses information rather than losing it.
 * The handler is never invoked on the caller's stack.
 */
export class Dispatcher<T> {
  private readonly queue: T[] = [];
  private scheduled = false;
  dropped = 0;

  constructor(
    private readonly capacity: number,
    private readonly handler: (item: T) => void,
  ) {
    if (capacity < 1) throw new Error("capacity must be >= 1");
  }

  offer(item: T): void {
    if (this.queue.length >= this.capacity) {
      this.queue.shift();
      this.dropped++;
    }
    this.queue.push(item);
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => this.drain());
    }
  }

  private drain(): void {
    this.scheduled = false;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        this.handler(item);
      } catch {
        /* a handler must never break the sender */
      }
    }
  }
}
