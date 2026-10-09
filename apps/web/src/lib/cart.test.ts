import type { LiquidPublicView } from '@pegpal/shared';
import { resolveAttempt, stepVolume, summarizeCart, toCreateOrderRequest } from './cart';

const liquid = (id: string, over: Partial<LiquidPublicView> = {}): LiquidPublicView => ({
  id,
  name: id.toUpperCase(),
  imageUrl: null,
  pricePerMl: '0.0500',
  minMl: 10,
  maxMl: 100,
  available: true,
  unavailableReason: null,
  ...over,
});
const liquids = [liquid('a'), liquid('b'), liquid('c', { available: false, unavailableReason: 'Out of stock' })];
const limits = { maxTotalMl: 150, maxItems: 2 };

describe('summarizeCart', () => {
  it('totals valid lines', () => {
    const s = summarizeCart({ a: 30, b: 20 }, liquids, limits);
    expect(s.totalMl).toBe(50);
    expect(s.estimatedTotal).toBe('2.50');
    expect(s.canSubmit).toBe(true);
    expect(toCreateOrderRequest('M1', s)).toEqual({ machineId: 'M1', items: [{ liquidId: 'a', volumeMl: 30 }, { liquidId: 'b', volumeMl: 20 }] });
  });
  it('rejects empty carts', () => {
    expect(summarizeCart({}, liquids, limits).canSubmit).toBe(false);
  });
  it.each([0, -5, 12.5, NaN, 5, 101])('rejects invalid quantity %p', (v) => {
    const s = summarizeCart({ a: v }, liquids, limits);
    expect(s.lines[0].error).not.toBeNull();
    expect(s.canSubmit).toBe(false);
  });
  it('enforces max total volume', () => {
    const s = summarizeCart({ a: 100, b: 60 }, liquids, limits);
    expect(s.errors.join()).toMatch(/exceeds/);
    expect(s.canSubmit).toBe(false);
  });
  it('enforces max items', () => {
    const s = summarizeCart({ a: 10, b: 10, c: 10 }, [liquid('a'), liquid('b'), liquid('c')], limits);
    expect(s.errors.join()).toMatch(/At most 2/);
  });
  it('blocks unavailable liquids', () => {
    const s = summarizeCart({ c: 20 }, liquids, limits);
    expect(s.lines[0].error).toMatch(/Out of stock/);
    expect(s.canSubmit).toBe(false);
  });
  it('flags liquids that disappeared', () => {
    expect(summarizeCart({ zzz: 20 }, liquids, limits).canSubmit).toBe(false);
  });
});

describe('resolveAttempt', () => {
  const req = { machineId: 'M1', items: [{ liquidId: 'a', volumeMl: 30 }] };
  it('reuses the key for the same body', () => {
    const first = resolveAttempt(null, req, () => 'k1');
    expect(resolveAttempt(first, req, () => 'k2').idempotencyKey).toBe('k1');
  });
  it('uses a new key when the body changes', () => {
    const first = resolveAttempt(null, req, () => 'k1');
    const changed = { ...req, items: [{ liquidId: 'a', volumeMl: 40 }] };
    expect(resolveAttempt(first, changed, () => 'k2').idempotencyKey).toBe('k2');
  });
});

describe('stepVolume', () => {
  it('clamps into range', () => {
    expect(stepVolume(95, 10, 10, 100)).toBe(100);
    expect(stepVolume(15, -10, 10, 100)).toBe(10);
    expect(stepVolume(NaN, 5, 10, 100)).toBe(15);
  });
});
