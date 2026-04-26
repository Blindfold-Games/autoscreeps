# Nexus Experiments Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instrument `bots/nexus` with rich telemetry written to memory segment 43, extend the CLI to read and derive metrics from it, and wire nexus into the experiment suite system for nexus-vs-nexus duels.

**Architecture:** Nexus writes a `NexusTelemetrySnapshot` (dynamic JS object → JSON) to segment 43 every 25 ticks from a new `Telemetry.kt` singleton that reads existing stats from Cortex, Forge, Grid, Architect, and Protocol subsystems. The CLI gains a `nexus-telemetry.ts` module plus extensions to `contracts.ts`, `run-samples.ts`, `suite-manifest.ts`, and `suite-runner.ts` to parse, aggregate, and gate-evaluate the new metrics. Scenarios declare `bot: nexus` to route telemetry reads to segment 43.

**Tech Stack:** Kotlin/JS (Gradle), TypeScript (Node), Zod (schema), YAML

---

## File Map

**Created:**
- `bots/nexus/src/jsMain/kotlin/telemetry/TelemetryStats.kt` — mutable per-interval stat accumulators owned by each subsystem
- `bots/nexus/src/jsMain/kotlin/telemetry/Telemetry.kt` — singleton that observes all sectors and flushes JSON to segment 43
- `bots/nexus/package.json` — npm wrapper so the CLI can build nexus via `npm run build`
- `bots/nexus/package-lock.json` — minimal lockfile (no npm deps, allows `npm ci`)
- `tools/autoscreeps-cli/src/lib/nexus-telemetry.ts` — segment 43 parser + metric extractor
- `experiments/scenarios/nexus-opener.yaml`
- `experiments/scenarios/nexus-logistics.yaml`
- `experiments/suites/nexus-baseline.yaml`

**Modified:**
- `bots/nexus/src/jsMain/kotlin/memory/Segments.kt` — add `TELEMETRY = 43`
- `bots/nexus/src/jsMain/kotlin/nexus/Cortex.kt` — expose scheduling stats
- `bots/nexus/src/jsMain/kotlin/modules/Forge.kt` — expose spawn-log stats
- `bots/nexus/src/jsMain/kotlin/logistics/Grid.kt` — add energy-routed counter
- `bots/nexus/src/jsMain/kotlin/protocols/Protocol.kt` — add routine completion/failure counters
- `bots/nexus/src/jsMain/kotlin/Main.kt` — call `Telemetry.observe()` and `Telemetry.flush()`
- `tools/autoscreeps-cli/src/lib/contracts.ts` — add `NexusTelemetrySnapshot`, extend `RunSample` and `UserRunSummaryMetrics`
- `tools/autoscreeps-cli/src/lib/bot-telemetry.ts` — add nexus segment ID constant
- `tools/autoscreeps-cli/src/lib/scenario.ts` — add `bot` field to scenario schema
- `tools/autoscreeps-cli/src/lib/runner.ts` — read segment 43 when `bot = nexus`
- `tools/autoscreeps-cli/src/lib/run-samples.ts` — add nexus metric derivation to `summarizeVariant`
- `tools/autoscreeps-cli/src/lib/suite-manifest.ts` — add nexus primary metric names to `suitePrimaryMetricSchema`
- `tools/autoscreeps-cli/src/lib/suite-runner.ts` — add nexus cases to `metricValue` and `metricDirection`

---

### Task 1: Add TELEMETRY segment ID

**Files:**
- Modify: `bots/nexus/src/jsMain/kotlin/memory/Segments.kt:11-14`

- [ ] **Step 1: Add the constant**

In `Segments.kt`, extend `SegmentId`:

```kotlin
object SegmentId {
    const val ROOM_SEGMENT_BASE = 20
    const val ERROR_LOG = 10
    const val TELEMETRY = 43
}
```

- [ ] **Step 2: Verify build still passes**

```bash
cd bots/nexus && ./gradlew build 2>&1 | tail -5
```

Expected: `BUILD SUCCESSFUL`

- [ ] **Step 3: Commit**

```bash
git add bots/nexus/src/jsMain/kotlin/memory/Segments.kt
git commit -m "feat(nexus): add telemetry segment ID 43"
```

---

### Task 2: Add TelemetryStats.kt

**Files:**
- Create: `bots/nexus/src/jsMain/kotlin/telemetry/TelemetryStats.kt`

These are lightweight mutable accumulators owned by each subsystem. Telemetry reads them once per interval then calls `reset()`.

- [ ] **Step 1: Create the file**

```kotlin
package telemetry

class CortexIntervalStats {
    var protocolsScheduled: Int = 0
    var protocolsSkipped: Int = 0

    fun reset() {
        protocolsScheduled = 0
        protocolsSkipped = 0
    }
}

class ForgeIntervalStats {
    var spawnEvents: Int = 0
    var idleSpawnTicks: Int = 0
    var lastBlueprintUsed: String? = null

    fun reset() {
        spawnEvents = 0
        idleSpawnTicks = 0
        lastBlueprintUsed = null
    }
}

class GridIntervalStats {
    var energyRouted: Int = 0
    var dropsRegistered: Int = 0

    fun reset() {
        energyRouted = 0
        dropsRegistered = 0
    }
}

class ProtocolIntervalStats {
    var routineCompletions: Int = 0
    var routineFailures: Int = 0
    var ticksActive: Int = 0
    var createdThisInterval: Boolean = false
    var destroyedThisInterval: Boolean = false

    fun reset() {
        routineCompletions = 0
        routineFailures = 0
        ticksActive = 0
        createdThisInterval = false
        destroyedThisInterval = false
    }
}
```

- [ ] **Step 2: Build**

```bash
cd bots/nexus && ./gradlew build 2>&1 | tail -5
```

Expected: `BUILD SUCCESSFUL`

- [ ] **Step 3: Commit**

```bash
git add bots/nexus/src/jsMain/kotlin/telemetry/TelemetryStats.kt
git commit -m "feat(nexus): add telemetry interval stats accumulators"
```

---

### Task 3: Instrument Cortex

**Files:**
- Modify: `bots/nexus/src/jsMain/kotlin/nexus/Cortex.kt`

Expose a `telemetryStats` object and increment it in `init()` and `run()`.

- [ ] **Step 1: Add import and stats field**

At the top of `Cortex.kt`, add:

```kotlin
import telemetry.CortexIntervalStats
```

Inside the `Cortex` class body (before existing fields):

```kotlin
val telemetryStats = CortexIntervalStats()
```

- [ ] **Step 2: Track scheduled/skipped in init()**

In `Cortex.init()`, replace the inner loop body with tracking. Current loop:

```kotlin
for (protocol in sortedProtocols) {
    if (!isProtocolSuspended(protocol)) {
        safeExec(...) { protocol.preInit() }
        safeExec(...) { protocol.init() }
    }
}
```

Change to:

```kotlin
for (protocol in sortedProtocols) {
    if (!isProtocolSuspended(protocol)) {
        telemetryStats.protocolsScheduled++
        safeExec("Protocol.preInit[${protocol.ref}]") {
            if (measured) CpuProfiler.measure("protocol.${protocol.ref}.preInit") { protocol.preInit() }
            else protocol.preInit()
        }
        safeExec("Protocol.init[${protocol.ref}]") {
            if (measured) CpuProfiler.measure("protocol.${protocol.ref}.init") { protocol.init() }
            else protocol.init()
        }
    } else {
        telemetryStats.protocolsSkipped++
    }
}
```

- [ ] **Step 3: Build**

```bash
cd bots/nexus && ./gradlew build 2>&1 | tail -5
```

Expected: `BUILD SUCCESSFUL`

- [ ] **Step 4: Commit**

```bash
git add bots/nexus/src/jsMain/kotlin/nexus/Cortex.kt
git commit -m "feat(nexus): expose cortex scheduling stats for telemetry"
```

---

### Task 4: Instrument Forge

**Files:**
- Modify: `bots/nexus/src/jsMain/kotlin/modules/Forge.kt`

Expose a `telemetryStats` object. The Forge already tracks `spawnTicksBusy` and `spawnQueue`. Add tracking for spawn events and blueprint usage.

- [ ] **Step 1: Add import and stats field**

Add to imports:

```kotlin
import telemetry.ForgeIntervalStats
```

Add field inside `Forge` class, after `private var spawnTicksBusy: Int = 0`:

```kotlin
val telemetryStats = ForgeIntervalStats()
```

- [ ] **Step 2: Increment spawnEvents on successful spawn**

In `processQueue()`, after the `if (result == OK)` log line, add:

```kotlin
if (result == OK) {
    Log.info("Forge[${sector.name}]: Spawning $name (${request.blueprint.role}) for ${request.protocol.ref}")
    telemetryStats.spawnEvents++
    telemetryStats.lastBlueprintUsed = request.blueprint.role
    spawnsAvailable.remove(spawn)
    // ... rest of existing code
}
```

- [ ] **Step 3: Track idle ticks in recordSpawnUtilization()**

In `recordSpawnUtilization()`:

```kotlin
private fun recordSpawnUtilization() {
    spawnTicksTotal++
    if (spawns.any { it.spawning != null }) {
        spawnTicksBusy++
    } else if (spawnQueue.isNotEmpty()) {
        telemetryStats.idleSpawnTicks++
    }
}
```

- [ ] **Step 4: Build**

```bash
cd bots/nexus && ./gradlew build 2>&1 | tail -5
```

Expected: `BUILD SUCCESSFUL`

- [ ] **Step 5: Commit**

```bash
git add bots/nexus/src/jsMain/kotlin/modules/Forge.kt
git commit -m "feat(nexus): expose forge spawn-log stats for telemetry"
```

---

### Task 5: Instrument Grid

**Files:**
- Modify: `bots/nexus/src/jsMain/kotlin/logistics/Grid.kt`

Add an interval stats accumulator to track energy routed and drops registered.

- [ ] **Step 1: Add import and stats field**

Add to imports:

```kotlin
import telemetry.GridIntervalStats
```

Add field inside `Grid` class, after `val dropResources`:

```kotlin
val telemetryStats = GridIntervalStats()
```

- [ ] **Step 2: Track drops in registerDrop()**

In `registerDrop()`, after `dropResources.add(resource)`:

```kotlin
fun registerDrop(resource: Resource) {
    if (resource.amount > DROPPED_ENERGY_THRESHOLD) {
        dropResources.add(resource)
        telemetryStats.dropsRegistered++
        // ... existing request creation code
    }
}
```

- [ ] **Step 3: Track energy routed in computeAssignments()**

At the end of `computeAssignments()`, before the return statement, add energy-routed accounting:

```kotlin
// Tally energy matched to input requests (positive amount = input)
for ((_, request) in result) {
    if (request.amount > 0) {
        telemetryStats.energyRouted += request.amount
    }
}

_assignments = result
_assignmentTick = Game.time
return result
```

- [ ] **Step 4: Reset stats in refresh()**

In `Grid.refresh()`, add:

```kotlin
fun refresh() {
    requests.clear()
    dropResources.clear()
    _buffers = null
    _assignments = null
    _nextAvailability.clear()
    _resourceChangeRate.clear()
    _targetedBy.clear()
    // Note: do NOT reset telemetryStats here — Telemetry reads before refresh()
}
```

- [ ] **Step 5: Build**

```bash
cd bots/nexus && ./gradlew build 2>&1 | tail -5
```

Expected: `BUILD SUCCESSFUL`

- [ ] **Step 6: Commit**

```bash
git add bots/nexus/src/jsMain/kotlin/logistics/Grid.kt
git commit -m "feat(nexus): expose grid routing stats for telemetry"
```

---

### Task 6: Instrument Protocol

**Files:**
- Modify: `bots/nexus/src/jsMain/kotlin/protocols/Protocol.kt`

Add `telemetryStats` to `Protocol` base class. Track routine completions in `autoRun` and tick activity.

- [ ] **Step 1: Add import and stats field**

Add to imports:

```kotlin
import telemetry.ProtocolIntervalStats
```

Add field inside `Protocol` class, after `val spawnRequests`:

```kotlin
val telemetryStats = ProtocolIntervalStats()
val createdAtTick: Int = screeps.api.Game.time
```

- [ ] **Step 2: Track completions in autoRun()**

In `autoRun()`, after each `handler(synth)` call, increment completions. Change the `for (synth in synthList)` loop:

```kotlin
fun autoRun(
    synthList: List<Synth>,
    fleeCheck: ((Synth) -> Boolean)? = null,
    handler: (Synth) -> Unit
) {
    val measured = Settings.enableCpuPhaseProfiler
    for (synth in synthList) {
        if (fleeCheck != null && fleeCheck(synth)) continue
        synth.tidyRoutine()
        var handlerSucceeded = false
        if (measured) {
            CpuProfiler.measure("protocol.$ref.handler") {
                handler(synth)
                handlerSucceeded = true
            }
        } else {
            try {
                handler(synth)
                handlerSucceeded = true
            } catch (e: Throwable) {
                telemetryStats.routineFailures++
            }
        }
        if (handlerSucceeded) telemetryStats.routineCompletions++
        val shouldRunSynth = synth.hasValidRoutine || synth.pendingRoutines.isNotEmpty()
        if (shouldRunSynth) {
            if (measured) {
                CpuProfiler.measure("protocol.$ref.synthRun") { synth.run() }
            } else {
                synth.run()
            }
        }
    }
}
```

- [ ] **Step 3: Track ticksActive in refresh()**

In `Protocol.refresh()`, add:

```kotlin
open fun refresh() {
    spawnRequests.clear()
    synthsByRole.clear()
    roleDemandReports.clear()
    telemetryStats.ticksActive++
}
```

- [ ] **Step 4: Build**

```bash
cd bots/nexus && ./gradlew build 2>&1 | tail -5
```

Expected: `BUILD SUCCESSFUL`

- [ ] **Step 5: Commit**

```bash
git add bots/nexus/src/jsMain/kotlin/protocols/Protocol.kt
git commit -m "feat(nexus): add protocol routine completion tracking for telemetry"
```

---

### Task 7: Create Telemetry.kt

**Files:**
- Create: `bots/nexus/src/jsMain/kotlin/telemetry/Telemetry.kt`

The singleton that reads stats from all subsystems and writes a JSON snapshot to segment 43 every 25 ticks.

- [ ] **Step 1: Create the file**

```kotlin
package telemetry

import memory.SegmentId
import memory.Segments
import nexus.Nexus
import screeps.api.Game

object Telemetry {
    private const val FLUSH_INTERVAL = 25
    private var lastFlushTick = -1

    /** Track which protocol refs existed last interval to detect created/destroyed. */
    private var lastKnownProtocolRefs: Set<String> = emptySet()

    fun observe() {
        val sector = Nexus.sectors.values.firstOrNull() ?: return
        val cortex = sector.cortex
        val forge = sector.forge

        // Mark protocol churn
        val currentRefs = cortex.protocols.map { it.ref }.toSet()
        val created = currentRefs - lastKnownProtocolRefs
        val destroyed = lastKnownProtocolRefs - currentRefs
        for (protocol in cortex.protocols) {
            if (protocol.ref in created) protocol.telemetryStats.createdThisInterval = true
            if (protocol.ref in destroyed) {
                // Protocol was destroyed — find old stats if possible; skip since it's gone
            }
        }
        lastKnownProtocolRefs = currentRefs

        // Tick-level observations (accumulated, not reset)
        forge?.telemetryStats?.let { stats ->
            // idleSpawnTicks already tracked in Forge.recordSpawnUtilization()
        }

        if (Game.time - lastFlushTick >= FLUSH_INTERVAL) {
            flush()
        }
    }

    private fun flush() {
        val sector = Nexus.sectors.values.firstOrNull() ?: return
        val snapshot = buildSnapshot(sector)
        Segments.requestActivation(SegmentId.TELEMETRY)
        Segments.set(SegmentId.TELEMETRY, snapshot)
        lastFlushTick = Game.time

        // Reset interval accumulators
        sector.cortex.telemetryStats.reset()
        sector.forge?.telemetryStats?.reset()
        sector.grid.telemetryStats.reset()
        for (protocol in sector.cortex.protocols) {
            protocol.telemetryStats.reset()
        }
    }

    private fun buildSnapshot(sector: nexus.Sector): String {
        val cortex = sector.cortex
        val forge = sector.forge
        val grid = sector.grid
        val architect = sector.architect

        val snap: dynamic = js("{}")
        snap.schemaVersion = 1
        snap.tick = Game.time

        // Colony
        val colony: dynamic = js("{}")
        colony.rcl = sector.level
        colony.controllerProgress = sector.controller.progress
        colony.controllerProgressTotal = sector.controller.progressTotal
        colony.totalCreeps = Game.creeps.entries.count { it.value.my }
        val byProto: dynamic = js("{}")
        for (protocol in cortex.protocols) {
            val typeName = protocol.name
            val existing = byProto[typeName]
            byProto[typeName] = if (existing == null || existing == undefined) {
                protocol.synthsByRole.values.sumOf { it.size }
            } else {
                (existing as Int) + protocol.synthsByRole.values.sumOf { it.size }
            }
        }
        colony.creepsByProtocol = byProto
        snap.colony = colony

        // Cortex
        val cortexSnap: dynamic = js("{}")
        cortexSnap.protocolsScheduled = cortex.telemetryStats.protocolsScheduled
        cortexSnap.protocolsSkipped = cortex.telemetryStats.protocolsSkipped
        cortexSnap.beaconQueueDepth = cortex.beacons.size
        val priDist: dynamic = js("{}")
        for (protocol in cortex.protocols) {
            val tier = protocol.priority.toString()
            val existing = priDist[tier]
            priDist[tier] = if (existing == null || existing == undefined) 1 else (existing as Int) + 1
        }
        cortexSnap.priorityDistribution = priDist
        snap.cortex = cortexSnap

        // Spawn
        val spawnSnap: dynamic = js("{}")
        spawnSnap.queueDepth = forge?.spawnQueue?.size ?: 0
        spawnSnap.spawning = forge?.spawns?.any { it.spawning != null } ?: false
        spawnSnap.spawnEvents = forge?.telemetryStats?.spawnEvents ?: 0
        spawnSnap.idleSpawnTicks = forge?.telemetryStats?.idleSpawnTicks ?: 0
        spawnSnap.lastBlueprintUsed = forge?.telemetryStats?.lastBlueprintUsed
        snap.spawn = spawnSnap

        // Protocols
        val protocolsArr: dynamic = js("[]")
        for (protocol in cortex.protocols) {
            val p: dynamic = js("{}")
            p.type = protocol.name
            p.id = protocol.ref
            p.creepCount = protocol.synthsByRole.values.sumOf { it.size }
            p.routineCompletions = protocol.telemetryStats.routineCompletions
            p.routineFailures = protocol.telemetryStats.routineFailures
            p.ticksActive = protocol.telemetryStats.ticksActive
            p.created = protocol.telemetryStats.createdThisInterval
            p.destroyed = protocol.telemetryStats.destroyedThisInterval
            protocolsArr.push(p)
        }
        snap.protocols = protocolsArr

        // Logistics
        val logSnap: dynamic = js("{}")
        logSnap.activeConduits = (sector.conduit.transmit.size + sector.conduit.receive.size)
        logSnap.totalEnergyRouted = grid.telemetryStats.energyRouted
        logSnap.dropsCreated = grid.telemetryStats.dropsRegistered
        logSnap.dropToPickupLatencyAvg = 0
        logSnap.gridNodeUtilization = if (grid.requests.size > 0) {
            val assignments = grid.computeAssignments(emptyList())
            assignments.size.toDouble() / grid.requests.size.toDouble()
        } else 0.0
        snap.logistics = logSnap

        // Blueprints (aggregate from protocols' spawn demand reports)
        val blueprintMap: dynamic = js("{}")
        for (protocol in cortex.protocols) {
            for (report in protocol.spawnDemandReport()) {
                val name = report.role
                val existing = blueprintMap[name]
                if (existing == null || existing == undefined) {
                    val bp: dynamic = js("{}")
                    bp.name = name
                    bp.timesSpawned = 0
                    blueprintMap[name] = bp
                }
            }
        }
        if (forge != null && forge.telemetryStats.lastBlueprintUsed != null) {
            val name = forge.telemetryStats.lastBlueprintUsed!!
            val existing = blueprintMap[name]
            if (existing != null && existing != undefined) {
                existing.timesSpawned = (existing.timesSpawned as Int) + forge.telemetryStats.spawnEvents
            }
        }
        val blueprintsArr: dynamic = js("[]")
        val bpKeys = js("Object.keys(blueprintMap)").unsafeCast<Array<String>>()
        for (key in bpKeys) {
            blueprintsArr.push(blueprintMap[key])
        }
        snap.blueprints = blueprintsArr

        // Architect
        val archSnap: dynamic = js("{}")
        if (architect != null) {
            archSnap.structuresPlaced = sector.room.find(screeps.api.FIND_MY_STRUCTURES).size
            archSnap.roadCoverage = computeRoadCoverage(sector)
            archSnap.lastPlacementTick = architect.memory.recheckAt as? Int ?: 0
            val tierTicks: dynamic = js("{}")
            archSnap.tierCompletionTicks = tierTicks
        } else {
            archSnap.structuresPlaced = 0
            archSnap.roadCoverage = 0.0
            archSnap.lastPlacementTick = 0
            archSnap.tierCompletionTicks = js("{}")
        }
        snap.architect = archSnap

        return JSON.stringify(snap)
    }

    private fun computeRoadCoverage(sector: nexus.Sector): Double {
        val totalRoads = sector.room.find(screeps.api.FIND_MY_STRUCTURES)
            .count { it.structureType == screeps.api.STRUCTURE_ROAD }
        if (totalRoads == 0) return 0.0
        val constructionRoads = sector.room.find(screeps.api.FIND_MY_CONSTRUCTION_SITES)
            .count { it.structureType == screeps.api.STRUCTURE_ROAD }
        val plannedRoads = totalRoads + constructionRoads
        return if (plannedRoads == 0) 0.0 else totalRoads.toDouble() / plannedRoads.toDouble()
    }
}
```

- [ ] **Step 2: Add missing imports at top of file**

The file needs these imports:

```kotlin
package telemetry

import memory.SegmentId
import memory.Segments
import nexus.Nexus
import screeps.api.Game
import screeps.api.FIND_MY_STRUCTURES
import screeps.api.FIND_MY_CONSTRUCTION_SITES
import screeps.api.STRUCTURE_ROAD
```

- [ ] **Step 3: Build**

```bash
cd bots/nexus && ./gradlew build 2>&1 | tail -20
```

Expected: `BUILD SUCCESSFUL`. Fix any type errors before committing.

- [ ] **Step 4: Commit**

```bash
git add bots/nexus/src/jsMain/kotlin/telemetry/
git commit -m "feat(nexus): add Telemetry singleton with segment 43 flush"
```

---

### Task 8: Wire Telemetry into Main.kt

**Files:**
- Modify: `bots/nexus/src/jsMain/kotlin/Main.kt:70-78`

Add `Telemetry.observe()` call after `Nexus.run()` in the main tick loop.

- [ ] **Step 1: Add import**

Add to imports in `Main.kt`:

```kotlin
import telemetry.Telemetry
```

- [ ] **Step 2: Add observe call**

In the `loop()` function, after `Nexus.run()` and `TrafficManager.run()` but before visuals. The non-profiler branch currently ends at:

```kotlin
MatrixCache.clearPerTick()
TrafficManager.clear()
Nexus.init()
Nexus.run()
TrafficManager.run()
```

Change to:

```kotlin
MatrixCache.clearPerTick()
TrafficManager.clear()
Nexus.init()
Nexus.run()
TrafficManager.run()
Telemetry.observe()
```

Also add the profiler branch:

```kotlin
CpuProfiler.measure("tick.phase.traffic.run") { TrafficManager.run() }
CpuProfiler.measure("tick.phase.telemetry") { Telemetry.observe() }
```

- [ ] **Step 3: Build**

```bash
cd bots/nexus && ./gradlew build 2>&1 | tail -5
```

Expected: `BUILD SUCCESSFUL`

- [ ] **Step 4: Commit**

```bash
git add bots/nexus/src/jsMain/kotlin/Main.kt
git commit -m "feat(nexus): wire Telemetry.observe() into tick loop"
```

---

### Task 9: Add npm build bridge

**Files:**
- Create: `bots/nexus/package.json`
- Create: `bots/nexus/package-lock.json`

The CLI `build.ts` expects `npm run build` to produce `dist/main.js`. The Gradle build produces `build/minified-js/main.js`. This task adds a thin npm wrapper.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "nexus",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "./gradlew build && mkdir -p dist && cp build/minified-js/main.js dist/main.js"
  }
}
```

- [ ] **Step 2: Create package-lock.json**

```json
{
  "name": "nexus",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "nexus",
      "version": "1.0.0"
    }
  }
}
```

- [ ] **Step 3: Verify the build script works**

```bash
cd bots/nexus && npm run build 2>&1 | tail -10
```

Expected: Gradle builds, then `dist/main.js` appears.

```bash
ls -lh bots/nexus/dist/main.js
```

Expected: file exists with non-zero size.

- [ ] **Step 4: Commit**

```bash
git add bots/nexus/package.json bots/nexus/package-lock.json
git commit -m "feat(nexus): add npm build bridge for experiment CLI"
```

---

### Task 10: Extend CLI contracts.ts

**Files:**
- Modify: `tools/autoscreeps-cli/src/lib/contracts.ts`

Add `NexusTelemetrySnapshot` type, extend `RunSample` with `nexusTelemetry`, and extend `UserRunSummaryMetrics` with nexus-specific metric fields.

- [ ] **Step 1: Add NexusTelemetrySnapshot type**

Add after the `BotTelemetrySnapshot` type (around line 197):

```typescript
export type NexusTelemetrySnapshot = {
  schemaVersion: number;
  tick: number;
  colony: {
    rcl: number;
    controllerProgress: number;
    controllerProgressTotal: number;
    totalCreeps: number;
    creepsByProtocol: Record<string, number>;
  };
  cortex: {
    protocolsScheduled: number;
    protocolsSkipped: number;
    beaconQueueDepth: number;
    priorityDistribution: Record<string, number>;
  };
  spawn: {
    queueDepth: number;
    spawning: boolean;
    spawnEvents: number;
    idleSpawnTicks: number;
    lastBlueprintUsed: string | null;
  };
  protocols: Array<{
    type: string;
    id: string;
    creepCount: number;
    routineCompletions: number;
    routineFailures: number;
    ticksActive: number;
    created: boolean;
    destroyed: boolean;
  }>;
  logistics: {
    activeConduits: number;
    totalEnergyRouted: number;
    dropsCreated: number;
    dropToPickupLatencyAvg: number;
    gridNodeUtilization: number;
  };
  blueprints: Array<{
    name: string;
    timesSpawned: number;
  }>;
  architect: {
    structuresPlaced: number;
    roadCoverage: number;
    lastPlacementTick: number;
    tierCompletionTicks: Record<string, number>;
  };
};
```

- [ ] **Step 2: Extend RunSample**

Change `RunSample` (around line 290) from:

```typescript
export type RunSample = {
  gameTime: number;
  users: Record<VariantRole, UserSampleMetrics>;
  rooms?: Record<VariantRole, RunSampleRoomMetrics>;
  telemetry?: Record<VariantRole, BotTelemetrySnapshot | null>;
};
```

To:

```typescript
export type RunSample = {
  gameTime: number;
  users: Record<VariantRole, UserSampleMetrics>;
  rooms?: Record<VariantRole, RunSampleRoomMetrics>;
  telemetry?: Record<VariantRole, BotTelemetrySnapshot | null>;
  nexusTelemetry?: Record<VariantRole, NexusTelemetrySnapshot | null>;
};
```

- [ ] **Step 3: Extend UserRunSummaryMetrics**

Add nexus fields to `UserRunSummaryMetrics` (around line 297):

```typescript
export type UserRunSummaryMetrics = {
  sampleCount: number;
  firstSeenGameTime: number | null;
  controllerLevelMilestones: Record<string, number | null>;
  controllerProgressToRCL3Pct: number | null;
  maxCombinedRCL: number;
  maxOwnedControllers: number;
  firstExtensionTick: number | null;
  allRcl2ExtensionsTick: number | null;
  telemetrySampleCount: number;
  spawnWaitingForSufficientEnergyPct: number | null;
  sourceCoveragePct: number | null;
  sourceUptimePct: number | null;
  harvestingSourceCoveragePct: number | null;
  harvestingSourceUptimePct: number | null;
  activeHarvestingSourceCoveragePct: number | null;
  activeHarvestingSourceUptimePct: number | null;
  // Nexus-specific metrics
  nexusTelemetrySampleCount: number;
  nexusSpawnEfficiencyPct: number | null;
  nexusSourceCoveragePct: number | null;
  nexusCortexSkipRatePct: number | null;
  nexusLogisticsEfficiencyPct: number | null;
  nexusProtocolChurnRatePct: number | null;
  nexusRoadCoverage: number | null;
};
```

- [ ] **Step 4: Build CLI (type-check)**

```bash
cd tools/autoscreeps-cli && npx tsc --noEmit 2>&1 | head -30
```

Expected: any errors will be in files we haven't updated yet — they'll be fixed in subsequent tasks. Errors only in `contracts.ts` itself mean a mistake in step 1-3.

- [ ] **Step 5: Commit**

```bash
git add tools/autoscreeps-cli/src/lib/contracts.ts
git commit -m "feat(cli): add NexusTelemetrySnapshot type and nexus metric fields"
```

---

### Task 11: Add nexus segment constant and parser

**Files:**
- Modify: `tools/autoscreeps-cli/src/lib/bot-telemetry.ts`
- Create: `tools/autoscreeps-cli/src/lib/nexus-telemetry.ts`

- [ ] **Step 1: Add nexus segment ID to bot-telemetry.ts**

In `bot-telemetry.ts`, add after the existing constant:

```typescript
export const nexusTelemetrySegmentId = 43;
```

- [ ] **Step 2: Create nexus-telemetry.ts**

```typescript
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
      gridNodeUtilization: typeof logistics.gridNodeUtilization === "number" ? logistics.gridNodeUtilization as number : 0
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
```

- [ ] **Step 3: Build CLI (type-check)**

```bash
cd tools/autoscreeps-cli && npx tsc --noEmit 2>&1 | grep nexus-telemetry
```

Expected: no errors in `nexus-telemetry.ts`.

- [ ] **Step 4: Commit**

```bash
git add tools/autoscreeps-cli/src/lib/bot-telemetry.ts tools/autoscreeps-cli/src/lib/nexus-telemetry.ts
git commit -m "feat(cli): add nexus telemetry parser for segment 43"
```

---

### Task 12: Add bot field to scenario schema

**Files:**
- Modify: `tools/autoscreeps-cli/src/lib/scenario.ts:52-73`

Add an optional `bot` field to the scenario schema so scenarios can declare which telemetry format they use.

- [ ] **Step 1: Add bot field to scenarioSchema**

In `scenario.ts`, change `scenarioSchema` to add the `bot` field:

```typescript
export const scenarioSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  description: z.string().optional(),
  bot: z.enum(["basic", "nexus"]).default("basic"),
  reset: z.enum(["full"]).default("full"),
  // ... rest unchanged
```

- [ ] **Step 2: Verify type exports are updated**

`ScenarioConfig` is auto-derived from `scenarioSchema`, so the `bot` field propagates automatically. Run:

```bash
cd tools/autoscreeps-cli && npx tsc --noEmit 2>&1 | head -20
```

Expected: no new errors from scenario.ts.

- [ ] **Step 3: Commit**

```bash
git add tools/autoscreeps-cli/src/lib/scenario.ts
git commit -m "feat(cli): add bot field to scenario schema for telemetry routing"
```

---

### Task 13: Extend runner.ts to read nexus telemetry

**Files:**
- Modify: `tools/autoscreeps-cli/src/lib/runner.ts`

When the scenario declares `bot: nexus`, read segment 43 instead of segment 42 and store in `sample.nexusTelemetry`.

- [ ] **Step 1: Add import**

At the top of `runner.ts`, add alongside the existing `bot-telemetry` import:

```typescript
import { nexusTelemetrySegmentId } from "./bot-telemetry.ts";
import { buildNexusTelemetryByRole } from "./nexus-telemetry.ts";
```

- [ ] **Step 2: Add nexus telemetry read in the polling section**

Find the `if (captureSample)` block (around line 306). The current code reads:

```typescript
if (captureSample) {
  const [baselineTelemetry, candidateTelemetry, baselineRoomObjects, candidateRoomObjects] = await Promise.all([
    api.getMemorySegment(baselineSession, autoscreepsTelemetrySegmentId),
    api.getMemorySegment(candidateSession, autoscreepsTelemetrySegmentId),
    api.getRoomObjects(runRecord.rooms.baseline),
    api.getRoomObjects(runRecord.rooms.candidate)
  ]);
  telemetryData = {
    baseline: baselineTelemetry,
    candidate: candidateTelemetry
  };
  // ...
```

Change to:

```typescript
if (captureSample) {
  const isNexus = scenario.config.bot === "nexus";
  const telemetrySegment = isNexus ? nexusTelemetrySegmentId : autoscreepsTelemetrySegmentId;
  const [baselineTelemetry, candidateTelemetry, baselineRoomObjects, candidateRoomObjects] = await Promise.all([
    api.getMemorySegment(baselineSession, telemetrySegment),
    api.getMemorySegment(candidateSession, telemetrySegment),
    api.getRoomObjects(runRecord.rooms.baseline),
    api.getRoomObjects(runRecord.rooms.candidate)
  ]);
  const rawTelemetry = {
    baseline: baselineTelemetry,
    candidate: candidateTelemetry
  };
  if (isNexus) {
    nexusTelemetryData = rawTelemetry;
  } else {
    telemetryData = rawTelemetry;
  }
  // ... rest of roomData unchanged
```

- [ ] **Step 3: Add nexusTelemetryData variable declaration**

Near the `let telemetryData` declaration (around line 299), add:

```typescript
let telemetryData: Record<VariantRole, string | null> | null = null;
let nexusTelemetryData: Record<VariantRole, string | null> | null = null;
let roomData: RunSample["rooms"] | null = null;
```

- [ ] **Step 4: Pass nexusTelemetryData to buildRunSample**

Where `buildRunSample` is called (line 351 and 414), pass the nexus data. Change the function signature call:

```typescript
const sample = buildRunSample(gameTime, stats, credentials, telemetryData, nexusTelemetryData, roomData);
```

- [ ] **Step 5: Update buildRunSample function signature**

Find `buildRunSample` (around line 668) and add the nexus parameter:

```typescript
function buildRunSample(
  gameTime: number,
  stats: StatsResponse,
  credentials: Record<VariantRole, { username: string }>,
  telemetryData: Record<VariantRole, string | null> | null,
  nexusTelemetryData: Record<VariantRole, string | null> | null,
  roomData: Record<VariantRole, RunSampleRoomMetrics> | null
): RunSample {
  const sample: RunSample = {
    gameTime,
    users: {
      baseline: summarizeUserTerminalStats(stats, credentials.baseline.username),
      candidate: summarizeUserTerminalStats(stats, credentials.candidate.username)
    }
  };

  if (roomData) {
    sample.rooms = roomData;
  }

  if (telemetryData) {
    sample.telemetry = buildTelemetryByRole(telemetryData);
  }

  if (nexusTelemetryData) {
    sample.nexusTelemetry = buildNexusTelemetryByRole(nexusTelemetryData);
  }

  return sample;
}
```

- [ ] **Step 6: Also pass nexusTelemetryData for the final sample (line ~414)**

Find the final sample call and add the same parameter:

```typescript
const finalSample = buildRunSample(endGameTime, finalStats, credentials, {
  baseline: null,
  candidate: null
}, null, { ... });
```

- [ ] **Step 7: Add scenario to DuelRunInput and thread it through**

The `scenario` object is available in the closure. Check that `scenario.config.bot` is accessible where the polling happens. If `scenario` isn't in scope at the polling point, assign `const isNexus = scenario.config.bot === "nexus"` before the polling loop and use the variable inside.

- [ ] **Step 8: Build CLI**

```bash
cd tools/autoscreeps-cli && npx tsc --noEmit 2>&1 | head -30
```

Fix any type errors before committing.

- [ ] **Step 9: Commit**

```bash
git add tools/autoscreeps-cli/src/lib/runner.ts
git commit -m "feat(cli): read nexus telemetry from segment 43 when bot=nexus"
```

---

### Task 14: Add nexus metric derivation to run-samples.ts

**Files:**
- Modify: `tools/autoscreeps-cli/src/lib/run-samples.ts`

Extend `summarizeVariant` to also compute nexus-specific summary metrics from `sample.nexusTelemetry`.

- [ ] **Step 1: Add nexus accumulators to summarizeVariant**

After the existing accumulator declarations in `summarizeVariant`, add:

```typescript
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
```

- [ ] **Step 2: Accumulate nexus telemetry in the sample loop**

After the existing telemetry block inside the `for (const sample of samples)` loop, add:

```typescript
const nexusTelemetry = sample.nexusTelemetry?.[role];
if (nexusTelemetry) {
  nexusTelemetrySampleCount++;

  // Spawn efficiency
  const spawnEvents = nexusTelemetry.spawn.spawnEvents;
  const idleSpawnTicks = nexusTelemetry.spawn.idleSpawnTicks;
  if (spawnEvents + idleSpawnTicks > 0) {
    nexusSpawnEventSamples++;
    nexusTotalSpawnEvents += spawnEvents;
    nexusTotalIdleSpawnTicks += idleSpawnTicks;
  }

  // Source coverage from mine protocols
  const mineProtocols = nexusTelemetry.protocols.filter((p) => p.type.toLowerCase().includes("mine") || p.type.toLowerCase().includes("extract"));
  const totalSources = nexusTelemetry.colony.creepsByProtocol ? Object.keys(nexusTelemetry.colony.creepsByProtocol).length : 0;
  if (mineProtocols.length > 0) {
    nexusSourceCoverageSamples++;
    nexusTotalSourceCoverage += mineProtocols.filter((p) => p.creepCount > 0).length / Math.max(mineProtocols.length, 1);
  }

  // Cortex skip rate
  const scheduled = nexusTelemetry.cortex.protocolsScheduled;
  const skipped = nexusTelemetry.cortex.protocolsSkipped;
  if (scheduled + skipped > 0) {
    nexusCortexSkipSamples++;
    nexusTotalScheduled += scheduled;
    nexusTotalSkipped += skipped;
  }

  // Logistics efficiency
  const energyRouted = nexusTelemetry.logistics.totalEnergyRouted;
  const dropsCreated = nexusTelemetry.logistics.dropsCreated;
  if (dropsCreated > 0) {
    nexusLogisticsSamples++;
    nexusTotalEnergyRouted += energyRouted;
    nexusTotalDropsCreated += dropsCreated;
  }

  // Protocol churn rate
  const activeProtocols = nexusTelemetry.protocols.length;
  if (activeProtocols > 0) {
    const churnCount = nexusTelemetry.protocols.filter((p) => p.created || p.destroyed).length;
    nexusChurnSamples++;
    nexusTotalChurnRate += churnCount / activeProtocols;
  }

  // Road coverage
  if (nexusTelemetry.architect.roadCoverage > 0) {
    nexusRoadCoverageSamples++;
    nexusTotalRoadCoverage += nexusTelemetry.architect.roadCoverage;
  }
}
```

- [ ] **Step 3: Return nexus fields in the result object**

In the `return { ... }` block of `summarizeVariant`, add:

```typescript
return {
  // ... all existing fields ...
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
```

- [ ] **Step 4: Build CLI**

```bash
cd tools/autoscreeps-cli && npx tsc --noEmit 2>&1 | head -30
```

Fix any type errors before committing.

- [ ] **Step 5: Commit**

```bash
git add tools/autoscreeps-cli/src/lib/run-samples.ts
git commit -m "feat(cli): add nexus metric derivation to run-samples summarization"
```

---

### Task 15: Add nexus primary metrics to suite evaluation

**Files:**
- Modify: `tools/autoscreeps-cli/src/lib/suite-manifest.ts`
- Modify: `tools/autoscreeps-cli/src/lib/suite-runner.ts`

- [ ] **Step 1: Extend suitePrimaryMetricSchema in suite-manifest.ts**

Change the `suitePrimaryMetricSchema` (around line 22) to include nexus metrics:

```typescript
export const suitePrimaryMetricSchema = z.enum([
  "T_RCL2",
  "T_RCL3",
  "controllerProgressToRCL3Pct",
  "spawnWaitingForSufficientEnergyPct",
  "sourceCoveragePct",
  "sourceUptimePct",
  "nexusSpawnEfficiencyPct",
  "nexusSourceCoveragePct",
  "nexusCortexSkipRatePct",
  "nexusLogisticsEfficiencyPct",
  "nexusProtocolChurnRatePct",
  "nexusRoadCoverage"
]);
```

Also update `defaultSuitePrimaryMetrics` — do NOT add nexus metrics here since the default is for basic. Leave it unchanged.

- [ ] **Step 2: Add nexus metrics to metricValue in suite-runner.ts**

In the `metricValue` function (around line 470), add nexus cases:

```typescript
function metricValue(summary: UserRunSummaryMetrics, metric: SuiteSummaryMetric): number | null {
  switch (metric) {
    case "T_RCL2":
      return summary.controllerLevelMilestones["2"] ?? null;
    case "T_RCL3":
      return summary.controllerLevelMilestones["3"] ?? null;
    case "controllerProgressToRCL3Pct":
      return summary.controllerProgressToRCL3Pct;
    case "spawnWaitingForSufficientEnergyPct":
      return summary.spawnWaitingForSufficientEnergyPct;
    case "sourceCoveragePct":
      return summary.sourceCoveragePct;
    case "sourceUptimePct":
      return summary.sourceUptimePct;
    case "harvestingSourceCoveragePct":
      return summary.harvestingSourceCoveragePct;
    case "harvestingSourceUptimePct":
      return summary.harvestingSourceUptimePct;
    case "activeHarvestingSourceCoveragePct":
      return summary.activeHarvestingSourceCoveragePct;
    case "activeHarvestingSourceUptimePct":
      return summary.activeHarvestingSourceUptimePct;
    case "firstExtensionTick":
      return summary.firstExtensionTick;
    case "allRcl2ExtensionsTick":
      return summary.allRcl2ExtensionsTick;
    case "nexusSpawnEfficiencyPct":
      return summary.nexusSpawnEfficiencyPct;
    case "nexusSourceCoveragePct":
      return summary.nexusSourceCoveragePct;
    case "nexusCortexSkipRatePct":
      return summary.nexusCortexSkipRatePct;
    case "nexusLogisticsEfficiencyPct":
      return summary.nexusLogisticsEfficiencyPct;
    case "nexusProtocolChurnRatePct":
      return summary.nexusProtocolChurnRatePct;
    case "nexusRoadCoverage":
      return summary.nexusRoadCoverage;
  }
}
```

- [ ] **Step 3: Add nexus metrics to metricDirection in suite-runner.ts**

In `metricDirection` (around line 499), add nexus cases:

```typescript
function metricDirection(metric: SuiteSummaryMetric): SuiteMetricComparison["direction"] {
  switch (metric) {
    case "T_RCL2":
    case "T_RCL3":
    case "spawnWaitingForSufficientEnergyPct":
    case "firstExtensionTick":
    case "allRcl2ExtensionsTick":
    case "nexusCortexSkipRatePct":     // fewer skips = better
    case "nexusProtocolChurnRatePct":  // lower churn = better
      return "lower-is-better";
    case "controllerProgressToRCL3Pct":
    case "sourceCoveragePct":
    case "sourceUptimePct":
    case "harvestingSourceCoveragePct":
    case "harvestingSourceUptimePct":
    case "activeHarvestingSourceCoveragePct":
    case "activeHarvestingSourceUptimePct":
    case "nexusSpawnEfficiencyPct":
    case "nexusSourceCoveragePct":
    case "nexusLogisticsEfficiencyPct":
    case "nexusRoadCoverage":
      return "higher-is-better";
  }
}
```

- [ ] **Step 4: Update SuitePrimaryMetric in contracts.ts**

`SuitePrimaryMetric` in `contracts.ts` is defined as a union type. Change it to match the extended schema:

```typescript
export type SuitePrimaryMetric =
  | "T_RCL2"
  | "T_RCL3"
  | "controllerProgressToRCL3Pct"
  | "spawnWaitingForSufficientEnergyPct"
  | "sourceCoveragePct"
  | "sourceUptimePct"
  | "nexusSpawnEfficiencyPct"
  | "nexusSourceCoveragePct"
  | "nexusCortexSkipRatePct"
  | "nexusLogisticsEfficiencyPct"
  | "nexusProtocolChurnRatePct"
  | "nexusRoadCoverage";
```

- [ ] **Step 5: Build CLI**

```bash
cd tools/autoscreeps-cli && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add tools/autoscreeps-cli/src/lib/suite-manifest.ts tools/autoscreeps-cli/src/lib/suite-runner.ts tools/autoscreeps-cli/src/lib/contracts.ts
git commit -m "feat(cli): add nexus primary metrics to suite gate evaluation"
```

---

### Task 16: Create scenario YAML files

**Files:**
- Create: `experiments/scenarios/nexus-opener.yaml`
- Create: `experiments/scenarios/nexus-logistics.yaml`

- [ ] **Step 1: Create nexus-opener.yaml**

```yaml
version: 1
name: nexus-opener
description: Nexus head-to-head on mirrored 1x1 sector, measuring opener speed to RCL3.
bot: nexus
reset: full
mapGenerator:
  type: mirrored-random-1x1
run:
  maxTicks: 5000
  tickDuration: 250
  pollIntervalMs: 1000
  maxWallClockMs: 600000
  maxStalledPolls: 30
  terminalConditions:
    win:
      - type: any-owned-controller-level-at-least
        level: 3
    fail:
      - type: no-owned-controllers
```

- [ ] **Step 2: Create nexus-logistics.yaml**

```yaml
version: 1
name: nexus-logistics
description: Nexus logistics stress test - reduced source yield forces grid efficiency. Terminal at RCL4.
bot: nexus
reset: full
mapGenerator:
  type: mirrored-random-1x1
run:
  maxTicks: 10000
  tickDuration: 250
  pollIntervalMs: 1000
  maxWallClockMs: 1200000
  maxStalledPolls: 30
  terminalConditions:
    win:
      - type: any-owned-controller-level-at-least
        level: 4
    fail:
      - type: no-owned-controllers
```

- [ ] **Step 3: Verify schemas parse**

```bash
cd tools/autoscreeps-cli && node --input-type=module << 'EOF'
import { loadScenario } from "./src/lib/scenario.ts";
const s = await loadScenario("../../experiments/scenarios/nexus-opener.yaml");
console.log("ok:", s.config.name, "bot:", s.config.bot);
EOF
```

Expected output: `ok: nexus-opener bot: nexus`

- [ ] **Step 4: Commit**

```bash
git add experiments/scenarios/nexus-opener.yaml experiments/scenarios/nexus-logistics.yaml
git commit -m "feat(experiments): add nexus opener and logistics scenario definitions"
```

---

### Task 17: Create suite YAML file

**Files:**
- Create: `experiments/suites/nexus-baseline.yaml`

- [ ] **Step 1: Create nexus-baseline.yaml**

```yaml
version: 1
name: nexus-baseline
description: Nexus vs nexus baseline suite - validate opener speed and subsystem efficiency.
gates:
  primaryMetrics:
    - T_RCL3
    - nexusSpawnEfficiencyPct
    - nexusSourceCoveragePct
    - nexusCortexSkipRatePct
  training:
    minImprovedPrimaryMetrics: 2
  holdout:
    maxRegressionPct: 5
cases:
  - id: opener-train-1
    cohort: train
    scenario: ../scenarios/nexus-opener.yaml
  - id: opener-train-2
    cohort: train
    scenario: ../scenarios/nexus-opener.yaml
  - id: opener-train-3
    cohort: train
    scenario: ../scenarios/nexus-opener.yaml
  - id: opener-holdout-1
    cohort: holdout
    scenario: ../scenarios/nexus-opener.yaml
  - id: opener-holdout-2
    cohort: holdout
    scenario: ../scenarios/nexus-opener.yaml
```

- [ ] **Step 2: Verify suite manifest parses**

```bash
cd tools/autoscreeps-cli && node --input-type=module << 'EOF'
import { loadSuiteManifest } from "./src/lib/suite-manifest.ts";
const s = await loadSuiteManifest("../../experiments/suites/nexus-baseline.yaml");
console.log("ok:", s.config.name, "cases:", s.config.cases.length);
EOF
```

Expected output: `ok: nexus-baseline cases: 5`

- [ ] **Step 3: Commit**

```bash
git add experiments/suites/nexus-baseline.yaml
git commit -m "feat(experiments): add nexus-baseline suite with opener cases and gates"
```

---

### Task 18: End-to-end smoke test (manual)

This task verifies the integration is wired up correctly without running a full experiment.

- [ ] **Step 1: Deploy nexus to local server**

```bash
cd bots/nexus && ./gradlew deployLocal
```

Expected: BUILD SUCCESSFUL with upload confirmation.

- [ ] **Step 2: Start local server and let nexus run for ~50 ticks**

```bash
docker compose up -d
```

Then in the Screeps game console for the nexus user, run:

```
info()
```

Expected: bot status output.

- [ ] **Step 3: Check segment 43 has data**

In the browser console or via the API, read the nexus user's segment 43 and verify JSON is present with the expected structure:

```javascript
// In Screeps console
RawMemory.setActiveSegments([43])
// Next tick:
JSON.parse(RawMemory.segments[43])
```

Expected: an object with `schemaVersion`, `tick`, `colony`, `cortex`, `spawn`, `protocols`, `logistics`, `blueprints`, `architect`.

- [ ] **Step 4: Verify CLI can parse the segment**

```bash
cd tools/autoscreeps-cli && node --input-type=module << 'EOF'
import { ScreepsApiClient } from "./src/lib/screeps-api.ts";
import { parseNexusTelemetry } from "./src/lib/nexus-telemetry.ts";

const api = new ScreepsApiClient("http://127.0.0.1:21025");
const session = await api.signin({ username: "nexus", password: "passw0rd" });
const raw = await api.getMemorySegment(session, 43);
const snapshot = parseNexusTelemetry(raw);
console.log("snapshot:", JSON.stringify(snapshot?.colony, null, 2));
EOF
```

Expected: colony data with rcl, totalCreeps, etc.

- [ ] **Step 5: Document any issues found and fix before committing**

If segment is empty: check `Telemetry.observe()` is wired in Main.kt and `FLUSH_INTERVAL` ticks have elapsed.

If parse fails: check JSON shape in Kotlin matches TypeScript interface.

---

## Notes for implementation

- **Kotlin build time**: `./gradlew build` takes ~30-60 seconds cold, ~10 seconds warm (incremental). Budget accordingly.
- **No tests in nexus**: Validate telemetry correctness by reading segment 43 in-game (Task 18).
- **Dynamic types in Kotlin**: Use `val x: dynamic = js("{}")` pattern for building JSON objects — consistent with existing codebase.
- **Grid.computeAssignments called with emptyList() in Telemetry**: This is safe — it returns `emptyMap()` immediately per the guard `if (carriers.isEmpty() || requests.isEmpty())`. Use `_assignments` (the cached result) instead to avoid the extra call: `val utilization = (grid._assignments?.size ?: 0).toDouble() / grid.requests.size.toDouble()`. But `_assignments` is private. Either make it internal, or accept the empty-list call.
- **Forge.spawnQueue is private**: It's declared `private val spawnQueue`. To expose queue depth without breaking encapsulation, add a `val queueDepth: Int get() = spawnQueue.size` property to Forge, or read from `hudSnapshot().queue.size`.
- **Segment 43 activation**: Telemetry calls `Segments.requestActivation(SegmentId.TELEMETRY)` before writing — this ensures the segment is active next tick for reads. Writing alone doesn't require activation.
