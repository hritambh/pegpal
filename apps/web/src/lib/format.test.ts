import { linePriceMicros, microsToDecimalString, parseDecimalToMicros, formatMl, formatMoney, formatUnitPrice } from './format';

describe('decimal money', () => {
  it('parses decimal strings to micros', () => {
    expect(parseDecimalToMicros('0.0500')).toBe(50000);
    expect(parseDecimalToMicros('2')).toBe(2000000);
    expect(parseDecimalToMicros('1.2345675')).toBe(1234568);
    expect(parseDecimalToMicros('-1')).toBeNull();
    expect(parseDecimalToMicros('abc')).toBeNull();
  });
  it('formats micros with half-up rounding', () => {
    expect(microsToDecimalString(1500000)).toBe('1.50');
    expect(microsToDecimalString(1005000)).toBe('1.01');
    expect(microsToDecimalString(0)).toBe('0.00');
  });
  it('computes line prices without float drift', () => {
    expect(microsToDecimalString(linePriceMicros('0.1', 3)!)).toBe('0.30');
    expect(linePriceMicros('x', 3)).toBeNull();
  });
  it('formats volumes and money', () => {
    expect(formatMl(30)).toBe('30 mL');
    expect(formatMl(null)).toBe('—');
    expect(formatMoney('1.5', 'EUR')).toContain('1.50');
    expect(formatMoney('1.5', 'NOT_A_CURRENCY')).toBe('1.50 NOT_A_CURRENCY');
  });
});

describe('rupee formatting', () => {
  it('shows ₹ with Indian digit grouping', () => {
    expect(formatMoney('50', 'INR')).toBe('₹50.00');
    expect(formatMoney('123456.5', 'INR')).toBe('₹1,23,456.50');
  });

  it('keeps up to 4 decimals for per-mL prices', () => {
    expect(formatUnitPrice('0.2500', 'INR')).toBe('₹0.25/mL');
    expect(formatUnitPrice('0.1250', 'INR')).toBe('₹0.125/mL');
  });
});
