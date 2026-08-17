interface PendingNext<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
}

/** Single-consumer async queue used to preserve WebSocket message ordering. */
export class QwpAsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
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
      this.values.push(value);
    }
  }

  end(): void {
    if (this.ended || this.failure !== undefined) return;
    this.ended = true;
    for (const pending of this.pending.splice(0)) {
      pending.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.ended || this.failure !== undefined) return;
    this.failure = error;
    for (const pending of this.pending.splice(0)) pending.reject(error);
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
    const value = this.values.shift();
    if (value !== undefined) {
      return Promise.resolve({ value, done: false });
    }
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.ended) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }
}
