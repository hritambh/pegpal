/**
 * Development seed: one machine with 10 configurable liquids.
 * Flow rates match the mock simulator's channels and are flagged as
 * simulated calibrations. Recalibrate on real hardware before use.
 * Idempotent: re-running updates the same rows.
 */
import { DispenseStrategy, Prisma, PrismaClient } from '@prisma/client';

try {
  process.loadEnvFile('.env');
} catch {
  /* env injected */
}

const prisma = new PrismaClient();

interface SeedLiquid {
  name: string;
  strategy: DispenseStrategy;
  density: number | null;
  flow: number;
  price: string;
  minMl: number;
  maxMl: number;
  stock: number;
}

// Index = pump channel. Non-alcoholic placeholders; operators rename/reprice via the admin UI.
// Prices are in INR per mL (e.g. 200 mL cola = ₹50).
const LIQUIDS: SeedLiquid[] = [
  { name: 'Sparkling water', strategy: 'TIMED', density: 1.0, flow: 2.0, price: '0.1000', minMl: 10, maxMl: 250, stock: 5000 },
  { name: 'Tonic water', strategy: 'TIMED', density: 1.03, flow: 2.2, price: '0.3000', minMl: 10, maxMl: 200, stock: 5000 },
  { name: 'Cola', strategy: 'TIMED', density: 1.04, flow: 1.8, price: '0.2500', minMl: 10, maxMl: 250, stock: 5000 },
  { name: 'Orange juice', strategy: 'TIMED', density: 1.04, flow: 2.5, price: '0.5000', minMl: 10, maxMl: 200, stock: 3000 },
  { name: 'Lemon juice', strategy: 'TIMED', density: 1.03, flow: 1.5, price: '0.8000', minMl: 5, maxMl: 50, stock: 2000 },
  { name: 'Ginger beer', strategy: 'TIMED', density: 1.04, flow: 3.0, price: '0.4000', minMl: 10, maxMl: 200, stock: 5000 },
  { name: 'Cranberry juice', strategy: 'TIMED', density: 1.05, flow: 2.0, price: '0.6000', minMl: 10, maxMl: 150, stock: 3000 },
  { name: 'Grenadine syrup', strategy: 'WEIGHT', density: 1.3, flow: 1.2, price: '1.0000', minMl: 5, maxMl: 30, stock: 1000 },
  { name: 'Apple juice', strategy: 'TIMED', density: 1.04, flow: 2.8, price: '0.4500', minMl: 10, maxMl: 200, stock: 3000 },
  { name: 'Lime cordial', strategy: 'TIMED', density: null, flow: 2.4, price: '0.7000', minMl: 5, maxMl: 40, stock: 2000 },
];

async function main(): Promise<void> {
  const machine = await prisma.machine.upsert({
    where: { publicId: 'MACHINE_001' },
    update: { currency: 'INR' },
    create: { publicId: 'MACHINE_001', name: 'PegPal Demo Bar', currency: 'INR' },
  });

  for (const [channel, l] of LIQUIDS.entries()) {
    const data = {
      name: l.name,
      strategy: l.strategy,
      densityGPerMl: l.density,
      flowRateMlPerSec: l.flow,
      cutoffMarginG: 1,
      calibratedAt: new Date(),
      calibrationSimulated: true,
      minMl: l.minMl,
      maxMl: l.maxMl,
      pricePerMl: new Prisma.Decimal(l.price),
      active: true,
      remainingStockMl: l.stock,
    };
    await prisma.liquid.upsert({
      where: { machineId_pumpChannel: { machineId: machine.id, pumpChannel: channel } },
      update: data,
      create: { ...data, machineId: machine.id, pumpChannel: channel },
    });
  }
  console.log(`Seeded ${machine.publicId} (${machine.id}) with ${LIQUIDS.length} liquids.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
