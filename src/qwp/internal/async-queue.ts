interface PendingNext<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
}

interface QueueBarrier {
  readonly kind: "barrier";
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface QueueValue<T> {
  readonly kind: "value";
  readonly value: T;
}

/** Single-consumer async queue used to preserve WebSocket message ordering. */
export class QwpAsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: (QueueValue<T> | QueueBarrier)[] = [];
  private readonly pending: PendingNext<T>[] = [];
  private ended = false;
  private failure: unknown;
  private iteratorCreated = false;

  push(value: T): void {
    if (this.ended || this.failure !== undefined) return;
    const pending = this.pending.shift();
    if (pending) {
      pending.resolve({ value, done: false });
    } else {
      this.values.push({ kind: "value", value });
    }
  }

  end(): void {
    if (this.ended || this.failure !== undefined) return;
    this.ended = true;
    this.settleBarriers();
    for (const pending of this.pending.splice(0)) {
      pending.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.ended || this.failure !== undefined) return;
    this.failure = error;
    this.settleBarriers(error);
    for (const pending of this.pending.splice(0)) pending.reject(error);
  }

  /** Drops values not yet handed to the single consumer. */
  clear(): void {
    for (const entry of this.values.splice(0)) {
      if (entry.kind === "barrier") entry.resolve();
    }
  }

  /** Resolves once the consumer asks for the item after this queue position. */
  barrier(): Promise<void> {
    if (this.ended || this.failure !== undefined || this.pending.length > 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.values.push({ kind: "barrier", resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.iteratorCreated) {
      throw new Error("QWP message streams support only one consumer");
    }
    this.iteratorCreated = true;
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<T>> {
    while (true) {
      const entry = this.values.shift();
      if (!entry) break;
      if (entry.kind === "value") {
        return Promise.resolve({ value: entry.value, done: false });
      }
      entry.resolve();
    }
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.ended) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  private settleBarriers(error?: unknown): void {
    const entries = this.values.splice(0);
    for (const entry of entries) {
      if (entry.kind === "value") {
        this.values.push(entry);
      } else if (error === undefined) {
        entry.resolve();
      } else {
        entry.reject(error);
      }
    }
  }
}
