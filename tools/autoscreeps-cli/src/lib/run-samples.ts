import type { RoleRecord, RunSample, RunSampleRoomMetrics, RunSummaryMetrics, UserRunSummaryMetrics, UserSampleMetrics, VariantRole } from "./contracts.ts";

const trackedControllerLevels = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const rcl1ProgressTotal = 200;
const totalProgressToRcl3 = rcl1ProgressTotal + 45000;
const rcl2ExtensionTarget = 5;

export function shouldCaptureRunSample(
  startGameTime: number,
  lastSampleGameTime: number | null,
  gameTime: number,
  sampleEveryTicks: number
): boolean {
  if (sampleEveryTicks <= 0) {
    return false;
  }

  if (lastSampleGameTime === null) {
    return true;
  }

  if (lastSampleGameTime <= startGameTime && gameTime <= startGameTime) {
    return true;
  }

  return gameTime - lastSampleGameTime >= sampleEveryTicks;
}

export function buildRunSummaryMetrics(samples: RunSample[], sampleEveryTicks: number): RunSummaryMetrics {
  const roles = collectRoles(samples);

  return {
    sampleEveryTicks,
    users: Object.fromEntries(roles.map((role) => [role, summarizeVariant(samples, role)])) as RoleRecord<UserRunSummaryMetrics>
  };
}

function collectRoles(samples: RunSample[]): VariantRole[] {
  const roles = new Set<VariantRole>();

  for (const sample of samples) {
    for (const role of Object.keys(sample.users) as VariantRole[]) {
      roles.add(role);
    }
  }

  return [...roles];
}

function summarizeVariant(samples: RunSample[], role: VariantRole): UserRunSummaryMetrics {
  const controllerLevelMilestones = initializeControllerLevelMilestones();
  let firstSeenGameTime: number | null = null;
  let controllerProgressToRCL3Pct: number | null = null;
  let maxCombinedRCL = 0;
  let maxOwnedControllers = 0;
  let firstExtensionTick: number | null = null;
  let allRcl2ExtensionsTick: number | null = null;
  let sampleCount = 0;
  let nexusTelemetrySampleCount = 0;
  let nexusSpawnEventSamples = 0;
  let nexusTotalSpawnEvents = 0;
  let nexusTotalIdleSpawnTicks = 0;
  let nexusSourceCoverageSamples = 0;
  let nexusTotalSourceCoverage = 0;
  let nexusCortexSkipSamples = 0;
  let nexusTotalScheduled = 0;
  let nexusTotalSkipped = 0;
  let nexusLogisticsSamples = 0;
  let nexusTotalEnergyRouted = 0;
  let nexusTotalDropsCreated = 0;
  let nexusChurnSamples = 0;
  let nexusTotalChurnRate = 0;
  let nexusRoadCoverageSamples = 0;
  let nexusTotalRoadCoverage = 0;

  for (const sample of samples) {
    const stats = sample.users[role];
    if (!stats) {
      continue;
    }

    sampleCount += 1;
    firstSeenGameTime ??= sample.gameTime;
    maxCombinedRCL = Math.max(maxCombinedRCL, stats.combinedRCL);
    maxOwnedControllers = Math.max(maxOwnedControllers, stats.ownedControllers);

    for (const level of trackedControllerLevels) {
      const key = String(level);
      if (controllerLevelMilestones[key] === null && stats.maxOwnedControllerLevel !== null && stats.maxOwnedControllerLevel >= level) {
        controllerLevelMilestones[key] = sample.gameTime;
      }
    }

    const room = sample.rooms?.[role];
    const progress = calculateControllerProgressToRcl3Pct(room, stats);
    if (progress !== null) {
      controllerProgressToRCL3Pct = progress;
    }

    const extensions = room?.extensions;
    if (typeof extensions === "number") {
      if (firstExtensionTick === null && extensions > 0) {
        firstExtensionTick = sample.gameTime;
      }
      if (allRcl2ExtensionsTick === null && extensions >= rcl2ExtensionTarget) {
        allRcl2ExtensionsTick = sample.gameTime;
      }
    }

    const nexusTelemetry = sample.nexusTelemetry?.[role];
    if (nexusTelemetry) {
      nexusTelemetrySampleCount++;

      const spawnEvents = nexusTelemetry.spawn.spawnEvents;
      const idleSpawnTicks = nexusTelemetry.spawn.idleSpawnTicks;
      if (spawnEvents + idleSpawnTicks > 0) {
        nexusSpawnEventSamples++;
        nexusTotalSpawnEvents += spawnEvents;
        nexusTotalIdleSpawnTicks += idleSpawnTicks;
      }

      const mineProtocols = nexusTelemetry.protocols.filter((p) =>
        p.type.toLowerCase().includes("mine") || p.type.toLowerCase().includes("extract")
      );
      if (mineProtocols.length > 0) {
        nexusSourceCoverageSamples++;
        nexusTotalSourceCoverage += mineProtocols.filter((p) => p.creepCount > 0).length / Math.max(mineProtocols.length, 1);
      }

      const scheduled = nexusTelemetry.cortex.protocolsScheduled;
      const skipped = nexusTelemetry.cortex.protocolsSkipped;
      if (scheduled + skipped > 0) {
        nexusCortexSkipSamples++;
        nexusTotalScheduled += scheduled;
        nexusTotalSkipped += skipped;
      }

      const dropsCreated = nexusTelemetry.logistics.dropsCreated;
      if (dropsCreated > 0) {
        nexusLogisticsSamples++;
        nexusTotalEnergyRouted += nexusTelemetry.logistics.totalEnergyRouted;
        nexusTotalDropsCreated += dropsCreated;
      }

      const activeProtocols = nexusTelemetry.protocols.length;
      if (activeProtocols > 0) {
        const churnCount = nexusTelemetry.protocols.filter((p) => p.created || p.destroyed).length;
        nexusChurnSamples++;
        nexusTotalChurnRate += churnCount / activeProtocols;
      }

      if (nexusTelemetry.architect.roadCoverage > 0) {
        nexusRoadCoverageSamples++;
        nexusTotalRoadCoverage += nexusTelemetry.architect.roadCoverage;
      }
    }
  }

  return {
    sampleCount,
    firstSeenGameTime,
    controllerLevelMilestones,
    controllerProgressToRCL3Pct,
    maxCombinedRCL,
    maxOwnedControllers,
    firstExtensionTick,
    allRcl2ExtensionsTick,
    nexusTelemetrySampleCount,
    nexusSpawnEfficiencyPct: nexusSpawnEventSamples > 0
      ? toPercent(nexusTotalSpawnEvents, nexusTotalSpawnEvents + nexusTotalIdleSpawnTicks)
      : null,
    nexusSourceCoveragePct: nexusSourceCoverageSamples > 0
      ? toPercent(nexusTotalSourceCoverage, nexusSourceCoverageSamples)
      : null,
    nexusCortexSkipRatePct: nexusCortexSkipSamples > 0
      ? toPercent(nexusTotalSkipped, nexusTotalScheduled + nexusTotalSkipped)
      : null,
    nexusLogisticsEfficiencyPct: nexusLogisticsSamples > 0
      ? toPercent(nexusTotalEnergyRouted, nexusTotalDropsCreated * 300)
      : null,
    nexusProtocolChurnRatePct: nexusChurnSamples > 0
      ? toPercent(nexusTotalChurnRate, nexusChurnSamples)
      : null,
    nexusRoadCoverage: nexusRoadCoverageSamples > 0
      ? Math.round((nexusTotalRoadCoverage / nexusRoadCoverageSamples) * 10000) / 100
      : null
  };
}

function initializeControllerLevelMilestones(): Record<string, number | null> {
  const milestones: Record<string, number | null> = {};

  for (const level of trackedControllerLevels) {
    milestones[String(level)] = null;
  }

  return milestones;
}

function calculateControllerProgressToRcl3Pct(room: RunSampleRoomMetrics | undefined, stats: UserSampleMetrics): number | null {
  const controllerLevel = room?.controllerLevel ?? stats.maxOwnedControllerLevel;
  if (controllerLevel === null) {
    return null;
  }

  if (controllerLevel >= 3) {
    return 100;
  }

  const controllerProgress = room?.controllerProgress;
  if (typeof controllerProgress !== "number") {
    return controllerLevel >= 2 ? normalizeControllerProgressToRcl3Pct(rcl1ProgressTotal) : null;
  }

  if (controllerLevel <= 1) {
    return normalizeControllerProgressToRcl3Pct(controllerProgress);
  }

  return normalizeControllerProgressToRcl3Pct(rcl1ProgressTotal + controllerProgress);
}

function normalizeControllerProgressToRcl3Pct(progress: number): number {
  const boundedProgress = Math.min(Math.max(progress, 0), totalProgressToRcl3);
  return Math.round((boundedProgress / totalProgressToRcl3) * 10000) / 100;
}

function toPercent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10000) / 100;
}
