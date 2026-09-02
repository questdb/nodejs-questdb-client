import {
  QwpEgressQuery,
  QwpEgressQueryOptions,
  QwpEgressSession,
  QwpEgressViewQuery,
  QwpResultBatchViewHandler,
} from "./egress-session";
import { QwpSender } from "./sender";
import { QwpHandshakeMetadata } from "./transport";
import type {
  QwpNegotiatedEgressCompression,
  QwpServerInfoMessage,
} from "./_core";

const DEFAULT_POOL_MIN = 1;
const DEFAULT_POOL_MAX = 4;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_LIFETIME_MS = 30 * 60_000;
const DEFAULT_HOUSEKEEPING_INTERVAL_MS = 5_000;
const MIN_HOUSEKEEPING_INTERVAL_MS = 100;
const MAX_CLOSE_CREATION_WAIT_MS = 5_000;
const MAX_CLOSE_LEASE_WAIT_MS = 5_000;

export interface QwpClientPoolOptions {
  /** Warm ingress connections created by connect(). Defaults to 1. */
  senderPoolMin?: number;
  /** Maximum concurrently borrowed ingress senders. Defaults to 4. */
  senderPoolMax?: number;
  /** Warm egress connections created by connect(). Defaults to 1. */
  queryPoolMin?: number;
  /** Maximum concurrently borrowed query connections. Defaults to 4. */
  queryPoolMax?: number;
  /** Idle time before an excess pooled connection is closed. Defaults to 60s; zero disables. */
  idleTimeoutMs?: number;
  /** Maximum pooled connection age before recycling it while idle. Defaults to 30m; zero disables. */
  maxLifetimeMs?: number;
  /** Idle/lifetime sweep interval. Defaults to 5s and must be at least 100ms. */
  housekeepingIntervalMs?: number;
  /**
   * Maximum wait for a returned pool slot and for leases during shutdown.
   * The shutdown wait is capped at 5 seconds. Defaults to 5 seconds.
   */
  acquireTimeoutMs?: number;
}

export interface QwpClientFactories {
  createSender(slot: number, signal?: AbortSignal): Promise<QwpSender>;
  createQuerySession(
    slot: number,
    signal?: AbortSignal,
  ): Promise<QwpEgressSession>;
  /** @internal Coordinates stable persistent sender slots with recovery. */
  senderSlotReservation?: QwpPoolSlotReservation;
  /** @internal Starts runtime-specific background services on first use. */
  start?(): void | Promise<void>;
  /** @internal Stops runtime-specific background services during close. */
  close?(): void | Promise<void>;
}

/** @internal Cross-owner reservation for stable pooled sender slot indexes. */
export interface QwpPoolSlotReservation {
  tryReserve(slot: number): boolean;
  release(slot: number): void;
  onAvailable(listener: () => void): () => void;
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
  readonly idleTimeoutMs: number;
  readonly maxLifetimeMs: number;
  readonly housekeepingIntervalMs: number;
}

interface PoolEntry<T> {
  readonly slot: number;
  readonly value: T;
  readonly createdAtMs: number;
  idleSinceMs: number;
  leased: boolean;
  destroyPromise?: Promise<void>;
}

interface PoolWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
}

interface PoolCloseWaiter {
  readonly resolve: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class QwpResourcePool<T> {
  private readonly all = new Map<number, PoolEntry<T>>();
  private readonly available: PoolEntry<T>[] = [];
  private readonly creatingSlots = new Set<number>();
  private readonly destroyingSlots = new Set<number>();
  private readonly creationOperations = new Set<Promise<void>>();
  private readonly creationAbortControllers = new Set<AbortController>();
  private readonly waiters = new Set<PoolWaiter>();
  private readonly closeWaiters = new Set<PoolCloseWaiter>();
  private readonly reservedSlots = new Set<number>();
  private readonly unsubscribeSlotAvailability?: () => void;
  private closePromise?: Promise<void>;
  private pendingLeaseTeardowns = 0;
  private closed = false;

  constructor(
    private readonly resource: "sender" | "query",
    private readonly minimum: number,
    private readonly maximum: number,
    private readonly acquireTimeoutMs: number,
    private readonly idleTimeoutMs: number,
    private readonly maxLifetimeMs: number,
    private readonly createResource: (
      slot: number,
      signal: AbortSignal,
    ) => Promise<T>,
    private readonly destroyResource: (resource: T) => Promise<void>,
    private readonly closeLeasedOnShutdown = false,
    private readonly slotReservation?: QwpPoolSlotReservation,
  ) {
    this.unsubscribeSlotAvailability = slotReservation?.onAvailable(() =>
      this.wakeWaiters(),
    );
  }

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
      this.pendingLeaseTeardowns++;
      try {
        await this.destroyRetired(entry);
      } finally {
        this.pendingLeaseTeardowns--;
        this.wakeWaiters();
        this.wakeCloseWaiters();
      }
      return;
    }
    entry.idleSinceMs = Date.now();
    this.available.push(entry);
    this.wakeWaiters();
    this.wakeCloseWaiters();
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeNow();
    return this.closePromise;
  }

  async reapIdle(nowMs = Date.now()): Promise<void> {
    if (this.closed || this.all.size <= this.minimum) return;
    const reaped: PoolEntry<T>[] = [];
    let index = 0;
    while (index < this.available.length && this.all.size > this.minimum) {
      const entry = this.available[index];
      const idleExpired =
        this.idleTimeoutMs > 0 &&
        nowMs - entry.idleSinceMs >= this.idleTimeoutMs;
      const lifetimeExpired =
        this.maxLifetimeMs > 0 &&
        nowMs - entry.createdAtMs >= this.maxLifetimeMs;
      if (!idleExpired && !lifetimeExpired) {
        index++;
        continue;
      }
      this.available.splice(index, 1);
      this.all.delete(entry.slot);
      reaped.push(entry);
    }
    if (reaped.length === 0) return;
    await Promise.all(reaped.map((entry) => this.destroyRetired(entry)));
  }

  private async closeNow(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeSlotAvailability?.();
    for (const waiter of this.waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new QwpClientClosedError());
    }
    this.waiters.clear();
    for (const controller of this.creationAbortControllers) controller.abort();
    // Idle entries always belong to the closing thread. Borrowed senders remain
    // owner-managed, while borrowed query sessions are retired with them below.
    const entries = this.available.splice(0);
    for (const entry of entries) this.all.delete(entry.slot);
    const idleTeardown = Promise.all(
      entries.map((entry) => this.destroy(entry)),
    );
    let leasedTeardown: Promise<void[]> | undefined;
    if (this.closeLeasedOnShutdown) {
      const leased = Array.from(this.all.values()).filter(
        (entry) => entry.leased,
      );
      for (const entry of leased) this.all.delete(entry.slot);
      // Invoke every query teardown before awaiting any one WebSocket's bounded
      // close handshake, so one slow idle socket cannot delay active-query
      // cancellation on the other pool entries.
      leasedTeardown = Promise.all(leased.map((entry) => this.destroy(entry)));
    }
    await idleTeardown;
    const creations = Array.from(this.creationOperations);
    if (creations.length > 0) {
      const waitMs = Math.min(
        this.acquireTimeoutMs,
        MAX_CLOSE_CREATION_WAIT_MS,
      );
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
    if (leasedTeardown) {
      await leasedTeardown;
      this.wakeCloseWaiters();
      return;
    }
    await this.waitForLeases(
      Math.min(this.acquireTimeoutMs, MAX_CLOSE_LEASE_WAIT_MS),
    );
  }

  private reserveSlot(): number | undefined {
    if (
      this.all.size + this.creatingSlots.size + this.destroyingSlots.size >=
      this.maximum
    ) {
      return undefined;
    }
    for (let slot = 0; slot < this.maximum; slot++) {
      if (
        !this.all.has(slot) &&
        !this.creatingSlots.has(slot) &&
        !this.destroyingSlots.has(slot)
      ) {
        if (this.slotReservation && !this.slotReservation.tryReserve(slot)) {
          continue;
        }
        if (this.slotReservation) this.reservedSlots.add(slot);
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
    const controller = new AbortController();
    this.creationAbortControllers.add(controller);
    let retained = false;
    try {
      let value: T;
      try {
        value = await this.createResource(slot, controller.signal);
      } catch (error) {
        throw new QwpPoolResourceError(this.resource, error);
      }
      if (this.closed) {
        await this.destroyResource(value).catch(() => undefined);
        throw new QwpClientClosedError();
      }
      const nowMs = Date.now();
      const entry: PoolEntry<T> = {
        slot,
        value,
        createdAtMs: nowMs,
        idleSinceMs: nowMs,
        leased: true,
      };
      this.all.set(slot, entry);
      retained = true;
      return entry;
    } finally {
      this.creationAbortControllers.delete(controller);
      this.creatingSlots.delete(slot);
      if (!retained) this.releaseSlotReservation(slot);
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

  private wakeCloseWaiters(): void {
    for (const waiter of this.closeWaiters) {
      this.closeWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private outstandingLeases(): number {
    let count = this.pendingLeaseTeardowns;
    for (const entry of this.all.values()) {
      if (entry.leased) count++;
    }
    return count;
  }

  private async waitForLeases(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.outstandingLeases() > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await new Promise<void>((resolve) => {
        const waiter: PoolCloseWaiter = {
          resolve,
          timer: setTimeout(() => {
            this.closeWaiters.delete(waiter);
            resolve();
          }, remaining),
        };
        this.closeWaiters.add(waiter);
      });
    }
  }

  private destroy(entry: PoolEntry<T>): Promise<void> {
    if (!entry.destroyPromise) {
      entry.destroyPromise = this.destroyResource(entry.value)
        .catch(() => undefined)
        .finally(() => this.releaseSlotReservation(entry.slot));
    }
    return entry.destroyPromise;
  }

  private releaseSlotReservation(slot: number): void {
    if (!this.reservedSlots.delete(slot)) return;
    this.slotReservation?.release(slot);
  }

  private async destroyRetired(entry: PoolEntry<T>): Promise<void> {
    this.destroyingSlots.add(entry.slot);
    try {
      await this.destroy(entry);
    } finally {
      this.destroyingSlots.delete(entry.slot);
      this.wakeWaiters();
      this.wakeCloseWaiters();
    }
  }

  private throwIfClosed(): void {
    if (this.closed) throw new QwpClientClosedError();
  }
}

/** One exclusively borrowed egress session from a QwpClient query pool. */
export class QwpQueryLease {
  private closePromise?: Promise<void>;
  private released = false;

  /** Initial SERVER_INFO; use serverInfo for the current post-failover snapshot. */
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

  /**
   * Cached immutable SERVER_INFO for this lease's currently bound endpoint.
   * Reading it does not drive failover; a successful query replay refreshes it.
   */
  get serverInfo(): QwpServerInfoMessage | undefined {
    this.throwIfReleased();
    return this.session.serverInfo;
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

  queryViews(
    sql: string,
    onBatch: QwpResultBatchViewHandler,
    options: QwpEgressQueryOptions = {},
  ): Promise<QwpEgressViewQuery> {
    this.throwIfReleased();
    return this.session.queryViews(sql, onBatch, options);
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
  private readonly housekeepingIntervalMs: number;
  private housekeepingTask: Promise<void> = Promise.resolve();
  private housekeeperTimer?: ReturnType<typeof setInterval>;
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
      validated.idleTimeoutMs,
      validated.maxLifetimeMs,
      factories.createSender,
      (sender) => sender.close(),
      false,
      factories.senderSlotReservation,
    );
    this.queryPool = new QwpResourcePool(
      "query",
      validated.queryPoolMin,
      validated.queryPoolMax,
      validated.acquireTimeoutMs,
      validated.idleTimeoutMs,
      validated.maxLifetimeMs,
      factories.createQuerySession,
      (session) => session.shutdownForClientClose(),
      true,
    );
    this.startFactories = factories.start;
    this.closeFactories = factories.close;
    this.housekeepingIntervalMs = validated.housekeepingIntervalMs;
  }

  /** Pre-connects the configured minimum sender and query pool sizes. */
  connect(): Promise<this> {
    if (!this.connectPromise) {
      const attempt = this.connectNow();
      this.connectPromise = attempt;
      // A failed prewarm is not a terminal state -- the endpoint may simply
      // have been unavailable for a moment during a rolling restart or an LB
      // warm-up. Forget the attempt so a retry starts a new one; memoizing it
      // meant every later connect() replayed the first rejection without ever
      // reaching the server again. The caller still sees this rejection.
      attempt.catch(() => {
        if (this.connectPromise === attempt) this.connectPromise = undefined;
      });
    }
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

  /**
   * Rejects new borrows and closes idle resources. Borrowed query sessions are
   * cancelled and closed; borrowed senders retain ownership during a bounded
   * drain and own their teardown if they outlive it.
   */
  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeNow();
    return this.closePromise;
  }

  private async connectNow(): Promise<this> {
    this.throwIfUnavailable();
    await this.ensureStarted();
    this.throwIfUnavailable();
    // prewarm() releases every entry it did manage to acquire back into the
    // pool before it rethrows, so a partial prewarm leaves healthy warm
    // entries rather than half-built ones. Closing the client here to tidy
    // them up therefore destroyed a recoverable client over a transient
    // outage: close() latches closing/closed irreversibly, so every later
    // borrowSender()/borrowQuery() threw QwpClientClosedError and the object
    // had to be rebuilt. Let the rejection reach the caller instead.
    await Promise.all([this.senderPool.prewarm(), this.queryPool.prewarm()]);
    return this;
  }

  private async closeNow(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    this.stopHousekeeper();
    await this.startPromise?.catch(() => undefined);
    await this.housekeepingTask;
    try {
      let runtimeClose: Promise<void>;
      try {
        runtimeClose = Promise.resolve(this.closeFactories?.()).catch(
          () => undefined,
        );
      } catch {
        runtimeClose = Promise.resolve();
      }
      // Stop runtime scanners and reject pool waiters in the same phase. This
      // prevents a recovery-slot release during shutdown from waking an older
      // borrow into a newly created foreground connection.
      await Promise.all([
        runtimeClose,
        this.queryPool.close(),
        this.senderPool.close(),
      ]);
    } finally {
      this.closed = true;
    }
  }

  private ensureStarted(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = Promise.resolve()
        .then(() => this.startFactories?.())
        .then(() => {
          if (!this.closing && !this.closed) this.startHousekeeper();
        });
    }
    return this.startPromise;
  }

  private startHousekeeper(): void {
    if (this.housekeeperTimer) return;
    this.housekeeperTimer = setInterval(() => {
      this.housekeepingTask = this.housekeepingTask
        .then(async () => {
          if (this.closing || this.closed) return;
          const nowMs = Date.now();
          await Promise.all([
            this.senderPool.reapIdle(nowMs),
            this.queryPool.reapIdle(nowMs),
          ]);
        })
        .catch(() => undefined);
    }, this.housekeepingIntervalMs);
    const timer = this.housekeeperTimer as unknown as { unref?: () => void };
    timer.unref?.();
  }

  private stopHousekeeper(): void {
    if (!this.housekeeperTimer) return;
    clearInterval(this.housekeeperTimer);
    this.housekeeperTimer = undefined;
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

  const guardTableWriter = <T extends object>(writer: T): T => {
    // Memoized per writer, matching the sender proxy below: appends re-enter
    // this trap per row, so a fresh closure per access would allocate on the
    // hot path and hand out unstable method identities.
    const writerMethods = new Map<
      PropertyKey,
      (...args: unknown[]) => unknown
    >();
    const guarded: T = new Proxy(writer, {
      get(target, property) {
        if (released) {
          throw new QwpClientClosedError("QWP sender lease is closed");
        }
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        let wrapped = writerMethods.get(property);
        if (!wrapped) {
          wrapped = (...args: unknown[]) => {
            if (released) {
              throw new QwpClientClosedError("QWP sender lease is closed");
            }
            // Re-enter through the proxy so multi-row helpers such as rows()
            // re-check the lease between appends instead of only on entry.
            return Reflect.apply(value, guarded, args);
          };
          writerMethods.set(property, wrapped);
        }
        return wrapped;
      },
    });
    return guarded;
  };

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
          if (property === "writer" && typeof result === "object" && result) {
            return guardTableWriter(result);
          }
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
    idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    maxLifetimeMs: options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS,
    housekeepingIntervalMs:
      options.housekeepingIntervalMs ?? DEFAULT_HOUSEKEEPING_INTERVAL_MS,
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
  validateOptionalPoolTimeout(validated.idleTimeoutMs, "idleTimeoutMs");
  validateOptionalPoolTimeout(validated.maxLifetimeMs, "maxLifetimeMs");
  if (
    !Number.isFinite(validated.housekeepingIntervalMs) ||
    validated.housekeepingIntervalMs < MIN_HOUSEKEEPING_INTERVAL_MS
  ) {
    throw new RangeError(
      `housekeepingIntervalMs must be at least ${MIN_HOUSEKEEPING_INTERVAL_MS}`,
    );
  }
  return validated;
}

function validateOptionalPoolTimeout(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative number`);
  }
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
