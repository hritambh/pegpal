import { Ctx, confirm, createCtx, createOrder, dispenseCommandCount, machineRow, resetDatabase, sleep, waitForTerminal, waitUntil } from './helpers';

/**
 * Hardware fault handling. Every scenario must end with pumps reported off
 * (or the machine locked for inspection) and must never claim an ingredient
 * was dispensed without a completion report.
 */
describe('Fault handling (integration, mock hardware)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await createCtx();
  });
  afterEach(async () => {
    await ctx.close();
  });

  const mockId = () => 'MACHINE_T1';

  it('pump failure mid-order: completed items stay completed, the rest are skipped, order FAILED', async () => {
    ctx.mock.configure(mockId(), { failChannel: 1 });
    const created = await createOrder(ctx, [
      { liquidId: ctx.liquidIds[0], volumeMl: 10 },
      { liquidId: ctx.liquidIds[1], volumeMl: 10 },
      { liquidId: ctx.liquidIds[2], volumeMl: 10 },
    ]);
    await confirm(ctx, created);
    const done = await waitForTerminal(ctx, created.order.id);
    expect(done.status).toBe('FAILED');
    expect(done.items.map((i) => i.status)).toEqual(['COMPLETED', 'FAILED', 'SKIPPED']);
    expect(done.failureReason).toMatch(/PUMP_FAULT/);
    // The controller reported the pump off, so the machine stays usable.
    expect((await machineRow(ctx)).status).toBe('IN_SERVICE');
    expect((await machineRow(ctx)).activeOrderId).toBeNull();
  });

  it('lost ACKs: outcome is uncertain, item UNKNOWN, machine locked, no retry dispense', async () => {
    ctx.mock.configure(mockId(), { dropAcks: true });
    const created = await createOrder(ctx, [
      { liquidId: ctx.liquidIds[0], volumeMl: 10 },
      { liquidId: ctx.liquidIds[1], volumeMl: 10 },
    ]);
    await confirm(ctx, created);
    const done = await waitForTerminal(ctx, created.order.id);
    expect(done.status).toBe('FAILED');
    expect(done.items[0]).toMatchObject({ status: 'UNKNOWN', verification: 'UNVERIFIED' });
    expect(done.items[1].status).toBe('SKIPPED');
    expect(done.failureReason).toMatch(/unverified/);
    const m = await machineRow(ctx);
    expect(m.status).toBe('NEEDS_ATTENTION');
    // Retransmissions reuse the same command; only one DISPENSE row exists.
    expect(await dispenseCommandCount(ctx, created.order.id)).toBe(1);
    const cmd = await ctx.prisma.hardwareCommand.findFirstOrThrow({ where: { orderId: created.order.id, type: 'DISPENSE' } });
    expect(cmd.attempts).toBeGreaterThan(1);
    // The command log may later record what the controller reports (e.g. a late DONE),
    // but the order item is never upgraded retroactively: it stays UNKNOWN for operator review.
    expect(['UNKNOWN', 'STOPPED', 'DONE']).toContain(cmd.outcome);
    // A STOP was sent for safety.
    expect(await ctx.prisma.hardwareCommand.count({ where: { orderId: created.order.id, type: 'STOP' } })).toBeGreaterThan(0);
  });

  it('a lost command packet is recovered by retransmitting the identical command (no double dispense)', async () => {
    const realSend = ctx.mock.send.bind(ctx.mock);
    let dropped = false;
    jest.spyOn(ctx.mock, 'send').mockImplementation(async (cmd) => {
      if (cmd.type === 'DISPENSE' && !dropped) {
        dropped = true; // lost on the wire
        return;
      }
      return realSend(cmd);
    });
    const created = await createOrder(ctx, [{ liquidId: ctx.liquidIds[0], volumeMl: 10 }]);
    await confirm(ctx, created);
    const done = await waitForTerminal(ctx, created.order.id);
    expect(done.status).toBe('COMPLETED');
    const cmd = await ctx.prisma.hardwareCommand.findFirstOrThrow({ where: { orderId: created.order.id, type: 'DISPENSE' } });
    expect(cmd.attempts).toBe(2);
    expect(await dispenseCommandCount(ctx, created.order.id)).toBe(1);
  });

  it('missing completion report: times out as uncertain and locks the machine', async () => {
    ctx.mock.configure(mockId(), { dropCompletion: true });
    const created = await createOrder(ctx, [{ liquidId: ctx.liquidIds[0], volumeMl: 5 }]);
    await confirm(ctx, created);
    const done = await waitForTerminal(ctx, created.order.id);
    expect(done.status).toBe('FAILED');
    expect(done.items[0].status).toBe('UNKNOWN');
    expect(done.items[0].status).not.toBe('COMPLETED');
    expect((await machineRow(ctx)).status).toBe('NEEDS_ATTENTION');
  });

  it('emergency stop mid-order: SAFETY_STOPPED, machine unavailable while latched', async () => {
    ctx.mock.configure(mockId(), { estopAtFraction: 0.4 });
    const created = await createOrder(ctx, [
      { liquidId: ctx.liquidIds[0], volumeMl: 20 },
      { liquidId: ctx.liquidIds[1], volumeMl: 10 },
    ]);
    await confirm(ctx, created);
    const done = await waitForTerminal(ctx, created.order.id);
    expect(done.status).toBe('SAFETY_STOPPED');
    expect(done.items.map((i) => i.status)).toEqual(['STOPPED', 'SKIPPED']);
    await waitUntil(async () => (await machineRow(ctx)).estopActive);
    expect((await machineRow(ctx)).status).toBe('NEEDS_ATTENTION');
    expect((await ctx.http.get('/api/machines/MACHINE_T1')).body.availability).toBe('OUT_OF_SERVICE');
    const safety = await ctx.prisma.dispensingEvent.findMany({ where: { severity: 'SAFETY', type: 'ESTOP_PRESSED' } });
    expect(safety).toHaveLength(1);
  });

  it('a latched e-stop blocks new orders', async () => {
    ctx.mock.setEstop(mockId(), true);
    await waitUntil(async () => (await machineRow(ctx)).estopActive);
    const res = await ctx.http
      .post('/api/orders')
      .set('Idempotency-Key', 'estop-blocked-key')
      .send({ machineId: 'MACHINE_T1', items: [{ liquidId: ctx.liquidIds[0], volumeMl: 10 }] });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/emergency stop/);
  });

  it('controller disconnect mid-dispense: FAILED and unverified; firmware reports its local stop on reconnect', async () => {
    ctx.mock.configure(mockId(), { disconnectAtFraction: 0.5 });
    const created = await createOrder(ctx, [{ liquidId: ctx.liquidIds[0], volumeMl: 20 }]);
    await confirm(ctx, created);
    const done = await waitForTerminal(ctx, created.order.id);
    expect(done.status).toBe('FAILED');
    expect(done.items[0]).toMatchObject({ status: 'UNKNOWN', verification: 'UNVERIFIED' });
    expect((await machineRow(ctx)).hardwareConnection).toBe('DISCONNECTED');
    expect((await ctx.http.get('/api/machines/MACHINE_T1')).body.availability).toBe('OUT_OF_SERVICE');

    ctx.mock.configure(mockId(), { disconnectAtFraction: null });
    ctx.mock.setConnected(mockId(), true);
    await waitUntil(async () => (await machineRow(ctx)).hardwareConnection === 'CONNECTED');
    // Reconciled from the controller's own report, without changing the order or replaying anything.
    await waitUntil(async () => (await ctx.prisma.hardwareCommand.findFirstOrThrow({ where: { orderId: created.order.id, type: 'DISPENSE' } })).outcome === 'FAILED');
    expect((await ctx.http.get(`/api/orders/${created.order.id}`)).body.status).toBe('FAILED');
    expect(await dispenseCommandCount(ctx, created.order.id)).toBe(1);
  });

  it('offline controller: order is refused up front', async () => {
    ctx.mock.setConnected(mockId(), false);
    await waitUntil(async () => (await machineRow(ctx)).hardwareConnection === 'DISCONNECTED');
    const res = await ctx.http
      .post('/api/orders')
      .set('Idempotency-Key', 'offline-key-1')
      .send({ machineId: 'MACHINE_T1', items: [{ liquidId: ctx.liquidIds[0], volumeMl: 10 }] });
    expect(res.status).toBe(422);
  });

  it('missing scale: weight-based order fails before any pump runs', async () => {
    ctx.mock.configure(mockId(), { scaleMissing: true });
    const created = await createOrder(ctx, [{ liquidId: ctx.liquidIds[3], volumeMl: 10 }]);
    await confirm(ctx, created);
    const done = await waitForTerminal(ctx, created.order.id);
    expect(done.status).toBe('FAILED');
    expect(done.failureReason).toMatch(/Scale not ready/);
    expect(await dispenseCommandCount(ctx, created.order.id)).toBe(0);
    expect((await machineRow(ctx)).status).toBe('IN_SERVICE');
  });

  it('unstable scale on tare: refuses to dispense', async () => {
    ctx.mock.configure(mockId(), { scaleUnstable: true });
    const created = await createOrder(ctx, [{ liquidId: ctx.liquidIds[3], volumeMl: 10 }]);
    await confirm(ctx, created);
    const done = await waitForTerminal(ctx, created.order.id);
    expect(done.status).toBe('FAILED');
    expect(done.failureReason).toMatch(/SCALE_UNSTABLE/);
    expect(await dispenseCommandCount(ctx, created.order.id)).toBe(0);
  });

  it('flow-rate drift is visible in the reported (simulated) volume rather than hidden', async () => {
    ctx.mock.configure(mockId(), { flowRateMultiplier: 0.5 });
    const created = await createOrder(ctx, [{ liquidId: ctx.liquidIds[0], volumeMl: 20 }]);
    await confirm(ctx, created);
    const done = await waitForTerminal(ctx, created.order.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.items[0].deliveredMl).toBeLessThan(12);
    expect(done.items[0].verification).toBe('SIMULATED');
  });
});

describe('Recovery after backend restart', () => {
  /** Writes the DB state a crashed backend would leave behind, then boots a fresh app. */
  async function crashState(status: 'QUEUED' | 'DISPENSING') {
    const seed = await resetDatabase();
    const { PrismaClient, Prisma } = await import('@prisma/client');
    const raw = new PrismaClient();
    const order = await raw.order.create({
      data: {
        machineId: seed.machineId,
        status,
        totalVolumeMl: 20,
        totalPrice: new Prisma.Decimal('0.20'),
        currency: 'USD',
        idempotencyKey: `recovery-${status}`,
        requestHash: 'x',
        paymentMode: 'TEST_MODE',
        paymentStatus: 'TEST_CONFIRMED',
        dispensingStartedAt: status === 'DISPENSING' ? new Date() : null,
        items: {
          create: [0, 1].map((position) => ({
            position,
            liquidId: seed.liquidIds[position],
            liquidName: `L${position}`,
            pumpChannel: position,
            unitPrice: new Prisma.Decimal('0.01'),
            linePrice: new Prisma.Decimal('0.10'),
            requestedMl: 10,
            status: status === 'DISPENSING' && position === 0 ? ('DISPENSING' as const) : ('PENDING' as const),
          })),
        },
      },
    });
    if (status === 'DISPENSING') {
      await raw.hardwareCommand.create({
        data: { id: '11111111-1111-4111-8111-111111111111', machineId: seed.machineId, orderId: order.id, type: 'DISPENSE', seq: 1, payload: {}, outcome: 'ACKED' },
      });
    }
    await raw.machine.update({ where: { id: seed.machineId }, data: { activeOrderId: order.id, commandSeq: 1 } });
    await raw.$disconnect();
    return { seed, orderId: order.id };
  }

  it('fails a DISPENSING order without resuming it and locks the machine for inspection', async () => {
    const { seed, orderId } = await crashState('DISPENSING');
    const ctx = await createCtx(seed); // RecoveryService runs during init
    try {
      const order = (await ctx.http.get(`/api/orders/${orderId}`)).body;
      expect(order.status).toBe('FAILED');
      expect(order.failureReason).toMatch(/restart while dispensing; outcome unverified/);
      expect(order.items.map((i: { status: string }) => i.status)).toEqual(['UNKNOWN', 'SKIPPED']);
      expect(order.items[0].verification).toBe('UNVERIFIED');
      const m = await machineRow(ctx);
      expect(m.status).toBe('NEEDS_ATTENTION');
      expect(m.activeOrderId).toBeNull();
      await sleep(200);
      expect(await dispenseCommandCount(ctx, orderId)).toBe(1); // nothing new was sent
      const cmd = await ctx.prisma.hardwareCommand.findUniqueOrThrow({ where: { id: '11111111-1111-4111-8111-111111111111' } });
      expect(cmd.outcome).toBe('UNKNOWN');
      const audit = await ctx.prisma.dispensingEvent.findFirst({ where: { type: 'ORDER_RECOVERED_AFTER_RESTART', orderId } });
      expect(audit?.payload).toMatchObject({ previousStatus: 'DISPENSING', resumed: false });
      expect((await ctx.http.get('/api/machines/MACHINE_T1')).body.availability).toBe('OUT_OF_SERVICE');
    } finally {
      await ctx.close();
    }
  });

  it('fails QUEUED orders that never started without locking the machine', async () => {
    const { seed, orderId } = await crashState('QUEUED');
    const ctx = await createCtx(seed);
    try {
      const view = (await ctx.http.get(`/api/orders/${orderId}`)).body;
      expect(view.status).toBe('FAILED');
      expect(view.items.map((i: { status: string }) => i.status)).toEqual(['SKIPPED', 'SKIPPED']);
      const m = await machineRow(ctx);
      expect(m.status).toBe('IN_SERVICE');
      expect(m.activeOrderId).toBeNull();
      expect(await dispenseCommandCount(ctx, orderId)).toBe(0);
    } finally {
      await ctx.close();
    }
  });
});
