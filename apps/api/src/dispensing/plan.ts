import type { DispenseStrategy } from '@pegpal/shared';
import { cutoffMass, maxOperationDuration, runtimeForVolume, volumeToMass } from '@pegpal/shared';

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

export interface LiquidProfile {
  name: string;
  strategy: DispenseStrategy;
  flowRateMlPerSec: number | null;
  densityGPerMl: number | null;
  cutoffMarginG: number;
}

export interface PlanLimits {
  safetyFactor: number;
  allowanceMs: number;
  pumpMaxRuntimeMs: number;
}

export interface DispensePlan {
  strategy: DispenseStrategy;
  targetMl: number;
  /** Runtime predicted by the calibration profile (both strategies). */
  expectedRuntimeMs: number;
  /** TIMED only: runtime the controller should run for. */
  runtimeMs: number | null;
  targetMassG: number | null;
  cutoffMarginG: number | null;
  maxDurationMs: number;
}

/**
 * Turns a requested volume into bounded controller parameters using the
 * liquid's calibration profile. Refuses anything it can't bound safely.
 */
export function planDispense(liquid: LiquidProfile, volumeMl: number, limits: PlanLimits): DispensePlan {
  if (liquid.flowRateMlPerSec === null) throw new PlanError(`${liquid.name} has no calibrated flow rate`);
  const expectedRuntimeMs = runtimeForVolume(volumeMl, liquid.flowRateMlPerSec);
  if (expectedRuntimeMs > limits.pumpMaxRuntimeMs)
    throw new PlanError(`${liquid.name}: ${volumeMl} mL needs ~${expectedRuntimeMs} ms, above the per-pump limit of ${limits.pumpMaxRuntimeMs} ms`);
  const maxDurationMs = maxOperationDuration(expectedRuntimeMs, {
    safetyFactor: limits.safetyFactor,
    allowanceMs: limits.allowanceMs,
    absoluteMaxMs: limits.pumpMaxRuntimeMs,
  });

  if (liquid.strategy === 'TIMED') {
    return { strategy: 'TIMED', targetMl: volumeMl, expectedRuntimeMs, runtimeMs: expectedRuntimeMs, targetMassG: null, cutoffMarginG: null, maxDurationMs };
  }

  if (liquid.densityGPerMl === null) throw new PlanError(`${liquid.name} needs a measured density for weight-based dispensing`);
  const targetMassG = round(volumeToMass(volumeMl, liquid.densityGPerMl));
  try {
    cutoffMass(targetMassG, liquid.cutoffMarginG);
  } catch {
    throw new PlanError(`${liquid.name}: cutoff margin ${liquid.cutoffMarginG} g is too large for ${targetMassG} g`);
  }
  return {
    strategy: 'WEIGHT',
    targetMl: volumeMl,
    expectedRuntimeMs,
    runtimeMs: null,
    targetMassG,
    cutoffMarginG: liquid.cutoffMarginG,
    maxDurationMs,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
