import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { CreateOrderResponse, OrderView } from '@pegpal/shared';
import { isTerminalStatus } from '@pegpal/shared';
import { DispenseStrategy, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { CalibrationService } from '../src/admin/calibration.service';
import { AppModule } from '../src/app.module';
import { loadConfig } from '../src/config/config';
import { DispensingService } from '../src/dispensing/dispensing.service';
import { RecoveryService } from '../src/dispensing/recovery.service';
import { HARDWARE_ADAPTER } from '../src/hardware/hardware-adapter';
import { MockHardwareAdapter } from '../src/hardware/mock/mock-hardware.adapter';
import { PrismaService } from '../src/prisma/prisma.service';
import { setupApp } from '../src/setup-app';

export const MACHINE = 'MACHINE_T1';

/** Channel = index. Flow rates equal the simulator's so TIMED results land on target. */
export const TEST_LIQUIDS: { name: string; strategy: DispenseStrategy; density: number | null; flow: number | null }[] = [
  { name: 'Water', strategy: 'TIMED', density: 1, flow: 2.0 },
  { name: 'Tonic', strategy: 'TIMED', density: 1.03, flow: 2.2 },
  { name: 'Cola', strategy: 'TIMED', density: 1.04, flow: 1.8 },
  { name: 'Syrup', strategy: 'WEIGHT', density: 1.0, flow: 2.5 },
  { name: 'Uncalibrated', strategy: 'TIMED', density: null, flow: null },
];

export async function resetDatabase(): Promise<{ machineId: string; liquidIds: string[] }> {
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe(
      'TRUNCATE "DispensingEvent","HardwareCommand","OrderItem","Order","CalibrationRun","MachineCredential","Liquid","Machine" CASCADE',
    );
    const machine = await prisma.machine.create({ data: { publicId: MACHINE, name: 'Test Machine', currency: 'INR' } });
    const liquidIds: string[] = [];
    for (const [channel, l] of TEST_LIQUIDS.entries()) {
      const row = await prisma.liquid.create({
        data: {
          machineId: machine.id,
          name: l.name,
          pumpChannel: channel,
          strategy: l.strategy,
          densityGPerMl: l.density,
          flowRateMlPerSec: l.flow,
          cutoffMarginG: 0.5,
          minMl: 5,
          maxMl: 100,
          pricePerMl: new Prisma.Decimal('0.0100'),
          remainingStockMl: 1000,
        },
      });
      liquidIds.push(row.id);
    }
    return { machineId: machine.id, liquidIds };
  } finally {
    await prisma.$disconnect();
  }
}

export interface Ctx {
  app: INestApplication;
  http: ReturnType<typeof request>;
  prisma: PrismaService;
  mock: MockHardwareAdapter;
  dispensing: DispensingService;
  calibration: CalibrationService;
  recovery: RecoveryService;
  machineId: string;
  liquidIds: string[];
  close(): Promise<void>;
}

export async function createCtx(seeded?: { machineId: string; liquidIds: string[] }): Promise<Ctx> {
  const seed = seeded ?? (await resetDatabase());
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: ['error'] });
  setupApp(app, loadConfig());
  await app.init();
  const prisma = app.get(PrismaService);
  const ctx: Ctx = {
    app,
    http: request(app.getHttpServer()),
    prisma,
    mock: app.get<MockHardwareAdapter>(HARDWARE_ADAPTER),
    dispensing: app.get(DispensingService),
    calibration: app.get(CalibrationService),
    recovery: app.get(RecoveryService),
    ...seed,
    close: async () => {
      await ctx.dispensing.idle();
      await ctx.calibration.idle();
      await app.close();
    },
  };
  await waitUntil(async () => (await prisma.machine.findUniqueOrThrow({ where: { id: seed.machineId } })).hardwareConnection === 'CONNECTED');
  // Let the post-connect STATUS exchange settle so it can't interleave with a test's first command.
  await sleep(50);
  return ctx;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(fn: () => Promise<boolean> | boolean, timeoutMs = 10_000, stepMs = 25): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(stepMs);
  }
  throw new Error('waitUntil timed out');
}

let keyCounter = 0;
export function newKey(): string {
  return `test-key-${Date.now()}-${++keyCounter}`;
}

export async function createOrder(
  ctx: Ctx,
  items: { liquidId: string; volumeMl: number }[],
  key = newKey(),
): Promise<CreateOrderResponse> {
  const res = await ctx.http.post('/api/orders').set('Idempotency-Key', key).send({ machineId: MACHINE, items });
  if (res.status !== 201) throw new Error(`create failed ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as CreateOrderResponse;
}

export async function confirm(ctx: Ctx, created: CreateOrderResponse) {
  return ctx.http
    .post(`/api/orders/${created.order.id}/confirm`)
    .set('X-Order-Token', created.orderToken)
    .send({ testPaymentConfirmed: true });
}

export async function waitForTerminal(ctx: Ctx, orderId: string, timeoutMs = 15_000): Promise<OrderView> {
  let order!: OrderView;
  await waitUntil(async () => {
    order = (await ctx.http.get(`/api/orders/${orderId}`)).body as OrderView;
    return isTerminalStatus(order.status);
  }, timeoutMs);
  await ctx.dispensing.idle();
  return (await ctx.http.get(`/api/orders/${orderId}`)).body as OrderView;
}

export async function adminToken(ctx: Ctx): Promise<string> {
  const res = await ctx.http.post('/api/admin/auth/login').send({ username: 'operator', password: 'pegpal-dev-password' });
  if (res.status !== 200) throw new Error(`login failed ${res.status}`);
  return (res.body as { accessToken: string }).accessToken;
}

export async function machineRow(ctx: Ctx) {
  return ctx.prisma.machine.findUniqueOrThrow({ where: { id: ctx.machineId } });
}

export async function dispenseCommandCount(ctx: Ctx, orderId: string): Promise<number> {
  return ctx.prisma.hardwareCommand.count({ where: { orderId, type: 'DISPENSE' } });
}
