import type { AdminOverview, CalibrationRunView } from '@pegpal/shared';
import { Ctx, adminToken, confirm, createCtx, createOrder, machineRow, waitForTerminal, waitUntil } from './helpers';

describe('Admin (integration)', () => {
  let ctx: Ctx;
  let token: string;
  beforeEach(async () => {
    ctx = await createCtx();
    token = await adminToken(ctx);
  });
  afterEach(async () => {
    await ctx.close();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  describe('authentication', () => {
    it.each([
      ['get', '/api/admin/overview'],
      ['get', '/api/admin/orders'],
      ['get', '/api/admin/events'],
      ['post', '/api/admin/calibration/runs'],
      ['post', '/api/admin/machines/00000000-0000-4000-8000-000000000000/stop'],
      ['post', '/api/admin/mock/00000000-0000-4000-8000-000000000000/estop'],
    ] as const)('%s %s requires a token', async (method, path) => {
      expect((await ctx.http[method](path)).status).toBe(401);
      expect((await ctx.http[method](path).set('Authorization', 'Bearer not-a-jwt')).status).toBe(401);
    });

    it('rejects wrong credentials', async () => {
      const res = await ctx.http.post('/api/admin/auth/login').send({ username: 'operator', password: 'nope' });
      expect(res.status).toBe(401);
      expect(await ctx.prisma.dispensingEvent.count({ where: { type: 'ADMIN_LOGIN_FAILED' } })).toBe(1);
    });
  });

  it('shows the overview with the mock hardware indicator', async () => {
    const res = await ctx.http.get('/api/admin/overview').set(auth());
    const body = res.body as AdminOverview;
    expect(body.hardwareMode).toBe('mock');
    expect(body.paymentMode).toBe('TEST_MODE');
    expect(body.machines[0]).toMatchObject({ publicId: 'MACHINE_T1', availability: 'AVAILABLE', hardwareConnection: 'CONNECTED' });
  });

  it('configures liquids and enforces unique pump mapping', async () => {
    const list = await ctx.http.get(`/api/admin/machines/${ctx.machineId}/liquids`).set(auth());
    expect(list.body).toHaveLength(5);
    const create = await ctx.http
      .post(`/api/admin/machines/${ctx.machineId}/liquids`)
      .set(auth())
      .send({ name: 'Soda', pumpChannel: 5, strategy: 'TIMED', minMl: 5, maxMl: 80, pricePerMl: '0.0090', active: true });
    expect(create.status).toBe(201);
    expect(create.body.flowRateMlPerSec).toBeNull(); // uncalibrated until measured
    const clash = await ctx.http
      .post(`/api/admin/machines/${ctx.machineId}/liquids`)
      .set(auth())
      .send({ name: 'Clash', pumpChannel: 5, strategy: 'TIMED', minMl: 5, maxMl: 80, pricePerMl: '0.01', active: true });
    expect(clash.status).toBe(409);
    const bad = await ctx.http
      .post(`/api/admin/machines/${ctx.machineId}/liquids`)
      .set(auth())
      .send({ name: 'Bad', pumpChannel: 42, strategy: 'TIMED', minMl: 5, maxMl: 80, pricePerMl: '0.01', active: true });
    expect(bad.status).toBe(400);
    const moved = await ctx.http.patch(`/api/admin/liquids/${ctx.liquidIds[0]}`).set(auth()).send({ pumpChannel: 6 });
    expect(moved.body.flowRateMlPerSec).toBeNull(); // remapping invalidates calibration
  });

  it('runs a simulated flow-rate calibration end to end', async () => {
    const start = await ctx.http
      .post('/api/admin/calibration/runs')
      .set(auth())
      .send({ liquidId: ctx.liquidIds[2], kind: 'FLOW_RATE', runtimeMs: 10_000 });
    expect(start.status).toBe(201);
    expect(start.body).toMatchObject({ status: 'RUNNING', simulated: true });
    expect((await ctx.http.get('/api/machines/MACHINE_T1')).body.availability).toBe('BUSY');

    let run!: CalibrationRunView;
    await waitUntil(async () => {
      run = (await ctx.http.get(`/api/admin/calibration/runs/${start.body.id}`).set(auth())).body;
      return run.status !== 'RUNNING';
    });
    expect(run.status).toBe('AWAITING_MEASUREMENT');
    expect(run.simulatedReadingMl).toBeGreaterThan(15);

    const measured = await ctx.http
      .post(`/api/admin/calibration/runs/${run.id}/measurement`)
      .set(auth())
      .send({ measuredMl: 20, measuredMassG: 20.8 });
    expect(measured.status).toBe(200);
    expect(measured.body.computedFlowRate).toBeCloseTo(20 / (run.actualRuntimeMs! / 1000), 2);
    expect(measured.body.computedDensity).toBeCloseTo(1.04, 3);

    const applied = await ctx.http.post(`/api/admin/calibration/runs/${run.id}/apply`).set(auth());
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ calibrationSimulated: true, densityGPerMl: 1.04 });
    expect((await ctx.http.post(`/api/admin/calibration/runs/${run.id}/apply`).set(auth())).status).toBe(409);
    expect((await machineRow(ctx)).activeCalibrationRunId).toBeNull();
  });

  it('runs a validation dispense and compares requested vs measured', async () => {
    const start = await ctx.http.post('/api/admin/calibration/runs').set(auth()).send({ liquidId: ctx.liquidIds[0], kind: 'VALIDATION', targetMl: 20 });
    await waitUntil(async () => (await ctx.http.get(`/api/admin/calibration/runs/${start.body.id}`).set(auth())).body.status === 'AWAITING_MEASUREMENT');
    const measured = await ctx.http.post(`/api/admin/calibration/runs/${start.body.id}/measurement`).set(auth()).send({ measuredMl: 19 });
    expect(measured.body.errorPct).toBeCloseTo(-5, 5);
    expect((await ctx.http.post(`/api/admin/calibration/runs/${start.body.id}/apply`).set(auth())).status).toBe(409);
  });

  it('bounds calibration runtime', async () => {
    const res = await ctx.http.post('/api/admin/calibration/runs').set(auth()).send({ liquidId: ctx.liquidIds[0], kind: 'FLOW_RATE', runtimeMs: 100_000 });
    expect(res.status).toBe(422);
  });

  it('operator stop interrupts a running order (FAILED, pumps confirmed off)', async () => {
    const created = await createOrder(ctx, [{ liquidId: ctx.liquidIds[0], volumeMl: 60 }]);
    await confirm(ctx, created);
    await waitUntil(async () => (await ctx.prisma.hardwareCommand.findFirst({ where: { orderId: created.order.id, type: 'DISPENSE' } }))?.outcome === 'ACKED');
    const res = await ctx.http.post(`/api/admin/machines/${ctx.machineId}/stop`).set(auth()).send({ reason: 'spill' });
    expect(res.status).toBe(200);
    const done = await waitForTerminal(ctx, created.order.id);
    expect(done.status).toBe('FAILED');
    expect(done.failureReason).toBe('Stopped by operator');
    expect(done.items[0].status).toBe('STOPPED');
  });

  it('clear-fault requires the physical e-stop to be released first', async () => {
    ctx.mock.setEstop('MACHINE_T1', true);
    await waitUntil(async () => (await machineRow(ctx)).estopActive);
    await ctx.prisma.machine.update({ where: { id: ctx.machineId }, data: { status: 'NEEDS_ATTENTION', faultReason: 'test' } });
    const blocked = await ctx.http.post(`/api/admin/machines/${ctx.machineId}/clear-fault`).set(auth()).send({ note: 'inspected' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('ESTOP_ACTIVE');

    ctx.mock.setEstop('MACHINE_T1', false); // local, physical reset
    await waitUntil(async () => !(await machineRow(ctx)).estopActive);
    const cleared = await ctx.http.post(`/api/admin/machines/${ctx.machineId}/clear-fault`).set(auth()).send({ note: 'inspected' });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ status: 'IN_SERVICE', availability: 'AVAILABLE', faultReason: null });
  });

  it('cannot put a NEEDS_ATTENTION machine back in service without clear-fault', async () => {
    await ctx.prisma.machine.update({ where: { id: ctx.machineId }, data: { status: 'NEEDS_ATTENTION' } });
    const res = await ctx.http.patch(`/api/admin/machines/${ctx.machineId}`).set(auth()).send({ status: 'IN_SERVICE' });
    expect(res.status).toBe(409);
  });

  it('issues, lists and revokes machine credentials (secret shown once, encrypted at rest)', async () => {
    const issued = await ctx.http.post(`/api/admin/machines/${ctx.machineId}/credentials`).set(auth());
    expect(issued.status).toBe(201);
    expect(issued.body.secret).toHaveLength(43);
    const row = await ctx.prisma.machineCredential.findUniqueOrThrow({ where: { keyId: issued.body.keyId } });
    expect(row.secretEncrypted).not.toContain(issued.body.secret);
    const list = await ctx.http.get(`/api/admin/machines/${ctx.machineId}/credentials`).set(auth());
    expect(list.body[0]).not.toHaveProperty('secret');
    const revoked = await ctx.http.post(`/api/admin/credentials/${issued.body.keyId}/revoke`).set(auth());
    expect(revoked.body.revokedAt).not.toBeNull();
  });

  it('records an audit trail for orders and safety events', async () => {
    const created = await createOrder(ctx, [{ liquidId: ctx.liquidIds[0], volumeMl: 5 }]);
    await confirm(ctx, created);
    await waitForTerminal(ctx, created.order.id);
    const events = await ctx.http.get(`/api/admin/events?orderId=${created.order.id}&limit=100`).set(auth());
    const types = events.body.map((e: { type: string }) => e.type);
    expect(types).toEqual(expect.arrayContaining(['ORDER_CREATED', 'ORDER_AUTHORIZED', 'COMMAND_DISPENSE', 'ORDER_COMPLETED']));
  });

  it('exposes simulator controls only to authenticated operators in mock mode', async () => {
    const res = await ctx.http.put(`/api/admin/mock/${ctx.machineId}/config`).set(auth()).send({ failChannel: 3 });
    expect(res.status).toBe(200);
    expect(res.body.config.failChannel).toBe(3);
    const invalid = await ctx.http.put(`/api/admin/mock/${ctx.machineId}/config`).set(auth()).send({ failChannel: 99 });
    expect(invalid.status).toBe(400);
  });
});

describe('Health', () => {
  it('reports db and hardware mode', async () => {
    const ctx = await createCtx();
    try {
      const res = await ctx.http.get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok', db: true, hardwareMode: 'mock' });
      expect(res.headers['x-request-id']).toBeDefined();
    } finally {
      await ctx.close();
    }
  });
});
