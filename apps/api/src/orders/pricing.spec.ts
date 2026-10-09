import { Prisma } from '@prisma/client';
import { priceLines } from './pricing';
import { orderToken, verifyOrderToken } from './order-token';

describe('priceLines', () => {
  it('prices per mL with half-up rounding per line', () => {
    const { lines, total } = priceLines([
      { liquidId: 'a', volumeMl: 33, pricePerMl: new Prisma.Decimal('0.0125') }, // 0.4125 -> 0.41
      { liquidId: 'b', volumeMl: 10, pricePerMl: new Prisma.Decimal('0.0075') }, // 0.075 -> 0.08
    ]);
    expect(lines.map((l) => l.linePrice.toFixed(2))).toEqual(['0.41', '0.08']);
    expect(total.toFixed(2)).toBe('0.49');
  });

  it('avoids float drift', () => {
    const { total } = priceLines([{ liquidId: 'a', volumeMl: 3, pricePerMl: new Prisma.Decimal('0.1') }]);
    expect(total.toFixed(2)).toBe('0.30');
  });
});

describe('order tokens', () => {
  const secret = 'x'.repeat(40);
  it('verifies the token for its own order only', () => {
    const t = orderToken(secret, 'order-1');
    expect(verifyOrderToken(secret, 'order-1', t)).toBe(true);
    expect(verifyOrderToken(secret, 'order-2', t)).toBe(false);
    expect(verifyOrderToken('y'.repeat(40), 'order-1', t)).toBe(false);
    expect(verifyOrderToken(secret, 'order-1', undefined)).toBe(false);
    expect(verifyOrderToken(secret, 'order-1', '')).toBe(false);
  });
});
