# Genesis Encoder — Design Spec

**Date:** 2026-05-14  
**Hypothesis:** `exp/genesis-encoder`  
**Expected impact:** ~28% reduction in RCL2→RCL3 tick count (~5 034 vs baseline ~6 989)

---

## Problem

`EncoderProtocol` has a hard guard that prevents any dedicated upgrader from spawning before RCL3. All controller upgrading in Genesis phase is handled as the lowest-priority fallback in `FabricatorProtocol.handleWorker()` (step 9 of 9). Measured average upgrade rate in RCL2→RCL3 is **6.44 e/t** against a theoretical income of ~18 e/t — a 64% gap explained primarily by fabricators spending most of their time on construction, repair, and travel rather than upgrading.

---

## Solution

Extend `EncoderProtocol` to spawn one dedicated encoder starting at RCL2 (sector.phase == Genesis). The encoder uses the existing blueprint, existing `handleWorker()` logic, and recharges from `forge.battery`. A new spawn priority constant `GENESIS_UPGRADE = 550` places it below essential mining/hauling (WORK = 504) but above post-Genesis encoders (UPGRADE = 600).

---

## Architecture

Changes touch three files:

```
SpawnPriorities.kt      +1 constant (GENESIS_UPGRADE = 550)
EncoderProtocol.kt      phase branch in init() + genesisUpgradePowerNeeded()
```

`FabricatorProtocol.kt` is **not changed** in this experiment to keep the independent variable isolated.

### Control flow in `EncoderProtocol.init()` after change

```
sector.phase == Genesis?
  ├── sector.level < 2  →  return (nothing to do)
  └── level >= 2        →  spawnEncoders(genesisUpgradePowerNeeded(), GENESIS_UPGRADE)
                              └── always returns power for exactly 1 encoder
                              └── return

sector.phase == Growth / Apex?
  └── existing logic unchanged
```

---

## File Changes

### `SpawnPriorities.kt`

Add one constant inside `object Upgrading`:

```kotlin
object Upgrading {
    const val GENESIS_UPGRADE = 550
    const val UPGRADE = 600
}
```

### `EncoderProtocol.kt`

**In `init()`** — replace the single guard with a phase branch:

```kotlin
// Before:
if (sector.level < 3) return

// After:
if (sector.phase == SectorPhase.Genesis) {
    if (sector.level < 2) return
    spawnEncoders(genesisUpgradePowerNeeded(), SpawnPriorities.Upgrading.GENESIS_UPGRADE)
    return
}
```

**New private function:**

```kotlin
private fun genesisUpgradePowerNeeded(): Double {
    return Blueprints.Encoders.default.powerEach.toDouble()
}
```

The existing `upgradePowerNeeded()` function is not modified — it is only reached via the Growth/Apex branch.

---

## Encoder Behaviour in Genesis

- **Blueprint:** `Blueprints.Encoders.default` — pattern `[WORK×3, CARRY, MOVE]`, unlimited repeats. At RCL2 (550 energy cap): 1 repeat = 400 energy. At RCL3 (800 cap): 2 repeats = 800 energy.
- **Energy source:** `forge.battery` (built automatically at RCL1+, same as in Growth phase).
- **Routine:** existing `handleWorker()` — repairs battery/link → upgrades controller. No new behaviour.
- **Spawn priority:** 550 — below miners/haulers (WORK = 504), above post-Genesis encoders (UPGRADE = 600). Essential roles spawn first.

---

## Edge Cases

| Situation | Behaviour |
|---|---|
| `forge.battery == null` at RCL2 | Encoder spawns but idles — `handleWorker()` finds no energy source. Acceptable: battery is among the first structures built. |
| Extensions not yet built at RCL2 start | Encoder stays in queue until 400 energy is available. Spawn system handles this natively. |
| Genesis → Growth transition | `sector.phase` switches to Growth; Genesis branch is skipped; Growth logic takes over encoder lifecycle. No special handling needed. |
| Spawn queue pressure | GENESIS_UPGRADE (550) yields to WORK (504); miners and haulers are never blocked. |

---

## Success Criteria

Experiment passes if, across ≥ 2 of 3 train cases:

| Metric | Baseline | Target |
|---|---|---|
| RCL2→RCL3 tick | ~6 989 | < 5 500 |
| `creepsByProtocol.encoder` during Genesis | 0 | ≥ 1 |
| `spawn.queueDepth` avg | baseline | no increase |
| `logistics.fabricatorSourceFetches` | baseline | no increase |

---

## Out of Scope

- Removing the fabricator battery gate (`battery < 1000`) — separate follow-on experiment.
- Spawning more than 1 Genesis encoder — not needed for this test.
- Config-flag gating — this is a direct code experiment, rollback via git revert.
