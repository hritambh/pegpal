import { PlanError, planDispense } from './plan';

const limits = { safetyFactor: 1.5, allowanceMs: 1000, pumpMaxRuntimeMs: 30_000 };
const timed = { name: 'Cola', strategy: 'TIMED' as const, flowRateMlPerSec: 2.5, densityGPerMl: 1.04, cutoffMarginG: 1 };

describe('planDispense', () => {
  it('derives runtime and a bounded max duration from the calibration (TIMED)', () => {
    const p = planDispense(timed, 30, limits);
    expect(p).toMatchObject({ strategy: 'TIMED', runtimeMs: 12_000, expectedRuntimeMs: 12_000, maxDurationMs: 19_000, targetMassG: null });
  });

  it('converts volume to target mass with density (WEIGHT)', () => {
    const p = planDispense({ ...timed, strategy: 'WEIGHT', densityGPerMl: 1.3, cutoffMarginG: 1.5 }, 20, limits);
    expect(p).toMatchObject({ strategy: 'WEIGHT', runtimeMs: null, targetMassG: 26, cutoffMarginG: 1.5 });
    expect(p.maxDurationMs).toBe(Math.ceil(8000 * 1.5 + 1000));
  });

  it('refuses uncalibrated liquids', () => {
    expect(() => planDispense({ ...timed, flowRateMlPerSec: null }, 30, limits)).toThrow(PlanError);
  });

  it('refuses weight dispensing without a measured density', () => {
    expect(() => planDispense({ ...timed, strategy: 'WEIGHT', densityGPerMl: null }, 30, limits)).toThrow(/density/);
  });

  it('refuses requests that would exceed the per-pump runtime limit', () => {
    expect(() => planDispense({ ...timed, flowRateMlPerSec: 0.5 }, 30, limits)).toThrow(/per-pump limit/);
  });

  it('refuses a cutoff margin that swallows the target', () => {
    expect(() => planDispense({ ...timed, strategy: 'WEIGHT', cutoffMarginG: 10 }, 5, limits)).toThrow(/cutoff/);
  });

  it('caps max duration at the absolute pump limit', () => {
    const p = planDispense({ ...timed, flowRateMlPerSec: 1 }, 25, limits);
    expect(p.maxDurationMs).toBe(30_000);
  });
});
