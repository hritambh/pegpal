import {
  QuantityError,
  cutoffMass,
  densityFrom,
  flowRateFrom,
  massToVolume,
  maxOperationDuration,
  percentError,
  runtimeForVolume,
  validateQuantity,
  volumeForRuntime,
  volumeToMass,
} from './units';

describe('volume / mass conversion', () => {
  it('converts volume to mass using density', () => {
    expect(volumeToMass(50, 1.0)).toBe(50);
    expect(volumeToMass(30, 0.95)).toBeCloseTo(28.5);
  });

  it('round-trips mass back to volume', () => {
    expect(massToVolume(volumeToMass(42, 1.12), 1.12)).toBeCloseTo(42);
  });

  it('rejects zero, negative and non-finite inputs', () => {
    expect(() => volumeToMass(0, 1)).toThrow(QuantityError);
    expect(() => volumeToMass(-5, 1)).toThrow(QuantityError);
    expect(() => volumeToMass(10, 0)).toThrow(QuantityError);
    expect(() => volumeToMass(Number.NaN, 1)).toThrow(QuantityError);
    expect(() => massToVolume(-1, 1)).toThrow(QuantityError);
    expect(() => massToVolume(10, Number.POSITIVE_INFINITY)).toThrow(QuantityError);
  });

  it('computes density from a weighed sample', () => {
    expect(densityFrom(104.5, 100)).toBeCloseTo(1.045);
    expect(() => densityFrom(10, 0)).toThrow(QuantityError);
  });
});

describe('calibration math', () => {
  it('derives flow rate from collected volume and runtime', () => {
    expect(flowRateFrom(25, 10_000)).toBeCloseTo(2.5);
  });

  it('estimates runtime for a requested volume', () => {
    expect(runtimeForVolume(30, 2.5)).toBe(12_000);
    expect(() => runtimeForVolume(30, 0)).toThrow(QuantityError);
  });

  it('estimates volume for a runtime', () => {
    expect(volumeForRuntime(4000, 2.5)).toBeCloseTo(10);
    expect(volumeForRuntime(0, 2.5)).toBe(0);
  });

  it('caps the maximum operation duration', () => {
    const opts = { safetyFactor: 1.5, allowanceMs: 1000, absoluteMaxMs: 30_000 };
    expect(maxOperationDuration(10_000, opts)).toBe(16_000);
    expect(maxOperationDuration(25_000, opts)).toBe(30_000);
  });

  it('computes the cutoff mass and rejects margins that swallow the target', () => {
    expect(cutoffMass(30, 1.5)).toBe(28.5);
    expect(() => cutoffMass(30, 30)).toThrow(QuantityError);
    expect(() => cutoffMass(30, -1)).toThrow(QuantityError);
  });

  it('computes signed percent error', () => {
    expect(percentError(50, 48)).toBeCloseTo(-4);
    expect(percentError(50, 55)).toBeCloseTo(10);
  });
});

describe('validateQuantity', () => {
  const limits = { minMl: 5, maxMl: 100 };
  it.each([
    [0, 'greater than zero'],
    [-10, 'greater than zero'],
    [2, 'Minimum'],
    [101, 'Maximum'],
    [12.5, 'whole number'],
    [Number.NaN, 'number'],
    ['20', 'number'],
    [null, 'number'],
  ])('rejects %p', (value, msg) => {
    expect(validateQuantity(value, limits)).toContain(msg);
  });

  it('accepts values within limits', () => {
    expect(validateQuantity(5, limits)).toBeNull();
    expect(validateQuantity(100, limits)).toBeNull();
  });
});
