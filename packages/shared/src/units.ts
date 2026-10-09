/**
 * Pure quantity / calibration math. All volumes in mL, masses in grams,
 * durations in milliseconds, flow rates in mL/s.
 */

export class QuantityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuantityError';
  }
}

function assertPositiveFinite(value: number, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new QuantityError(`${name} must be a positive finite number (got ${String(value)})`);
  }
}

export function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * f) / f;
}

export function volumeToMass(volumeMl: number, densityGPerMl: number): number {
  assertPositiveFinite(volumeMl, 'volumeMl');
  assertPositiveFinite(densityGPerMl, 'densityGPerMl');
  return volumeMl * densityGPerMl;
}

export function massToVolume(massG: number, densityGPerMl: number): number {
  if (!Number.isFinite(massG) || massG < 0) throw new QuantityError(`massG must be >= 0 (got ${String(massG)})`);
  assertPositiveFinite(densityGPerMl, 'densityGPerMl');
  return massG / densityGPerMl;
}

/** Density from a measured mass and volume of the same sample. */
export function densityFrom(massG: number, volumeMl: number): number {
  assertPositiveFinite(massG, 'massG');
  assertPositiveFinite(volumeMl, 'volumeMl');
  return massG / volumeMl;
}

/** Flow rate from a calibration run: collected volume over pump runtime. */
export function flowRateFrom(collectedMl: number, runtimeMs: number): number {
  assertPositiveFinite(collectedMl, 'collectedMl');
  assertPositiveFinite(runtimeMs, 'runtimeMs');
  return collectedMl / (runtimeMs / 1000);
}

/** Pump runtime needed to deliver a volume at a calibrated flow rate. */
export function runtimeForVolume(volumeMl: number, flowRateMlPerSec: number): number {
  assertPositiveFinite(volumeMl, 'volumeMl');
  assertPositiveFinite(flowRateMlPerSec, 'flowRateMlPerSec');
  return Math.round((volumeMl / flowRateMlPerSec) * 1000);
}

/** Estimated volume delivered for a given runtime. */
export function volumeForRuntime(runtimeMs: number, flowRateMlPerSec: number): number {
  if (!Number.isFinite(runtimeMs) || runtimeMs < 0) throw new QuantityError('runtimeMs must be >= 0');
  assertPositiveFinite(flowRateMlPerSec, 'flowRateMlPerSec');
  return (runtimeMs / 1000) * flowRateMlPerSec;
}

/**
 * Upper bound for one pump operation. The expected runtime is multiplied by a
 * safety factor (to tolerate flow variation) plus a fixed allowance, and then
 * capped by the absolute per-pump limit. The firmware enforces its own cap too.
 */
export function maxOperationDuration(
  expectedRuntimeMs: number,
  opts: { safetyFactor: number; allowanceMs: number; absoluteMaxMs: number },
): number {
  assertPositiveFinite(expectedRuntimeMs, 'expectedRuntimeMs');
  return Math.min(Math.ceil(expectedRuntimeMs * opts.safetyFactor + opts.allowanceMs), opts.absoluteMaxMs);
}

/** Mass at which the pump should be switched off to land on the target. */
export function cutoffMass(targetMassG: number, cutoffMarginG: number): number {
  assertPositiveFinite(targetMassG, 'targetMassG');
  if (!Number.isFinite(cutoffMarginG) || cutoffMarginG < 0) throw new QuantityError('cutoffMarginG must be >= 0');
  if (cutoffMarginG >= targetMassG) throw new QuantityError('cutoffMarginG must be smaller than the target mass');
  return targetMassG - cutoffMarginG;
}

/** Signed relative error of a measured value against its target, in percent. */
export function percentError(target: number, measured: number): number {
  assertPositiveFinite(target, 'target');
  if (!Number.isFinite(measured)) throw new QuantityError('measured must be finite');
  return ((measured - target) / target) * 100;
}

export interface QuantityLimits {
  minMl: number;
  maxMl: number;
}

/** Customer-facing quantity check. Returns a reason string or null if valid. */
export function validateQuantity(value: unknown, limits: QuantityLimits): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Quantity must be a number';
  if (!Number.isInteger(value)) return 'Quantity must be a whole number of mL';
  if (value <= 0) return 'Quantity must be greater than zero';
  if (value < limits.minMl) return `Minimum is ${limits.minMl} mL`;
  if (value > limits.maxMl) return `Maximum is ${limits.maxMl} mL`;
  return null;
}
