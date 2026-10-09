import type { OrderView } from '@pegpal/shared';
import { Ctx, MACHINE, confirm, createCtx, createOrder, dispenseCommandCount, machineRow, newKey, waitForTerminal } from './helpers';

describe('Orders (integration, mock hardware)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await createCtx();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('runs a multi-liquid recipe sequentially to COMPLETED with simulated evidence', async () => {
    const [water, tonic] = ctx.liquidIds;
    const created = await createOrder(ctx, [
      { liquidId: water, volumeMl: 20 },
      { liquidId: tonic, volumeMl: 10 },
    ]);
    expect(created.order).toMatchObject({ status: 'CREATED', totalVolumeMl: 30, totalPrice: '0.30' });
    expect((await machineRow(ctx)).activeOrderId).toBe(created.order.id);

    const res = await confirm(ctx, created);
    expect(res.status).toBe(200);
    expect(['QUEUED', 'DISPENSING']).toContain(res.body.status);
    expect(res.body.payment).toEqual({ mode: 'TEST_MODE', status: 'TEST_CONFIRMED', isTest: true });

    const done = await waitForTerminal(ctx, created.order.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.items.map((i) => i.status)).toEqual(['COMPLETED', 'COMPLETED']);
    for (const item of done.items) {
      expect(item.verification).toBe('SIMULATED');
      expect(item.measuredMassG).toBeNull();
      expect(item.deliveredMl).toBeGreaterThan(item.requestedMl * 0.9);
    }
    // Sequential: item 2 started after item 1 completed.
    expect(new Date(done.items[1].startedAt!).getTime()).toBeGreaterThanOrEqual(new Date(done.items[0].completedAt!).getTime());
    expect((await machineRow(ctx)).activeOrderId).toBeNull();

    // Every dispense command was persisted, acked and completed.
    const cmds = await ctx.prisma.hardwareCommand.findMany({ where: { orderId: created.order.id, type: 'DISPENSE' }, orderBy: { seq: 'asc' } });
    expect(cmds.map((c) => c.outcome)).toEqual(['DONE', 'DONE']);
    expect(cmds[0].seq).toBeLessThan(cmds[1].seq);
  });

  it('dispenses weight-based liquids after a tare', async () => {
    const syrup = ctx.liquidIds[3];
    const created = await createOrder(ctx, [{ liquidId: syrup, volumeMl: 10 }]);
    await confirm(ctx, created);
    const done = await waitForTerminal(ctx, created.order.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.items[0].targetMassG).toBe(10);
    const types = (await ctx.prisma.hardwareCommand.findMany({ where: { orderId: created.order.id }, orderBy: { seq: 'asc' } })).map((c) => c.type);
    expect(types.slice(0, 2)).toEqual(['TARE', 'DISPENSE']);
  });

  describe('idempotency', () => {
    it('returns the same order for a replayed Idempotency-Key', async () => {
      const key = newKey();
      const body = { machineId: MACHINE, items: [{ liquidId: ctx.liquidIds[0], volumeMl: 10 }] };
      const a = await ctx.http.post('/api/orders').set('Idempotency-Key', key).send(body);
      const b = await ctx.http.post('/api/orders').set('Idempotency-Key', key).send(body);
      expect(a.status).toBe(201);
      expect(b.status).toBe(200);
      expect(b.body.order.id).toBe(a.body.order.id);
      expect(b.body.orderToken).toBe(a.body.orderToken);
      expect(await ctx.prisma.order.count()).toBe(1);
    });

    it('handles concurrent duplicates of the same key as one order', async () => {
      const key = newKey();
      const body = { machineId: MACHINE, items: [{ liquidId: ctx.liquidIds[0], volumeMl: 10 }] };
      const results = await Promise.all([1, 2, 3, 4].map(() => ctx.http.post('/api/orders').set('Idempotency-Key', key).send(body)));
      const ids = new Set(results.filter((r) => r.status < 300).map((r) => r.body.order.id));
      expect(ids.size).toBe(1);
      expect(await ctx.prisma.order.count()).toBe(1);
    });

    it('rejects reuse of a key with a different body', async () => {
      const key = newKey();
      await ctx.http.post('/api/orders').set('Idempotency-Key', key).send({ machineId: MACHINE, items: [{ liquidId: ctx.liquidIds[0], volumeMl: 10 }] });
      const res = await ctx.http.post('/api/orders').set('Idempotency-Key', key).send({ machineId: MACHINE, items: [{ liquidId: ctx.liquidIds[0], volumeMl: 20 }] });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('requires an Idempotency-Key', async () => {
      const res = await ctx.http.post('/api/orders').send({ machineId: MACHINE, items: [{ liquidId: ctx.liquidIds[0], volumeMl: 10 }] });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('a repeated confirm never dispenses twice', async () => {
      const created = await createOrder(ctx, [{ liquidId: ctx.liquidIds[0], volumeMl: 10 }]);
      const results = await Promise.all([confirm(ctx, created), confirm(ctx, created), confirm(ctx, created)]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      const done = await waitForTerminal(ctx, created.order.id);
      expect(done.status).toBe('COMPLETED');
      expect(await dispenseCommandCount(ctx, created.order.id)).toBe(1);
    });
  });

  it('allows only one of many concurrent orders to reserve the machine', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        ctx.http.post('/api/orders').set('Idempotency-Key', newKey()).send({ machineId: MACHINE, items: [{ liquidId: ctx.liquidIds[0], volumeMl: 10 }] }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'MACHINE_BUSY')).toBe(true);
    expect(await ctx.prisma.order.count({ where: { status: 'CREATED' } })).toBe(1);
  });

  describe('validation', () => {
    const post = (items: unknown, machineId: unknown = MACHINE) =>
      ctx.http.post('/api/orders').set('Idempotency-Key', newKey()).send({ machineId, items });

    it.each([
      ['zero', 0, 400],
      ['negative', -5, 400],
      ['fractional', 7.5, 400],
      ['string', '10', 400],
      ['absurd', 1e9, 400],
    ])('rejects %s quantities', async (_, volumeMl, status) => {
      const res = await post([{ liquidId: ctx.liquidIds[0], volumeMl }]);
      expect(res.status).toBe(status);
    });

    it('enforces per-liquid min/max on the server', async () => {
      const res = await post([{ liquidId: ctx.liquidIds[0], volumeMl: 101 }]);
      expect(res.status).toBe(422);
      expect(res.body.details.join(' ')).toMatch(/Maximum is 100 mL/);
    });

    it('enforces the total order volume limit', async () => {
      // ORDER_MAX_TOTAL_ML is 150 in the test environment.
      const res = await post([
        { liquidId: ctx.liquidIds[0], volumeMl: 100 },
        { liquidId: ctx.liquidIds[1], volumeMl: 60 },
      ]);
      expect(res.status).toBe(422);
      expect(res.body.details.join(' ')).toMatch(/exceeds the 150 mL limit/);
    });

    it('rejects duplicate liquids, unknown liquids and uncalibrated liquids', async () => {
      const dup = await post([
        { liquidId: ctx.liquidIds[0], volumeMl: 10 },
        { liquidId: ctx.liquidIds[0], volumeMl: 10 },
      ]);
      expect(dup.status).toBe(422);
      const unknown = await post([{ liquidId: '00000000-0000-4000-8000-000000000000', volumeMl: 10 }]);
      expect(unknown.status).toBe(422);
      const uncal = await post([{ liquidId: ctx.liquidIds[4], volumeMl: 10 }]);
      expect(uncal.status).toBe(422);
      expect(uncal.body.details.join(' ')).toMatch(/calibration/);
    });

    it('rejects unknown fields and unknown machines', async () => {
      const extra = await ctx.http
        .post('/api/orders')
        .set('Idempotency-Key', newKey())
        .send({ machineId: MACHINE, items: [{ liquidId: ctx.liquidIds[0], volumeMl: 10 }], price: 0 });
      expect(extra.status).toBe(400);
      expect((await post([{ liquidId: ctx.liquidIds[0], volumeMl: 10 }], 'NOPE')).status).toBe(404);
      expect((await ctx.http.get('/api/machines/NOPE')).status).toBe(404);
    });
  });

  describe('state transitions', () => {
    it('cancels a CREATED order immediately and releases the machine', async () => {
      const created = await createOrder(ctx, [{ liquidId: ctx.liquidIds[0], volumeMl: 10 }]);
      const res = await ctx.http.post(`/api/orders/${created.order.id}/cancel`).set('X-Order-Token', created.orderToken);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CANCELLED');
      expect((await machineRow(ctx)).activeOrderId).toBeNull();
      expect(await dispenseCommandCount(ctx, created.order.id)).toBe(0);
    });

    it('refuses to confirm a cancelled order', async () => {
      const created = await createOrder(ctx, [{ liquidId: ctx.liquidIds[0], volumeMl: 10 }]);
      await ctx.http.post(`/api/orders/${created.order.id}/cancel`).set('X-Order-Token', created.orderToken);
      const res = await confirm(ctx, created);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_TRANSITION');
    });

    it('cancel on a terminal order is a no-op', async () => {
      const created = await createOrder(ctx, [{ liquidId: ctx.liquidIds[0], volumeMl: 5 }]);
      await confirm(ctx, created);
      await waitForTerminal(ctx, created.order.id);
      const res = await ctx.http.post(`/api/orders/${created.order.id}/cancel`).set('X-Order-Token', created.orderToken);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('COMPLETED');
    });

    it('requires the order token for confirm and cancel', async () => {
      const created = await createOrder(ctx, [{ liquidId: ctx.liquidIds[0], volumeMl: 10 }]);
      expect((await ctx.http.post(`/api/orders/${created.order.id}/confirm`).send({ testPaymentConfirmed: true })).status).toBe(401);
      expect((await ctx.http.post(`/api/orders/${created.order.id}/cancel`).set('X-Order-Token', 'wrong')).status).toBe(401);
    });

    it('requires explicit simulated-payment confirmation in TEST_MODE', async () => {
      const created = await createOrder(ctx, [{ liquidId: ctx.liquidIds[0], volumeMl: 10 }]);
      const res = await ctx.http.post(`/api/orders/${created.order.id}/confirm`).set('X-Order-Token', created.orderToken).send({});
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('TEST_PAYMENT_NOT_CONFIRMED');
    });

    it('expires unconfirmed orders and frees the machine', async () => {
      const created = await createOrder(ctx, [{ liquidId: ctx.liquidIds[0], volumeMl: 10 }]);
      await ctx.prisma.order.update({ where: { id: created.order.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await confirm(ctx, created);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ORDER_EXPIRED');
      expect((await machineRow(ctx)).activeOrderId).toBeNull();
    });

    it('cancelling while dispensing stops the pump and only then reports CANCELLED', async () => {
      const created = await createOrder(ctx, [
        { liquidId: ctx.liquidIds[0], volumeMl: 60 },
        { liquidId: ctx.liquidIds[1], volumeMl: 20 },
      ]);
      await confirm(ctx, created);
      await waitUntilDispensing(ctx, created.order.id);
      const res = await ctx.http.post(`/api/orders/${created.order.id}/cancel`).set('X-Order-Token', created.orderToken);
      expect([200, 202]).toContain(res.status);
      if (res.status === 202) {
        expect(res.body.status).toBe('DISPENSING');
        expect(res.body.cancelRequested).toBe(true);
      }
      const done = await waitForTerminal(ctx, created.order.id);
      expect(done.status).toBe('CANCELLED');
      expect(done.items[0].status).toBe('STOPPED');
      expect(done.items[1].status).toBe('SKIPPED');
      const stopped = await ctx.prisma.hardwareCommand.findFirst({ where: { orderId: created.order.id, type: 'STOP' } });
      expect(stopped?.outcome).toBe('DONE');
      expect((await machineRow(ctx)).status).toBe('IN_SERVICE');
    });
  });

  it('streams a snapshot, progress and a final snapshot over SSE', async () => {
    const created = await createOrder(ctx, [{ liquidId: ctx.liquidIds[0], volumeMl: 20 }]);
    const messages: { type: string; order?: OrderView }[] = [];
    const server = ctx.app.getHttpServer();
    const port = await new Promise<number>((resolve) => {
      const s = server.listen(0, () => resolve((s.address() as { port: number }).port));
    });
    const streamDone = fetch(`http://127.0.0.1:${port}/api/orders/${created.order.id}/events`).then(async (r) => {
      expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
      const text = await r.text();
      for (const line of text.split('\n')) if (line.startsWith('data: ')) messages.push(JSON.parse(line.slice(6)));
    });
    await confirm(ctx, created);
    await streamDone;
    server.close();
    expect(messages[0].type).toBe('snapshot');
    expect(messages.some((m) => m.type === 'progress')).toBe(true);
    expect(messages.at(-1)?.order?.status).toBe('COMPLETED');
  });
});

async function waitUntilDispensing(ctx: Ctx, orderId: string): Promise<void> {
  const { waitUntil } = await import('./helpers');
  await waitUntil(async () => {
    const item = await ctx.prisma.orderItem.findFirst({ where: { orderId, position: 0 } });
    const cmd = await ctx.prisma.hardwareCommand.findFirst({ where: { orderId, type: 'DISPENSE' } });
    return item?.status === 'DISPENSING' && cmd?.outcome === 'ACKED';
  });
}
