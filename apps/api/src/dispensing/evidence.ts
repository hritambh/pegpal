import type { VerificationLevel } from '@pegpal/shared';
import { massToVolume, volumeForRuntime } from '@pegpal/shared';

export interface EvidenceInput {
  /** Volume the step was meant to deliver (the full target for DONE). */
  expectedMl: number | null;
  runtimeMs: number | null;
  flowRateMlPerSec: number | null;
  densityGPerMl: number | null;
  massDeltaG: number | null;
  massStable: boolean | null;
  simulated: boolean;
  /** Max relative disagreement between mass-derived and expected volume. */
  plausibilityPct: number;
}

export interface Evidence {
  deliveredMl: number | null;
  measuredMassG: number | null;
  verification: VerificationLevel;
  note: string;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Decides what we can honestly claim about a delivered quantity.
 * One load cell sees the whole glass, so a per-step mass is a *difference*
 * between two readings, never an independent measurement of that liquid.
 */
export function evaluateEvidence(i: EvidenceInput): Evidence {
  if (i.simulated) {
    const ml = i.massDeltaG ?? (i.runtimeMs !== null && i.flowRateMlPerSec ? volumeForRuntime(i.runtimeMs, i.flowRateMlPerSec) : null);
    return {
      deliveredMl: ml === null ? null : round(ml),
      measuredMassG: null,
      verification: 'SIMULATED',
      note: 'Simulated by the mock controller; no physical measurement was taken.',
    };
  }

  const estimate =
    i.runtimeMs !== null && i.flowRateMlPerSec ? round(volumeForRuntime(i.runtimeMs, i.flowRateMlPerSec)) : null;

  if (i.massDeltaG !== null) {
    const problems: string[] = [];
    if (i.massStable !== true) problems.push('scale reading was not stable');
    if (i.densityGPerMl === null) problems.push('density not configured');
    if (i.massDeltaG < 0) problems.push('mass decreased');
    if (problems.length === 0) {
      const ml = massToVolume(i.massDeltaG, i.densityGPerMl!);
      const reference = i.expectedMl ?? estimate;
      const deviationPct = reference ? (Math.abs(ml - reference) / reference) * 100 : 0;
      if (deviationPct <= i.plausibilityPct) {
        return {
          deliveredMl: round(ml),
          measuredMassG: round(i.massDeltaG),
          verification: 'MASS_DELTA',
          note: `Inferred from the change in total glass mass (${round(i.massDeltaG)} g) using a density of ${i.densityGPerMl} g/mL; not an independent volume measurement.`,
        };
      }
      problems.push(`mass-derived ${round(ml)} mL deviates ${Math.round(deviationPct)}% from expectation`);
    }
    if (estimate !== null) {
      return {
        deliveredMl: estimate,
        measuredMassG: round(i.massDeltaG),
        verification: 'ESTIMATED',
        note: `Load-cell evidence rejected (${problems.join('; ')}); estimated from pump runtime and calibrated flow rate.`,
      };
    }
    return {
      deliveredMl: null,
      measuredMassG: round(i.massDeltaG),
      verification: 'UNVERIFIED',
      note: `Load-cell evidence rejected (${problems.join('; ')}); delivered amount not verified.`,
    };
  }

  if (estimate !== null) {
    return {
      deliveredMl: estimate,
      measuredMassG: null,
      verification: 'ESTIMATED',
      note: 'Estimated from pump runtime and calibrated flow rate; not measured.',
    };
  }
  return { deliveredMl: null, measuredMassG: null, verification: 'UNVERIFIED', note: 'No evidence of the delivered amount.' };
}
