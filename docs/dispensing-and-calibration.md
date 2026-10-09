# Dispensing accuracy and calibration

Running a pump for a fixed time does **not** reliably deliver a fixed volume. Viscosity, temperature, tubing wear, head height and supply voltage all change the flow. So PegPal treats every quantity as a claim with an evidence level, and it gives operators the tools to measure and correct the calibration.

## 1. Per-liquid calibration profile

Every liquid carries its own profile, stored on the `Liquid` row:

| Field | Meaning |
|---|---|
| `strategy` | `TIMED` or `WEIGHT` |
| `flowRateMlPerSec` | measured flow. `null` means uncalibrated, and the liquid can't be ordered. |
| `densityGPerMl` | measured density. Required for `WEIGHT`. `null` until it's measured. |
| `cutoffMarginG` | `WEIGHT`: stop this many grams early so liquid still in the tube lands on target |
| `calibratedAt`, `calibrationSimulated` | when the profile was measured, and whether it came from the simulator |

Moving a liquid to another pump channel clears its flow rate, because the old calibration no longer applies.

## 2. Strategies

### Strategy A: calibrated pump timing (`TIMED`)

1. `runtime = volume ÷ flowRate` (`planDispense` in `apps/api/src/dispensing/plan.ts`).
2. `maxDuration = min(runtime × RUNTIME_SAFETY_FACTOR + RUNTIME_ALLOWANCE_MS, PUMP_MAX_RUNTIME_MS)`. The firmware also enforces its own `FW_MAX_PUMP_RUNTIME_MS`.
3. Requests that would need more than the per-pump limit are refused before any pump runs.
4. The delivered quantity is reported as **`ESTIMATED`**: runtime × calibrated flow, *not measured*.

### Strategy B: weight-based (`WEIGHT`, load cell + HX711)

1. **Tare.** The controller waits for a stable reading, then zeroes the scale. If the reading is unstable or the HX711 isn't responding, the order fails *before* any pump runs.
2. **Target.** `targetMass = volume × density`. The controller stops at `targetMass − cutoffMarginG`.
3. The controller watches for these faults, and every one of them stops the pump:
   - mass dropping (glass removed)
   - implausibly fast gain
   - no gain after `NO_FLOW_TIMEOUT_MS` (empty reservoir or failed pump)
   - HX711 not ready
4. **Evidence.** `massDeltaG` is the difference between the stable readings before and after the step. The backend converts it with density and labels it **`MASS_DELTA`**.

> **What one load cell can and can't tell you.** The scale measures the *total* mass in the glass. A per-ingredient figure is the *difference* between two readings around that step. It is an inference that assumes nothing else was added or removed and that the configured density is right. It is **not** an independent measurement of that ingredient's volume. PegPal says so in every `MASS_DELTA` note.

### Evidence rules (`evaluateEvidence`)

| Situation | Verification | Delivered mL |
|---|---|---|
| Mock controller | `SIMULATED` | the simulator's own figure, labelled as such |
| Stable mass, known density, within `MASS_PLAUSIBILITY_PCT` of expectation | `MASS_DELTA` | mass ÷ density |
| Mass unstable, implausible, negative, or density unknown | falls back to `ESTIMATED` (or `UNVERIFIED` if there's no runtime) | runtime × flow |
| Runtime only | `ESTIMATED` | runtime × flow |
| Timeout, disconnect, restart mid-step | `UNVERIFIED` (item `UNKNOWN`) | `null` |

An item becomes `COMPLETED` **only** when the controller sends `DONE` for that item's command. Sending the command, or getting it acknowledged, is never enough.

## 3. Calibration procedure (operator)

Calibration is admin-only (`/admin/calibration`, or the API under `/api/admin/calibration`). Each run reserves the machine, so no customer order can run at the same time.

### Flow-rate calibration

1. Prime the line so the tube is full and there are no bubbles.
2. Choose the liquid and a runtime, for example 10 s. The maximum is `CALIBRATION_MAX_RUNTIME_MS`.
3. **Start.** The pump runs for exactly that long, bounded by the same firmware limits as customer orders.
4. When the run is `AWAITING_MEASUREMENT`, measure what came out:
   - the volume in a **graduated cylinder** (required)
   - the mass of the same sample on a scale (optional, gives density)
5. **Submit.** The server computes `flowRate = measuredMl ÷ actualRuntime` and `density = mass ÷ volume`. It uses the *actual* runtime the controller reported, not the requested one.
6. **Apply.** Writes the profile to the liquid. The previous flow rate is kept on the run for history.

Repeat three times and apply a representative run. Recalibrate after changing tubing, the liquid brand, or the pump.

### Validation run

Choose a target volume, for example 30 mL. The pump dispenses it using the **current** profile. Measure the result and enter it, and the server records the signed **error %**. The history table compares requested and measured quantities over time.

### Mock mode

In mock mode every run is flagged `simulated`. The UI labels it **"SIMULATED — not a real measurement"** and shows the simulator's own figure as a hint. Applying a simulated run sets `calibrationSimulated = true` on the liquid. **Simulated calibrations must be redone on real hardware before any real dispensing.**

## 4. Calibration math (unit-tested)

All of the following are in `packages/shared/src/units.ts`:

| Function | What it computes |
|---|---|
| `flowRateFrom(collectedMl, runtimeMs)` | mL/s |
| `runtimeForVolume(volumeMl, flowRate)` | ms |
| `volumeForRuntime(runtimeMs, flowRate)` | mL |
| `volumeToMass` / `massToVolume` / `densityFrom` | conversions using density |
| `cutoffMass(target, margin)` | rejects a margin that is at least the target |
| `maxOperationDuration(expected, {safetyFactor, allowanceMs, absoluteMaxMs})` | the bounded maximum runtime |
| `percentError(target, measured)` | signed error % |
