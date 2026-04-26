# Nexus Experiments Integration Design

**Date:** 2026-04-26  
**Scope:** Adapt `bots/nexus` to the autoscreeps experiments framework with extended telemetry and CLI support.

---

## Goals

- Nexus writes rich telemetry to segment 43 every 25 ticks
- CLI extended to read nexus telemetry and extract experiment metrics
- Nexus-vs-nexus duels and suites supported via `--bot nexus` flag
- Nexus exposes metrics basic cannot: Cortex scheduling, Logistics grid, Blueprint efficiency, Architect buildout, Protocol health

## Out of Scope

- Nexus-vs-basic duels
- Shared telemetry format with basic (formats are extended independently)
- Automated tests in nexus (unchanged constraint from CLAUDE.md)

---

## Architecture

### Telemetry Integration in Tick Lifecycle

```
Main.kt tick loop
  → Nexus.run()           [existing]
  → Telemetry.observe()   [new, post-run]
      reads Cortex.schedulingStats
      reads Forge.spawnLog
      reads Grid.routingStats
      reads each Protocol.stats
      reads Architect.placementLog
  → Telemetry.flush()     [every 25 ticks → segment 43]
```

`Telemetry.kt` is a new singleton. All subsystems expose lightweight stats structs (increment/record calls only — no hot-path loops). `Telemetry.observe()` reads these structs; subsystems do not call Telemetry directly.

### Segment Assignment

| Segment | Bot   | Content                  |
|---------|-------|--------------------------|
| 42      | basic | `BotTelemetrySnapshot`   |
| 43      | nexus | `NexusTelemetrySnapshot` |

---

## Snapshot Schema (Kotlin)

```kotlin
data class NexusTelemetrySnapshot(
    val tick: Int,
    val colony: ColonySnapshot,
    val cortex: CortexSnapshot,
    val spawn: SpawnSnapshot,
    val protocols: List<ProtocolSnapshot>,
    val logistics: LogisticsSnapshot,
    val blueprints: List<BlueprintSnapshot>,
    val architect: ArchitectSnapshot
)

data class ColonySnapshot(
    val rcl: Int,
    val controllerProgress: Int,
    val controllerProgressTotal: Int,
    val totalCreeps: Int,
    val creepsByProtocol: Map<String, Int>   // protocolType → count
)

data class CortexSnapshot(
    val protocolsScheduled: Int,
    val protocolsSkipped: Int,               // deferred due to CPU or priority
    val beaconQueueDepth: Int,
    val priorityDistribution: Map<String, Int> // priority tier → protocol count
)

data class SpawnSnapshot(
    val queueDepth: Int,
    val spawning: Boolean,
    val lastBlueprintUsed: String?,
    val spawnEventsTick: Int,                // spawns this interval
    val idleSpawnTicks: Int                  // ticks spawn was free but queue empty
)

data class ProtocolSnapshot(
    val type: String,
    val id: String,
    val creepCount: Int,
    val routineCompletions: Int,
    val routineFailures: Int,
    val ticksActive: Int,
    val created: Boolean,                    // created this interval
    val destroyed: Boolean                   // destroyed this interval
)

data class LogisticsSnapshot(
    val activeConduits: Int,
    val totalEnergyRouted: Int,
    val dropsCreated: Int,
    val dropToPickupLatencyAvg: Int,         // ticks
    val gridNodeUtilization: Double          // 0.0–1.0
)

data class BlueprintSnapshot(
    val name: String,
    val timesSpawned: Int,
    val avgBodyCost: Int,
    val partComposition: Map<String, Int>    // partType → count
)

data class ArchitectSnapshot(
    val structuresPlaced: Int,
    val roadCoverage: Double,                // 0.0–1.0
    val lastPlacementTick: Int,
    val tierCompletionTicks: Map<Int, Int>   // rcl → tick when tier was placed
)
```

---

## New Kotlin Files

| File | Purpose |
|------|---------|
| `src/telemetry/Telemetry.kt` | Singleton: observe, aggregate, flush to segment 43 |
| `src/telemetry/NexusTelemetrySnapshot.kt` | Data class definitions |
| `src/telemetry/TelemetryStats.kt` | Lightweight stats structs exposed by each subsystem |

### Subsystem Instrumentation Points

Each subsystem adds a `stats` property (a `TelemetryStats` subtype) that Telemetry reads:

| Subsystem | Stats exposed |
|-----------|--------------|
| `Cortex` | `schedulingStats`: scheduled/skipped counts, beacon queue depth, priority distribution |
| `Forge` | `spawnLog`: blueprint used, spawn events, idle ticks |
| `Protocol` | `stats`: creep count, routine completions/failures, ticks active, created/destroyed flags |
| `Grid` / `Conduit` | `routingStats`: energy routed, active conduits, drop-to-pickup latency, node utilization |
| `Architect` | `placementLog`: structures placed, road coverage, tier completion ticks |

---

## CLI Extension

### New File: `tools/autoscreeps-cli/src/lib/nexus-telemetry.ts`

```typescript
interface NexusTelemetrySnapshot { /* mirrors Kotlin schema */ }
interface NexusMetrics { /* scalar metrics for gate evaluation */ }

readNexusTelemetry(client): Promise<NexusTelemetrySnapshot | null>
extractNexusMetrics(snapshot): NexusMetrics
```

### Derived Metrics (`NexusMetrics`)

| Metric | Derivation |
|--------|-----------|
| `rclLevel` | `colony.rcl` |
| `controllerProgressPct` | `progress / progressTotal` |
| `spawnEfficiency` | `spawnEvents / (spawnEvents + idleSpawnTicks)` |
| `sourceCoverage` | mine protocol creeps / source count (from protocol list) |
| `cortexSkipRate` | `skipped / scheduled` |
| `logisticsRoutingEfficiency` | `energyRouted / dropsCreated` (drops from logistics snapshot) |
| `protocolChurnRate` | `(created + destroyed) / activeProtocols` |
| `blueprintCostEfficiency` | `avgBodyCost / routineCompletions` per blueprint |
| `architectRoadCoverage` | `architect.roadCoverage` |
| `tierCompletionTicks` | `architect.tierCompletionTicks` |

### CLI `--bot` Flag

`run-duel` and `run-suite` accept `--bot basic` (default, segment 42) or `--bot nexus` (segment 43). The flag is stored in suite metadata for experiment provenance. Auto-detection is not used — explicit declaration is required.

---

## Experiment Scenarios & Suites

### `experiments/scenarios/nexus-opener.yml`

Mirrors `basic-opener.yml`:
- Terminal: reach RCL 3, or controller destroyed
- Room mutations: grant extensions at RCL 2
- Max ticks / tick duration: same as basic opener

### `experiments/scenarios/nexus-logistics.yml`

New scenario for logistics grid validation:
- Terminal: reach RCL 4
- Room mutations: reduced source yield (forces logistics efficiency)
- Longer max ticks to accommodate slower progression

### `experiments/suites/nexus-baseline.yml`

```yaml
bot: nexus
train:
  - scenario: nexus-opener
    cases: 3
holdout:
  - scenario: nexus-opener
    cases: 2
gates:
  primary:
    - rclLevel
    - spawnEfficiency
    - sourceCoverage
    - cortexSkipRate
```

---

## Error Handling

- If segment 43 is empty or unparseable, CLI logs a warning and skips that sample (same behaviour as basic's segment 42 handling)
- If a subsystem's stats struct is absent (subsystem not yet active), snapshot field uses zero-value defaults — no nullable fields in the snapshot to avoid CLI null-checks

---

## Implementation Order

1. `NexusTelemetrySnapshot.kt` + `TelemetryStats.kt` data classes
2. Stats properties on each subsystem (non-breaking additions)
3. `Telemetry.kt` singleton + segment 43 flush
4. Wire `Telemetry.observe()` into `Main.kt` after `Nexus.run()`
5. `nexus-telemetry.ts` CLI module
6. `--bot` flag on `run-duel` and `run-suite`
7. Scenario YAML files
8. Suite YAML file
