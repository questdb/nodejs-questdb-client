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
}

/**
 * Creates a stateful endpoint walker ordered by health and then zone affinity.
 * Every invocation still performs a complete sweep, so stale role/health data
 * can never permanently exclude an endpoint whose state has changed.
 */
export function createQwpFailoverConnectionFactory(
  preferredUrl: string | URL,
  failoverUrls: readonly (string | URL)[] | undefined,
  connect: (endpoint: string | URL) => Promise<QwpBinaryConnection>,
  options: QwpFailoverSelectionOptions = {},
): QwpConnectionFactory {
  const endpoints = [preferredUrl, ...(failoverUrls ?? [])];
  const target = normalizeTarget(options.target);
  const configuredZone = normalizeZone(options.zone);
  const zoneBlind =
    configuredZone === undefined || target === QWP_TARGET.PRIMARY;
  const health: QwpEndpointHealth[] = endpoints.map(() => ({
    state: HOST_STATE.UNKNOWN,
    zoneTier: zoneBlind ? ZONE_TIER.SAME : ZONE_TIER.UNKNOWN,
  }));

  return async (): Promise<QwpBinaryConnection> => {
    const attempts: QwpFailoverAttempt[] = [];
    const attempted = new Set<number>();

    while (attempted.size < endpoints.length) {
      const index = pickNextEndpoint(health, attempted);
      attempted.add(index);
      const endpoint = endpoints[index];
      let candidate: QwpBinaryConnection | undefined;
      try {
        candidate = await connect(endpoint);
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
        recordZone(
          health[index],
          configuredZone,
          zoneBlind,
          validated.serverZone,
        );
        if (!matchesTarget(validated.serverRole, target)) {
          throw new QwpRoleMismatchError(
            target,
            validated.serverRole,
            endpoint,
            validated.serverZone,
          );
        }
        health[index].state = HOST_STATE.HEALTHY;
        return observeConnectionHealth(candidate, health[index]);
      } catch (error) {
        recordFailure(health[index], configuredZone, zoneBlind, error);
        attempts.push({ endpoint, error });
        if (candidate) await candidate.close().catch(() => undefined);
        if (error instanceof QwpUpgradeError && !error.tryNextEndpoint) {
          throw error;
        }
      }
    }
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
): number {
  let selected = -1;
  for (let index = 0; index < health.length; index++) {
    if (attempted.has(index)) continue;
    if (selected < 0 || compareHealth(health[index], health[selected]) < 0) {
      selected = index;
    }
  }
  return selected;
}

function compareHealth(
  left: QwpEndpointHealth,
  right: QwpEndpointHealth,
): number {
  if (left.state !== right.state) return left.state - right.state;
  if (left.zoneTier !== right.zoneTier) return left.zoneTier - right.zoneTier;
  return 0;
}

function recordZone(
  health: QwpEndpointHealth,
  configuredZone: string | undefined,
  zoneBlind: boolean,
  serverZone: string | undefined,
): void {
  const normalized = normalizeZone(serverZone);
  if (!normalized) return;
  health.zoneTier =
    zoneBlind || normalized === configuredZone
      ? ZONE_TIER.SAME
      : ZONE_TIER.OTHER;
}

function recordFailure(
  health: QwpEndpointHealth,
  configuredZone: string | undefined,
  zoneBlind: boolean,
  error: unknown,
): void {
  if (error instanceof QwpUpgradeError) {
    recordZone(health, configuredZone, zoneBlind, error.serverZone);
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

function observeConnectionHealth(
  connection: QwpBinaryConnection,
  health: QwpEndpointHealth,
): QwpBinaryConnection {
  const demote = (): void => {
    if (health.state === HOST_STATE.HEALTHY) {
      health.state = HOST_STATE.TRANSPORT_ERROR;
    }
  };
  void connection.closed.then((info) => {
    if (!info.wasClean) demote();
  }, demote);
  const observed: QwpBinaryConnection = {
    messages: connection.messages,
    closed: connection.closed,
    handshake: connection.handshake,
    endpoint: connection.endpoint,
    ingressSymbolDictionary: connection.ingressSymbolDictionary,
    send: async (payload) => {
      try {
        await connection.send(payload);
      } catch (error) {
        demote();
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
        demote();
        throw error;
      }
    };
  }
  if (connection.getIngressMetrics) {
    observed.getIngressMetrics = () => connection.getIngressMetrics!();
  }
  return observed;
}
