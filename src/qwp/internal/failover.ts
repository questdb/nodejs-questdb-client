import {
  QWP_TARGET,
  QWP_UPGRADE_ERROR_KIND,
  QwpBinaryConnection,
  QwpConnectionFactory,
  QwpEgressRoutingOptions,
  QwpFailoverAttempt,
  QwpFailoverError,
  QwpRoleMismatchError,
  QwpTarget,
  QwpUpgradeError,
} from "../transport";

const HOST_STATE = {
  HEALTHY: 0,
  UNKNOWN: 1,
  TRANSIENT_REJECT: 2,
  TRANSPORT_ERROR: 3,
  TOPOLOGY_REJECT: 4,
} as const;

type HostState = (typeof HOST_STATE)[keyof typeof HOST_STATE];

const ZONE_TIER = {
  SAME: 0,
  UNKNOWN: 1,
  OTHER: 2,
} as const;

type ZoneTier = (typeof ZONE_TIER)[keyof typeof ZONE_TIER];

interface QwpEndpointHealth {
  state: HostState;
  zoneTier: ZoneTier;
  lastSuccessEpoch: number;
}

/**
 * Shared endpoint classifications used by independent connection walkers.
 * Each factory keeps its own sweep cursor while publishing observations here,
 * so concurrent pooled sessions and orphan drainers cannot steal attempts from
 * one another but immediately benefit from one another's health discoveries.
 */
export class QwpFailoverHealthTracker {
  private readonly endpointKeys: readonly string[];
  private readonly health: QwpEndpointHealth[];
  private successEpoch = 0;

  constructor(
    preferredUrl: string | URL,
    failoverUrls: readonly (string | URL)[] | undefined,
    private readonly target: QwpTarget,
    private readonly configuredZone: string | undefined,
  ) {
    this.endpointKeys = endpointKeys(preferredUrl, failoverUrls);
    const zoneBlind = this.zoneBlind;
    this.health = this.endpointKeys.map(() => ({
      state: HOST_STATE.UNKNOWN,
      zoneTier: zoneBlind ? ZONE_TIER.SAME : ZONE_TIER.UNKNOWN,
      lastSuccessEpoch: 0,
    }));
  }

  assertCompatible(
    preferredUrl: string | URL,
    failoverUrls: readonly (string | URL)[] | undefined,
    target: QwpTarget,
    configuredZone: string | undefined,
  ): void {
    const keys = endpointKeys(preferredUrl, failoverUrls);
    if (
      target !== this.target ||
      configuredZone !== this.configuredZone ||
      keys.length !== this.endpointKeys.length ||
      keys.some((key, index) => key !== this.endpointKeys[index])
    ) {
      throw new RangeError(
        "QWP failover health tracker does not match the endpoint routing configuration",
      );
    }
  }

  newRoundCursor(deferredEndpoint?: number): QwpFailoverRoundCursor {
    return new QwpFailoverRoundCursor(this.health, deferredEndpoint);
  }

  /**
   * Starts a recovery round with stale classifications forgotten. The newest
   * successful same-zone endpoint stays healthy, matching the Java client's
   * locality-aware stickiness; learned zone tiers persist across rounds.
   */
  forgetClassifications(): void {
    let stickyIndex = -1;
    let newestSuccess = -1;
    for (let index = 0; index < this.health.length; index++) {
      const health = this.health[index];
      if (
        health.state === HOST_STATE.HEALTHY &&
        health.zoneTier === ZONE_TIER.SAME &&
        health.lastSuccessEpoch > newestSuccess
      ) {
        stickyIndex = index;
        newestSuccess = health.lastSuccessEpoch;
      }
    }
    for (let index = 0; index < this.health.length; index++) {
      if (index !== stickyIndex) this.health[index].state = HOST_STATE.UNKNOWN;
    }
  }

  recordFailure(index: number, error: unknown): void {
    const health = this.health[index];
    if (error instanceof QwpUpgradeError) {
      this.recordZone(index, error.serverZone);
      if (error.kind === QWP_UPGRADE_ERROR_KIND.ROLE_REJECTED) {
        health.state =
          normalizeRole(error.serverRole) === "PRIMARY_CATCHUP"
            ? HOST_STATE.TRANSIENT_REJECT
            : HOST_STATE.TOPOLOGY_REJECT;
        return;
      }
    }
    health.state = HOST_STATE.TRANSPORT_ERROR;
  }

  recordSuccess(index: number): void {
    const health = this.health[index];
    health.state = HOST_STATE.HEALTHY;
    health.lastSuccessEpoch = ++this.successEpoch;
  }

  recordZone(index: number, serverZone: string | undefined): void {
    const normalized = normalizeZone(serverZone);
    if (!normalized) return;
    this.health[index].zoneTier =
      this.zoneBlind || normalized === this.configuredZone
        ? ZONE_TIER.SAME
        : ZONE_TIER.OTHER;
  }

  recordMidStreamFailure(index: number): void {
    const health = this.health[index];
    if (health.state === HOST_STATE.HEALTHY) {
      health.state = HOST_STATE.TRANSPORT_ERROR;
    }
  }

  recordTransientReject(index: number): void {
    this.health[index].state = HOST_STATE.TRANSIENT_REJECT;
  }

  private get zoneBlind(): boolean {
    return (
      this.configuredZone === undefined || this.target === QWP_TARGET.PRIMARY
    );
  }
}

class QwpFailoverRoundCursor {
  private readonly attempted = new Set<number>();

  constructor(
    private readonly health: readonly QwpEndpointHealth[],
    private readonly deferredEndpoint?: number,
  ) {}

  next(): number | undefined {
    const selected = pickNextEndpoint(
      this.health,
      this.attempted,
      this.deferredEndpoint,
    );
    if (selected === undefined) return undefined;
    this.attempted.add(selected);
    return selected;
  }

  get exhausted(): boolean {
    return this.attempted.size === this.health.length;
  }
}

export interface QwpValidatedConnection {
  readonly connection: QwpBinaryConnection;
  readonly serverRole?: string;
  readonly serverZone?: string;
}

export interface QwpFailoverSelectionOptions extends QwpEgressRoutingOptions {
  /** @internal Reads protocol-level topology metadata when headers are hidden. */
  validateConnection?: (
    connection: QwpBinaryConnection,
  ) => Promise<QwpValidatedConnection>;
  /** @internal Shares classifications without sharing a walker's cursor. */
  healthTracker?: QwpFailoverHealthTracker;
  /** @internal Background walkers must not reset shared classifications. */
  resetClassificationsAfterExhaustion?: boolean;
}

/** Creates a health ledger that can be shared by independent walkers. */
export function createQwpFailoverHealthTracker(
  preferredUrl: string | URL,
  failoverUrls: readonly (string | URL)[] | undefined,
  options: QwpEgressRoutingOptions = {},
): QwpFailoverHealthTracker {
  return new QwpFailoverHealthTracker(
    preferredUrl,
    failoverUrls,
    normalizeTarget(options.target),
    normalizeZone(options.zone),
  );
}

/**
 * Creates a stateful endpoint walker ordered by health and then zone affinity.
 * Every invocation still performs a complete sweep, so stale role/health data
 * can never permanently exclude an endpoint whose state has changed.
 */
export function createQwpFailoverConnectionFactory(
  preferredUrl: string | URL,
  failoverUrls: readonly (string | URL)[] | undefined,
  connect: (
    endpoint: string | URL,
    signal?: AbortSignal,
  ) => Promise<QwpBinaryConnection>,
  options: QwpFailoverSelectionOptions = {},
): QwpConnectionFactory {
  const endpoints = [preferredUrl, ...(failoverUrls ?? [])];
  const target = normalizeTarget(options.target);
  const configuredZone = normalizeZone(options.zone);
  const healthTracker =
    options.healthTracker ??
    new QwpFailoverHealthTracker(
      preferredUrl,
      failoverUrls,
      target,
      configuredZone,
    );
  healthTracker.assertCompatible(
    preferredUrl,
    failoverUrls,
    target,
    configuredZone,
  );
  const resetClassificationsAfterExhaustion =
    options.resetClassificationsAfterExhaustion !== false;
  let deferredEndpoint: number | undefined;
  let resetClassificationsBeforeSweep = false;

  return async (signal?: AbortSignal): Promise<QwpBinaryConnection> => {
    if (
      resetClassificationsBeforeSweep &&
      resetClassificationsAfterExhaustion
    ) {
      healthTracker.forgetClassifications();
    }
    resetClassificationsBeforeSweep = false;
    const attempts: QwpFailoverAttempt[] = [];
    const deferredForSweep = deferredEndpoint;
    deferredEndpoint = undefined;
    const cursor = healthTracker.newRoundCursor(deferredForSweep);

    while (true) {
      const index = cursor.next();
      if (index === undefined) break;
      const endpoint = endpoints[index];
      let candidate: QwpBinaryConnection | undefined;
      try {
        candidate = await connect(endpoint, signal);
        let validated: QwpValidatedConnection = {
          connection: candidate,
          serverRole: candidate.handshake.serverRole,
          serverZone: candidate.handshake.serverZone,
        };
        if (options.validateConnection) {
          const protocolValidated = await options.validateConnection(candidate);
          validated = {
            connection: protocolValidated.connection,
            serverRole:
              protocolValidated.serverRole ?? candidate.handshake.serverRole,
            serverZone:
              protocolValidated.serverZone ?? candidate.handshake.serverZone,
          };
        }
        candidate = validated.connection;
        healthTracker.recordZone(index, validated.serverZone);
        if (!matchesTarget(validated.serverRole, target)) {
          throw new QwpRoleMismatchError(
            target,
            validated.serverRole,
            endpoint,
            validated.serverZone,
          );
        }
        healthTracker.recordSuccess(index);
        resetClassificationsBeforeSweep = cursor.exhausted;
        return observeConnectionHealth(
          candidate,
          () => {
            healthTracker.recordMidStreamFailure(index);
          },
          () => {
            healthTracker.recordTransientReject(index);
            deferredEndpoint = index;
          },
        );
      } catch (error) {
        healthTracker.recordFailure(index, error);
        attempts.push({ endpoint, error });
        if (candidate) await candidate.close().catch(() => undefined);
        // tryNextEndpoint is a tri-state: only an explicit false short-circuits
        // the sweep. A browser cannot see the HTTP response, so every refused,
        // reset, or non-101 upgrade it reports is `undefined`; treating that as
        // "stop" would make failoverUrls unreachable in browsers. This matches
        // isRetryableReconnectError(), which reads the sibling `retryable` flag
        // of the same tri-state as `!== false`.
        if (
          error instanceof QwpUpgradeError &&
          error.tryNextEndpoint === false
        ) {
          throw error;
        }
      }
    }
    resetClassificationsBeforeSweep = true;
    if (attempts.length === 1) throw attempts[0].error;
    throw new QwpFailoverError(attempts);
  };
}

function normalizeTarget(target: QwpTarget | undefined): QwpTarget {
  const effective = target ?? QWP_TARGET.ANY;
  if (
    effective !== QWP_TARGET.ANY &&
    effective !== QWP_TARGET.PRIMARY &&
    effective !== QWP_TARGET.REPLICA
  ) {
    throw new RangeError("target must be one of: any, primary, replica");
  }
  return effective;
}

function normalizeZone(zone: string | undefined): string | undefined {
  const normalized = zone?.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeRole(role: string | undefined): string | undefined {
  const normalized = role?.trim().toUpperCase().replace(/-/g, "_");
  return normalized || undefined;
}

function matchesTarget(role: string | undefined, target: QwpTarget): boolean {
  if (target === QWP_TARGET.ANY) return true;
  const normalized = normalizeRole(role);
  if (target === QWP_TARGET.REPLICA) return normalized === "REPLICA";
  return (
    normalized === "PRIMARY" ||
    normalized === "PRIMARY_CATCHUP" ||
    normalized === "STANDALONE"
  );
}

function pickNextEndpoint(
  health: readonly QwpEndpointHealth[],
  attempted: ReadonlySet<number>,
  deferredEndpoint?: number,
): number | undefined {
  let selected = -1;
  for (let index = 0; index < health.length; index++) {
    if (attempted.has(index) || index === deferredEndpoint) continue;
    if (selected < 0 || compareHealth(health[index], health[selected]) < 0) {
      selected = index;
    }
  }
  if (selected >= 0) return selected;
  if (deferredEndpoint !== undefined && !attempted.has(deferredEndpoint)) {
    return deferredEndpoint;
  }
  return undefined;
}

function compareHealth(
  left: QwpEndpointHealth,
  right: QwpEndpointHealth,
): number {
  if (left.state !== right.state) return left.state - right.state;
  if (left.zoneTier !== right.zoneTier) return left.zoneTier - right.zoneTier;
  return 0;
}

function observeConnectionHealth(
  connection: QwpBinaryConnection,
  demoteEndpoint: () => void,
  deprioritizeEndpoint: () => void,
): QwpBinaryConnection {
  void connection.closed.then((info) => {
    if (!info.wasClean) demoteEndpoint();
  }, demoteEndpoint);
  const observed: QwpBinaryConnection = {
    messages: connection.messages,
    closed: connection.closed,
    handshake: connection.handshake,
    endpoint: connection.endpoint,
    get ingressSymbolDictionary() {
      return connection.ingressSymbolDictionary;
    },
    get ingressDeltaSymbolDictionaryEnabled() {
      return connection.ingressDeltaSymbolDictionaryEnabled;
    },
    deprioritizeEndpoint,
    send: async (payload) => {
      try {
        await connection.send(payload);
      } catch (error) {
        demoteEndpoint();
        throw error;
      }
    },
    close: (code, reason) => connection.close(code, reason),
  };
  if (connection.ping) {
    observed.ping = async () => {
      try {
        await connection.ping!();
      } catch (error) {
        demoteEndpoint();
        throw error;
      }
    };
  }
  if (connection.getIngressMetrics) {
    observed.getIngressMetrics = () => connection.getIngressMetrics!();
  }
  return observed;
}

function endpointKeys(
  preferredUrl: string | URL,
  failoverUrls: readonly (string | URL)[] | undefined,
): readonly string[] {
  return [preferredUrl, ...(failoverUrls ?? [])].map(String);
}
