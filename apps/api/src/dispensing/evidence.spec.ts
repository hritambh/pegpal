import { evaluateEvidence } from './evidence';

const base = {
  expectedMl: 30,
  runtimeMs: 12_000,
  flowRateMlPerSec: 2.5,
  densityGPerMl: 1.04,
  massDeltaG: null,
  massStable: null,
  simulated: false,
  plausibilityPct: 25,
};

describe('evaluateEvidence', () => {
  it('labels mock results as SIMULATED, never measured', () => {
    const e = evaluateEvidence({ ...base, simulated: true, massDeltaG: 29.4, massStable: true });
    expect(e.verification).toBe('SIMULATED');
    expect(e.measuredMassG).toBeNull();
    expect(e.note).toMatch(/no physical measurement/);
  });

  it('reports runtime-based estimates as ESTIMATED', () => {
    const e = evaluateEvidence(base);
    expect(e).toMatchObject({ verification: 'ESTIMATED', deliveredMl: 30 });
  });

  it('uses a stable, plausible mass delta as MASS_DELTA and says it is inferred', () => {
    const e = evaluateEvidence({ ...base, massDeltaG: 31.2, massStable: true });
    expect(e.verification).toBe('MASS_DELTA');
    expect(e.deliveredMl).toBe(30);
    expect(e.note).toMatch(/not an independent volume measurement/);
  });

  it('rejects unstable mass readings', () => {
    const e = evaluateEvidence({ ...base, massDeltaG: 31.2, massStable: false });
    expect(e.verification).toBe('ESTIMATED');
    expect(e.note).toMatch(/not stable/);
  });

  it('rejects implausible mass readings (sensor fault)', () => {
    const e = evaluateEvidence({ ...base, massDeltaG: 80, massStable: true });
    expect(e.verification).toBe('ESTIMATED');
    expect(e.note).toMatch(/deviates/);
  });

  it('rejects negative mass (glass removed)', () => {
    const e = evaluateEvidence({ ...base, massDeltaG: -50, massStable: true });
    expect(e.note).toMatch(/mass decreased/);
  });

  it('cannot use mass without density', () => {
    const e = evaluateEvidence({ ...base, densityGPerMl: null, massDeltaG: 30, massStable: true });
    expect(e.verification).toBe('ESTIMATED');
    expect(e.note).toMatch(/density not configured/);
  });

  it('is UNVERIFIED when there is no evidence at all', () => {
    const e = evaluateEvidence({ ...base, runtimeMs: null });
    expect(e).toMatchObject({ verification: 'UNVERIFIED', deliveredMl: null });
  });

  it('is UNVERIFIED when the only evidence (mass) is missing its runtime fallback and is rejected', () => {
    const e = evaluateEvidence({ ...base, runtimeMs: null, massDeltaG: 30, massStable: false });
    expect(e.verification).toBe('UNVERIFIED');
  });
});
