# Genesis Encoder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spawn one dedicated encoder creep starting at RCL2 in Genesis phase to increase controller upgrade throughput and reduce RCL2→RCL3 time by ~28%.

**Architecture:** Add a Genesis-phase branch to `EncoderProtocol.init()` that calls `wishlist(1, ...)` with a new `GENESIS_UPGRADE = 550` priority constant, bypassing the existing `sector.level < 3` guard. All encoder behaviour (recharge from battery, upgrade controller) remains unchanged — only the spawn condition is new.

**Tech Stack:** Kotlin/JS, Gradle (`./gradlew build` run from `bots/nexus/`), Screeps private server experiment runner.

---

### Task 1: Add `GENESIS_UPGRADE` spawn priority constant

**Files:**
- Modify: `bots/nexus/src/jsMain/kotlin/priorities/SpawnPriorities.kt:48-50`

- [ ] **Step 1: Open the file and locate the `Upgrading` object**

  File: `bots/nexus/src/jsMain/kotlin/priorities/SpawnPriorities.kt`

  Current content at lines 48–50:
  ```kotlin
  object Upgrading {
      const val UPGRADE = 600
  }
  ```

- [ ] **Step 2: Add the `GENESIS_UPGRADE` constant**

  Replace the `Upgrading` object with:
  ```kotlin
  object Upgrading {
      const val GENESIS_UPGRADE = 550
      const val UPGRADE = 600
  }
  ```

  Rationale: lower number = higher priority. 550 places Genesis encoder after essential mining/hauling (WORK = 504) but before post-Genesis encoders (UPGRADE = 600).

- [ ] **Step 3: Build to verify no compilation errors**

  Run from `bots/nexus/`:
  ```bash
  ./gradlew build
  ```
  Expected: `BUILD SUCCESSFUL`

- [ ] **Step 4: Commit**

  ```bash
  git add bots/nexus/src/jsMain/kotlin/priorities/SpawnPriorities.kt
  git commit -m "feat(nexus): add GENESIS_UPGRADE spawn priority constant"
  ```

---

### Task 2: Add Genesis branch to `EncoderProtocol.init()`

**Files:**
- Modify: `bots/nexus/src/jsMain/kotlin/protocols/core/EncoderProtocol.kt`

- [ ] **Step 1: Add `SectorPhase` import**

  Current imports in the file (lines 1–11):
  ```kotlin
  package protocols.core

  import blueprints.Blueprints
  import blueprints.Roles
  import modules.BoostModule
  import modules.Uplink
  import priorities.SpawnPriorities
  import protocols.Protocol
  import routines.Routines
  import screeps.api.*
  import synths.Synth
  import kotlin.math.ceil
  ```

  Add `import nexus.SectorPhase` and `import protocols.WishlistOptions` after the existing imports:
  ```kotlin
  package protocols.core

  import blueprints.Blueprints
  import blueprints.Roles
  import modules.BoostModule
  import modules.Uplink
  import nexus.SectorPhase
  import priorities.SpawnPriorities
  import protocols.Protocol
  import protocols.WishlistOptions
  import routines.Routines
  import screeps.api.*
  import synths.Synth
  import kotlin.math.ceil
  ```

- [ ] **Step 2: Replace the level guard with a phase branch in `init()`**

  Current `init()` function (lines 28–43):
  ```kotlin
  override fun init() {
      if (sector.level < 3) return // can't justify dedicated upgraders at early levels
      if (encoderPausedByStorage()) return

      val setup = if (sector.level == 8) Blueprints.Encoders.rcl8 else Blueprints.Encoders.default
      if (sector.level == 8) {
          wishlist(1, setup)
      } else {
          val powerEach = setup.getBodyPotential(WORK, sector.energyCapacity)
          if (powerEach <= 0) return
          val needed = ceil(uplink.upgradePowerNeeded / powerEach).toInt()
          wishlist(needed, setup)
      }

      requestBoosts(encoders)
  }
  ```

  Replace with:
  ```kotlin
  override fun init() {
      if (sector.phase == SectorPhase.Genesis) {
          if (sector.level < 2) return
          wishlist(1, Blueprints.Encoders.default, WishlistOptions(priority = SpawnPriorities.Upgrading.GENESIS_UPGRADE))
          return
      }

      if (encoderPausedByStorage()) return

      val setup = if (sector.level == 8) Blueprints.Encoders.rcl8 else Blueprints.Encoders.default
      if (sector.level == 8) {
          wishlist(1, setup)
      } else {
          val powerEach = setup.getBodyPotential(WORK, sector.energyCapacity)
          if (powerEach <= 0) return
          val needed = ceil(uplink.upgradePowerNeeded / powerEach).toInt()
          wishlist(needed, setup)
      }

      requestBoosts(encoders)
  }
  ```

  Key points:
  - `sector.phase == SectorPhase.Genesis` is true when `sector.storageUnit == null` (before RCL4 storage is built)
  - `wishlist(1, ...)` — always exactly 1 encoder in Genesis
  - `WishlistOptions(priority = SpawnPriorities.Upgrading.GENESIS_UPGRADE)` — overrides the protocol's default UPGRADE (600) priority for this call
  - `return` after the Genesis branch ensures the Growth/Apex logic below is untouched
  - `requestBoosts(encoders)` is intentionally omitted for Genesis — no boost labs exist before RCL6

- [ ] **Step 3: Build to verify no compilation errors**

  Run from `bots/nexus/`:
  ```bash
  ./gradlew build
  ```
  Expected: `BUILD SUCCESSFUL`

- [ ] **Step 4: Commit**

  ```bash
  git add bots/nexus/src/jsMain/kotlin/protocols/core/EncoderProtocol.kt
  git commit -m "feat(nexus): spawn genesis encoder from RCL2 in EncoderProtocol"
  ```

---

### Task 3: Verify experiment readiness

**Files:** none (read-only checks)

- [ ] **Step 1: Confirm the submodule is on a feature branch**

  ```bash
  cd bots/nexus && git status
  ```
  If on `main`, create experiment branch:
  ```bash
  git checkout -b exp/genesis-encoder
  ```
  Then amend the commits from Tasks 1–2 onto the new branch.

- [ ] **Step 2: Verify the build output compiles cleanly**

  Run from `bots/nexus/`:
  ```bash
  ./gradlew build 2>&1 | tail -5
  ```
  Expected last line: `BUILD SUCCESSFUL in Xs`

- [ ] **Step 3: Commit the submodule pointer from the autoscreeps root**

  ```bash
  cd ../..
  git add bots/nexus
  git commit -m "chore: advance nexus submodule to genesis-encoder"
  ```

---

## Telemetry checks after running an experiment

In `samples.jsonl`, for any sample where `colony.rcl == 2`, verify:

| Field | Expected |
|---|---|
| `nexusTelemetry.baseline.colony.creepsByProtocol.encoder` | `0` (baseline has no Genesis encoder) |
| `nexusTelemetry.candidate.colony.creepsByProtocol.encoder` | `>= 1` (candidate spawned one) |
| `nexusTelemetry.candidate.spawn.queueDepth` | not higher than baseline avg |
| `nexusTelemetry.candidate.logistics.fabricatorSourceFetches` | not higher than baseline |

Primary success metric: `controllerLevelMilestones["3"]` in candidate < 5 500 ticks across ≥ 2 of 3 train cases.
