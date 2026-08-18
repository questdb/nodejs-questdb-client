import {
  QwpEgressQuery,
  QwpEgressQueryOptions,
  QwpEgressSession,
} from "./egress-session";
import { QwpSender } from "./sender";
import { QwpHandshakeMetadata } from "./transport";
import type {
  QwpNegotiatedEgressCompression,
  QwpServerInfoMessage,
} from "./core";

const DEFAULT_POOL_MIN = 1;
const DEFAULT_POOL_MAX = 4;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;
const MAX_CLOSE_CREATION_WAIT_MS = 5_000;

export interface QwpClientPoolOptions {
  /** Warm ingress connections created by connect(). Defaults to 1. */
  senderPoolMin?: number;
  /** Maximum concurrently borrowed ingress senders. Defaults to 4. */
  senderPoolMax?: number;
  /** Warm egress connections created by connect(). Defaults to 1. */
  queryPoolMin?: number;
  /** Maximum concurrently borrowed query connections. Defaults to 4. */
  queryPoolMax?: number;
  /** Maximum wait for a returned pool slot. Defaults to 5 seconds. */
  acquireTimeoutMs?: number;
}

export interface QwpClientFactories {
  createSender(slot: number): Promise<QwpSender>;
  createQuerySession(slot: number): Promise<QwpEgressSession>;
  /** @internal Starts runtime-specific background services on first use. */
  start?(): void | Promise<void>;
  /** @internal Stops runtime-specific background services during close. */
  close?(): void | Promise<void>;
}

export interface QwpResourcePoolMetrics {
  readonly minimum: number;
  readonly maximum: number;
  readonly total: number;
  readonly available: number;
  readonly leased: number;
  readonly creating: number;
  readonly waiting: number;
}

export interface QwpClientMetrics {
  readonly senders: QwpResourcePoolMetrics;
  readonly queries: QwpResourcePoolMetrics;
  readonly closing: boolean;
  readonly closed: boolean;
}

/** A bounded QWP pool could not provide a connection before its deadline. */
export class QwpPoolAcquireTimeoutError extends Error {
  constructor(
    readonly resource: "sender" | "query",
    readonly timeoutMs: number,
  ) {
    super(
      `timed out waiting for a QWP ${resource} from the pool after ${timeoutMs}ms`,
    );
    this.name = "QwpPoolAcquireTimeoutError";
  }
}

/** A pooled resource failed while a new slot was being connected. */
export class QwpPoolResourceError extends Error {
  readonly cause: unknown;

  constructor(
    readonly resource: "sender" | "query",
    cause: unknown,
  ) {
    super(
      `failed to create pooled QWP ${resource}${
        cause instanceof Error ? `: ${cause.message}` : ""
      }`,
    );
    this.name = "QwpPoolResourceError";
    this.cause = cause;
  }
}

/** The owning QWP client, or one of its returned lease handles, is closed. */
export class QwpClientClosedError extends Error {
  constructor(message = "QWP client is closed") {
    super(message);
    this.name = "QwpClientClosedError";
  }
}

interface ValidatedPoolOptions {
  readonly senderPoolMin: number;
  readonly senderPoolMax: number;
  readonly queryPoolMin: number;
  readonly queryPoolMax: number;
  readonly acquireTimeoutMs: number;
}

interface PoolEntry<T> {
  readonly slot: number;
  readonly value: T;
  leased: boolean;
  destroyPromise?: Promise<void>;
}

interface PoolWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
}

class QwpResourcePool<T> {
  private readonly all = new Map<number, PoolEntry<T>>();
  private readonly available: PoolEntry<T>[] = [];
  private readonly creatingSlots = new Set<number>();
  private readonly creationOperations = new Set<Promise<void>>();
  private readonly waiters = new Set<PoolWaiter>();
  private closePromise?: Promise<void>;
  private closed = false;

  constructor(
    private readonly resource: "sender" | "query",
    private readonly minimum: number,
    private readonly maximum: number,
    private readonly acquireTimeoutMs: number,
    private readonly createResource: (slot: number) => Promise<T>,
    private readonly destroyResource: (resource: T) => Promise<void>,
  ) {}

  get metrics(): QwpResourcePoolMetrics {
    return Object.freeze({
      minimum: this.minimum,
      maximum: this.maximum,
      total: this.all.size,
      available: this.available.length,
      leased: Array.from(this.all.values()).filter((entry) => entry.leased)
        .length,
      creating: this.creatingSlots.size,
      waiting: this.waiters.size,
    });
  }

  async prewarm(): Promise<void> {
    const needed = Math.max(
      0,
      this.minimum - this.all.size - this.creatingSlots.size,
    );
    const acquired = await Promise.allSettled(
      Array.from({ length: needed }, () => this.acquire()),
    );
    await Promise.all(
      acquired.map((result) =>
        result.status === "fulfilled"
          ? this.release(result.value, true)
          : Promise.resolve(),
      ),
    );
    const failure = acquired.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  }

  async acquire(): Promise<PoolEntry<T>> {
    const deadline = Date.now() + this.acquireTimeoutMs;
    while (true) {
      this.throwIfClosed();
      const available = this.available.shift();
      if (available) {
        available.leased = true;
        return available;
      }
      const slot = this.reserveSlot();
      if (slot !== undefined) return this.createLeased(slot);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new QwpPoolAcquireTimeoutError(
          this.resource,
          this.acquireTimeoutMs,
        );
      }
      await this.waitForChange(remaining);
    }
  }

  async release(entry: PoolEntry<T>, reusable: boolean): Promise<void> {
    if (!entry.leased) return;
    entry.leased = false;
    if (this.closed || !reusable || this.all.get(entry.slot) !== entry) {
      if (this.all.get(entry.slot) === entry) this.all.delete(entry.slot);
      await this.destroy(entry);
      this.wakeWaiters();
      return;
    }
    this.available.push(entry);
    this.wakeWaiters();
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeNow();
    return this.closePromise;
  }

  private async closeNow(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new QwpClientClosedError());
    }
    this.waiters.clear();
    const entries = Array.from(this.all.values());
    this.all.clear();
    this.available.length = 0;
    await Promise.all(entries.map((entry) => this.destroy(entry)));
    const creations = Array.from(this.creationOperations);
    if (creations.length === 0) return;
    const waitMs = Math.min(this.acquireTimeoutMs, MAX_CLOSE_CREATION_WAIT_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(creations),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private reserveSlot(): number | undefined {
    if (this.all.size + this.creatingSlots.size >= this.maximum) {
      return undefined;
    }
    for (let slot = 0; slot < this.maximum; slot++) {
      if (!this.all.has(slot) && !this.creatingSlots.has(slot)) {
        this.creatingSlots.add(slot);
        return slot;
      }
    }
    return undefined;
  }

  private async createLeased(slot: number): Promise<PoolEntry<T>> {
    let finishCreation!: () => void;
    const operation = new Promise<void>((resolve) => {
      finishCreation = resolve;
    });
    this.creationOperations.add(operation);
    try {
      let value: T;
      try {
        value = await this.createResource(slot);
      } catch (error) {
        throw new QwpPoolResourceError(this.resource, error);
      }
      if (this.closed) {
        await this.destroyResource(value).catch(() => undefined);
        throw new QwpClientClosedError();
      }
      const entry: PoolEntry<T> = { slot, value, leased: true };
      this.all.set(slot, entry);
      return entry;
    } finally {
      this.creatingSlots.delete(slot);
      finishCreation();
      this.creationOperations.delete(operation);
      this.wakeWaiters();
    }
  }

  private waitForChange(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(
          new QwpPoolAcquireTimeoutError(this.resource, this.acquireTimeoutMs),
        );
      }, timeoutMs);
      const waiter: PoolWaiter = { resolve, reject, timer };
      this.waiters.add(waiter);
    });
  }

  private wakeWaiters(): void {
    for (const waiter of this.waiters) {
      this.waiters.delete(waiter);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private destroy(entry: PoolEntry<T>): Promise<void> {
    if (!entry.destroyPromise) {
      entry.destroyPromise = this.destroyResource(entry.value).catch(
        () => undefined,
      );
    }
    return entry.destroyPromise;
  }

  private throwIfClosed(): void {
    if (this.closed) throw new QwpClientClosedError();
  }
}

/** One exclusively borrowed egress session from a QwpClient query pool. */
export class QwpQueryLease {
  private closePromise?: Promise<void>;
  private released = false;

  /** SERVER_INFO for the endpoint selected by this pooled session. */
  readonly ready: Promise<QwpServerInfoMessage>;

  /** @internal */
  constructor(
    private readonly session: QwpEgressSession,
    private readonly releaseSession: (reusable: boolean) => Promise<void>,
  ) {
    this.ready = session.ready;
  }

  get handshake(): QwpHandshakeMetadata {
    this.throwIfReleased();
    return this.session.handshake;
  }

  get negotiatedCompression(): QwpNegotiatedEgressCompression | undefined {
    this.throwIfReleased();
    return this.session.negotiatedCompression;
  }

  get negotiatedZstdLevel(): number {
    this.throwIfReleased();
    return this.session.negotiatedZstdLevel;
  }

  query(
    sql: string,
    options: QwpEgressQueryOptions = {},
  ): Promise<QwpEgressQuery> {
    this.throwIfReleased();
    return this.session.query(sql, options);
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeNow();
    return this.closePromise;
  }

  private async closeNow(): Promise<void> {
    if (this.released) return;
    this.released = true;
    let reusable = false;
    try {
      reusable = await this.session.prepareForPoolRelease();
    } finally {
      await this.releaseSession(reusable);
    }
  }

  private throwIfReleased(): void {
    if (this.released) {
      throw new QwpClientClosedError("QWP query lease is closed");
    }
  }
}

/**
 * Browser-safe facade owning bounded ingress and egress connection pools.
 * Borrowed handles are exclusive; separate query leases execute concurrently.
 */
export class QwpClient {
  private readonly senderPool: QwpResourcePool<QwpSender>;
  private readonly queryPool: QwpResourcePool<QwpEgressSession>;
  private connectPromise?: Promise<this>;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private readonly startFactories?: () => void | Promise<void>;
  private readonly closeFactories?: () => void | Promise<void>;
  private closing = false;
  private closed = false;

  constructor(
    factories: QwpClientFactories,
    options: QwpClientPoolOptions = {},
  ) {
    const validated = validatePoolOptions(options);
    this.senderPool = new QwpResourcePool(
      "sender",
      validated.senderPoolMin,
      validated.senderPoolMax,
      validated.acquireTimeoutMs,
      factories.createSender,
      (sender) => sender.close(),
    );
    this.queryPool = new QwpResourcePool(
      "query",
      validated.queryPoolMin,
      validated.queryPoolMax,
      validated.acquireTimeoutMs,
      factories.createQuerySession,
      (session) => session.close(),
    );
    this.startFactories = factories.start;
    this.closeFactories = factories.close;
  }

  /** Pre-connects the configured minimum sender and query pool sizes. */
  connect(): Promise<this> {
    if (!this.connectPromise) this.connectPromise = this.connectNow();
    return this.connectPromise;
  }

  get metrics(): QwpClientMetrics {
    return Object.freeze({
      senders: this.senderPool.metrics,
      queries: this.queryPool.metrics,
      closing: this.closing,
      closed: this.closed,
    });
  }

  /** Borrows an exclusive fluent sender; close() flushes and returns its slot. */
  async borrowSender(): Promise<QwpSender> {
    this.throwIfUnavailable();
    await this.ensureStarted();
    this.throwIfUnavailable();
    const entry = await this.senderPool.acquire();
    return createSenderLease(entry.value, async (reusable) => {
      await this.senderPool.release(entry, reusable);
    });
  }

  /** Borrows one exclusive egress connection for one or more serial queries. */
  async borrowQuery(): Promise<QwpQueryLease> {
    this.throwIfUnavailable();
    await this.ensureStarted();
    this.throwIfUnavailable();
    const entry = await this.queryPool.acquire();
    return new QwpQueryLease(entry.value, async (reusable) => {
      await this.queryPool.release(entry, reusable);
    });
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeNow();
    return this.closePromise;
  }

  private async connectNow(): Promise<this> {
    this.throwIfUnavailable();
    try {
      await this.ensureStarted();
      this.throwIfUnavailable();
      await Promise.all([this.senderPool.prewarm(), this.queryPool.prewarm()]);
      return this;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private async closeNow(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    await this.startPromise?.catch(() => undefined);
    try {
      await Promise.resolve()
        .then(() => this.closeFactories?.())
        .catch(() => undefined);
      await Promise.all([this.queryPool.close(), this.senderPool.close()]);
    } finally {
      this.closed = true;
    }
  }

  private ensureStarted(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = Promise.resolve().then(() => this.startFactories?.());
    }
    return this.startPromise;
  }

  private throwIfUnavailable(): void {
    if (this.closing || this.closed) throw new QwpClientClosedError();
  }
}

function createSenderLease(
  sender: QwpSender,
  releaseSender: (reusable: boolean) => Promise<void>,
): QwpSender {
  let released = false;
  let closePromise: Promise<void> | undefined;
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();

  const release = (): Promise<void> => {
    if (closePromise) return closePromise;
    released = true;
    closePromise = (async () => {
      let reusable = false;
      let releaseError: unknown;
      try {
        await sender.prepareForPoolRelease();
        reusable = true;
      } catch (error) {
        releaseError = error;
      } finally {
        await releaseSender(reusable);
      }
      if (releaseError) throw releaseError;
    })();
    return closePromise;
  };

  const proxy = new Proxy(sender, {
    get(target, property) {
      if (property === "close") return release;
      if (released) {
        throw new QwpClientClosedError("QWP sender lease is closed");
      }
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      let wrapped = methods.get(property);
      if (!wrapped) {
        wrapped = (...args: unknown[]) => {
          if (released) {
            throw new QwpClientClosedError("QWP sender lease is closed");
          }
          const result = Reflect.apply(value, target, args);
          return result === target ? proxy : result;
        };
        methods.set(property, wrapped);
      }
      return wrapped;
    },
  });
  return proxy;
}

function validatePoolOptions(
  options: QwpClientPoolOptions,
): ValidatedPoolOptions {
  const validated: ValidatedPoolOptions = {
    senderPoolMin: options.senderPoolMin ?? DEFAULT_POOL_MIN,
    senderPoolMax: options.senderPoolMax ?? DEFAULT_POOL_MAX,
    queryPoolMin: options.queryPoolMin ?? DEFAULT_POOL_MIN,
    queryPoolMax: options.queryPoolMax ?? DEFAULT_POOL_MAX,
    acquireTimeoutMs: options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
  };
  validatePoolBounds(
    validated.senderPoolMin,
    validated.senderPoolMax,
    "sender",
  );
  validatePoolBounds(validated.queryPoolMin, validated.queryPoolMax, "query");
  if (
    !Number.isFinite(validated.acquireTimeoutMs) ||
    validated.acquireTimeoutMs < 0
  ) {
    throw new RangeError("acquireTimeoutMs must be a non-negative number");
  }
  return validated;
}

function validatePoolBounds(
  minimum: number,
  maximum: number,
  resource: string,
): void {
  if (!Number.isSafeInteger(minimum) || minimum < 0) {
    throw new RangeError(`${resource}PoolMin must be a non-negative integer`);
  }
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new RangeError(`${resource}PoolMax must be a positive integer`);
  }
  if (minimum > maximum) {
    throw new RangeError(`${resource}PoolMin cannot exceed ${resource}PoolMax`);
  }
}
