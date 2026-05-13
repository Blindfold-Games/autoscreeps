import { describe, expect, it } from "vitest";
import { parseNexusTelemetry } from "../src/lib/nexus-telemetry.ts";

const baseSnapshot = {
  schemaVersion: 1,
  tick: 500,
  colony: { rcl: 2, controllerProgress: 5000, controllerProgressTotal: 45000, totalCreeps: 20, creepsByProtocol: {} },
  cortex: { protocolsScheduled: 5, protocolsSkipped: 0, beaconQueueDepth: 2, priorityDistribution: {} },
  spawn: { queueDepth: 1, spawning: false, spawnEvents: 0, idleSpawnTicks: 0, lastBlueprintUsed: null },
  protocols: [],
  logistics: {
    activeConduits: 3,
    totalEnergyRouted: 100,
    dropsCreated: 2,
    dropToPickupLatencyAvg: 5,
    gridNodeUtilization: 0.7,
    fabricatorSourceFetches: 4,
    haulerIdleCount: 2
  },
  blueprints: [],
  architect: { structuresPlaced: 10, roadCoverage: 0.5, lastPlacementTick: 200, tierCompletionTicks: {} }
};

describe("parseNexusTelemetry", () => {
  it("parses fabricatorSourceFetches and haulerIdleCount", () => {
    const result = parseNexusTelemetry(JSON.stringify(baseSnapshot));
    expect(result).not.toBeNull();
    expect(result!.logistics.fabricatorSourceFetches).toBe(4);
    expect(result!.logistics.haulerIdleCount).toBe(2);
  });

  it("defaults fabricatorSourceFetches to 0 when absent", () => {
    const snap = { ...baseSnapshot, logistics: { ...baseSnapshot.logistics } };
    delete (snap.logistics as any).fabricatorSourceFetches;
    const result = parseNexusTelemetry(JSON.stringify(snap));
    expect(result!.logistics.fabricatorSourceFetches).toBe(0);
  });

  it("defaults haulerIdleCount to 0 when absent", () => {
    const snap = { ...baseSnapshot, logistics: { ...baseSnapshot.logistics } };
    delete (snap.logistics as any).haulerIdleCount;
    const result = parseNexusTelemetry(JSON.stringify(snap));
    expect(result!.logistics.haulerIdleCount).toBe(0);
  });
});
