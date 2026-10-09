import { Prisma } from '@prisma/client';

export interface PricedLine {
  liquidId: string;
  volumeMl: number;
  unitPrice: Prisma.Decimal;
  linePrice: Prisma.Decimal;
}

/** Server-side pricing. Lines are rounded half-up to cents; the total is their sum. */
export function priceLines(lines: { liquidId: string; volumeMl: number; pricePerMl: Prisma.Decimal }[]): {
  lines: PricedLine[];
  total: Prisma.Decimal;
} {
  const priced = lines.map((l) => ({
    liquidId: l.liquidId,
    volumeMl: l.volumeMl,
    unitPrice: l.pricePerMl,
    linePrice: l.pricePerMl.mul(l.volumeMl).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
  }));
  const total = priced.reduce((sum, l) => sum.add(l.linePrice), new Prisma.Decimal(0));
  return { lines: priced, total };
}
