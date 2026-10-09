import { EMPTY_LIQUID_FORM, parseLiquidForm } from './liquidForm';

describe('parseLiquidForm', () => {
  it('builds a request from valid input', () => {
    const r = parseLiquidForm({ ...EMPTY_LIQUID_FORM, name: ' Rum ', pumpChannel: '3', remainingStockMl: '700', cutoffMarginG: '2' });
    expect(r).toEqual({
      ok: true,
      body: expect.objectContaining({ name: 'Rum', pumpChannel: 3, remainingStockMl: 700, cutoffMarginG: 2, imageUrl: null, densityGPerMl: null }),
    });
  });
  it('rejects bad values', () => {
    const r = parseLiquidForm({ ...EMPTY_LIQUID_FORM, name: '', pumpChannel: '10', minMl: '50', maxMl: '20', pricePerMl: 'abc' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(4);
  });
  it('requires density for WEIGHT', () => {
    const r = parseLiquidForm({ ...EMPTY_LIQUID_FORM, name: 'x', strategy: 'WEIGHT' });
    expect(r.ok).toBe(false);
  });
});
