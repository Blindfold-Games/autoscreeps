import type { NexusTelemetrySnapshot, VariantRole } from "./contracts.ts";

export function parseNexusTelemetry(value: string | null): NexusTelemetrySnapshot | null {
  if (!value) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;

  const schemaVersion = parsed.schemaVersion;
  const tick = parsed.tick;
  if (typeof schemaVersion !== "number" || typeof tick !== "number") return null;

  const colony = parsed.colony;
  if (!isRecord(colony) || typeof colony.rcl !== "number") return null;

  const cortex = parsed.cortex;
  if (!isRecord(cortex) || typeof cortex.protocolsScheduled !== "number") return null;

  const spawn = parsed.spawn;
  if (!isRecord(spawn) || typeof spawn.queueDepth !== "number") return null;

  const logistics = parsed.logistics;
  if (!isRecord(logistics) || typeof logistics.activeConduits !== "number") return null;

  return {
    schemaVersion,
    tick,
    colony: {
      rcl: colony.rcl as number,
      controllerProgress: typeof colony.controllerProgress === "number" ? colony.controllerProgress : 0,
      controllerProgressTotal: typeof colony.controllerProgressTotal === "number" ? colony.controllerProgressTotal : 1,
      totalCreeps: typeof colony.totalCreeps === "number" ? colony.totalCreeps : 0,
      creepsByProtocol: isNumberRecord(colony.creepsByProtocol) ? colony.creepsByProtocol : {}
    },
    cortex: {
      protocolsScheduled: cortex.protocolsScheduled as number,
      protocolsSkipped: typeof cortex.protocolsSkipped === "number" ? cortex.protocolsSkipped : 0,
      beaconQueueDepth: typeof cortex.beaconQueueDepth === "number" ? cortex.beaconQueueDepth : 0,
      priorityDistribution: isNumberRecord(cortex.priorityDistribution) ? cortex.priorityDistribution : {}
    },
    spawn: {
      queueDepth: spawn.queueDepth as number,
      spawning: typeof spawn.spawning === "boolean" ? spawn.spawning : false,
      spawnEvents: typeof spawn.spawnEvents === "number" ? spawn.spawnEvents : 0,
      idleSpawnTicks: typeof spawn.idleSpawnTicks === "number" ? spawn.idleSpawnTicks : 0,
      lastBlueprintUsed: typeof spawn.lastBlueprintUsed === "string" ? spawn.lastBlueprintUsed : null
    },
    protocols: Array.isArray(parsed.protocols)
      ? parsed.protocols.flatMap((p) => {
          if (!isRecord(p) || typeof p.type !== "string") return [];
          return [{
            type: p.type as string,
            id: typeof p.id === "string" ? p.id as string : "",
            creepCount: typeof p.creepCount === "number" ? p.creepCount as number : 0,
            routineCompletions: typeof p.routineCompletions === "number" ? p.routineCompletions as number : 0,
            routineFailures: typeof p.routineFailures === "number" ? p.routineFailures as number : 0,
            ticksActive: typeof p.ticksActive === "number" ? p.ticksActive as number : 0,
            created: typeof p.created === "boolean" ? p.created as boolean : false,
            destroyed: typeof p.destroyed === "boolean" ? p.destroyed as boolean : false
          }];
        })
      : [],
    logistics: {
      activeConduits: logistics.activeConduits as number,
      totalEnergyRouted: typeof logistics.totalEnergyRouted === "number" ? logistics.totalEnergyRouted as number : 0,
      dropsCreated: typeof logistics.dropsCreated === "number" ? logistics.dropsCreated as number : 0,
      dropToPickupLatencyAvg: typeof logistics.dropToPickupLatencyAvg === "number" ? logistics.dropToPickupLatencyAvg as number : 0,
      gridNodeUtilization: typeof logistics.gridNodeUtilization === "number" ? logistics.gridNodeUtilization as number : 0,
      fabricatorSourceFetches: typeof logistics.fabricatorSourceFetches === "number" ? logistics.fabricatorSourceFetches as number : 0,
      haulerIdleCount: typeof logistics.haulerIdleCount === "number" ? logistics.haulerIdleCount as number : 0
    },
    blueprints: Array.isArray(parsed.blueprints)
      ? parsed.blueprints.flatMap((b) => {
          if (!isRecord(b) || typeof b.name !== "string") return [];
          return [{ name: b.name as string, timesSpawned: typeof b.timesSpawned === "number" ? b.timesSpawned as number : 0 }];
        })
      : [],
    architect: {
      structuresPlaced: isRecord(parsed.architect) && typeof parsed.architect.structuresPlaced === "number"
        ? parsed.architect.structuresPlaced as number : 0,
      roadCoverage: isRecord(parsed.architect) && typeof parsed.architect.roadCoverage === "number"
        ? parsed.architect.roadCoverage as number : 0,
      lastPlacementTick: isRecord(parsed.architect) && typeof parsed.architect.lastPlacementTick === "number"
        ? parsed.architect.lastPlacementTick as number : 0,
      tierCompletionTicks: isRecord(parsed.architect) && isNumberRecord(parsed.architect.tierCompletionTicks)
        ? parsed.architect.tierCompletionTicks : {}
    }
  };
}

export function buildNexusTelemetryByRole(values: Record<VariantRole, string | null>): Record<VariantRole, NexusTelemetrySnapshot | null> {
  return {
    baseline: parseNexusTelemetry(values.baseline),
    candidate: parseNexusTelemetry(values.candidate)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === "number");
}
