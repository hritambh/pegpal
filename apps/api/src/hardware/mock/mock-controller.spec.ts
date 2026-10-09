import type { ControllerEvent, DispenseCommand, HardwareEvent } from '@pegpal/shared';
import { MockController } from './mock-controller';

function setup() {
  const events: HardwareEvent[] = [];
  const c = new MockController({ machineId: 'M1', timeScale: 50, tickMs: 5, fwMaxRuntimeMs: 20_000, emit: (e) => events.push(e) });
  return { c, events };
}

let seq = 0;
function dispense(over: Partial<DispenseCommand> = {}): DispenseCommand {
  return {
    v: 1,
    type: 'DISPENSE',
    commandId: `cmd-${++seq}`,
    machineId: 'M1',
    seq,
    issuedAt: Date.now(),
    orderId: 'o1',
    purpose: 'ORDER',
    channel: 0,
    strategy: 'TIMED',
    targetMl: 10,
    runtimeMs: 5000,
    targetMassG: null,
    cutoffMarginG: null,
    maxDurationMs: 9000,
    ...over,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const of = (events: HardwareEvent[], type: string) => events.filter((e) => e.type === type) as ControllerEvent[];

describe('MockController', () => {
  afterEach(() => jest.useRealTimers());

  it('acknowledges, reports progress and completes a timed dispense with simulated data', async () => {
    const { c, events } = setup();
    c.handle(dispense());
    await sleep(250);
    c.stopAll();
    const done = of(events, 'DONE')[0];
    expect(of(events, 'ACK')[0]).toMatchObject({ accepted: true });
    expect(of(events, 'PROGRESS').length).toBeGreaterThan(3);
    expect(done).toMatchObject({ type: 'DONE', simulated: true });
  });

  it('never runs a duplicate commandId twice and replays the final outcome', async () => {
    const { c, events } = setup();
    const cmd = dispense({ runtimeMs: 500 });
    c.handle(cmd);
    await sleep(100);
    c.handle(cmd);
    await sleep(50);
    expect(of(events, 'DONE')).toHaveLength(2); // original + replay
    expect(of(events, 'ACK').filter((a) => a.type === 'ACK' && a.duplicate)).toHaveLength(1);
    expect(c.view().activeCommandId).toBeNull();
  });

  it('rejects stale sequence numbers', async () => {
    const { c, events } = setup();
    c.handle(dispense({ runtimeMs: 200 }));
    await sleep(60);
    const stale = dispense();
    stale.seq = 1;
    c.handle(stale);
    await flush();
    expect(of(events, 'ACK').at(-1)).toMatchObject({ accepted: false, reason: 'STALE_SEQUENCE' });
  });

  it.each([
    [{ channel: 12 }, 'INVALID_COMMAND'],
    [{ maxDurationMs: 999_999 }, 'LIMIT_EXCEEDED'],
    [{ runtimeMs: 10_000, maxDurationMs: 5000 }, 'INVALID_COMMAND'],
    [{ strategy: 'WEIGHT' as const, runtimeMs: null, targetMassG: 20, cutoffMarginG: 1 }, 'SCALE_FAULT'], // not tared
  ])('validates commands independently: %p', async (over, reason) => {
    const { c, events } = setup();
    c.handle(dispense(over));
    await flush();
    expect(of(events, 'ACK')[0]).toMatchObject({ accepted: false, reason });
  });

  it('refuses a second dispense while busy', async () => {
    const { c, events } = setup();
    c.handle(dispense());
    c.handle(dispense());
    await flush();
    c.stopAll();
    expect(of(events, 'ACK')[1]).toMatchObject({ accepted: false, reason: 'BUSY' });
  });

  it('e-stop interrupts the pump and blocks new commands until released', async () => {
    const { c, events } = setup();
    const cmd = dispense();
    c.handle(cmd);
    await sleep(20);
    c.setEstop(true);
    await flush();
    expect(of(events, 'ESTOP')[0]).toMatchObject({ active: true, interruptedCommandId: cmd.commandId });
    c.handle(dispense());
    await flush();
    expect(of(events, 'ACK').at(-1)).toMatchObject({ accepted: false, reason: 'ESTOP' });
  });

  it('STOP is always honoured and confirms all pumps off', async () => {
    const { c, events } = setup();
    const cmd = dispense();
    c.handle(cmd);
    await sleep(20);
    c.handle({ v: 1, type: 'STOP', commandId: 'stop-1', machineId: 'M1', seq: 1, issuedAt: Date.now(), orderId: null, reason: 't' });
    await flush();
    expect(of(events, 'STOPPED')[0]).toMatchObject({ interruptedCommandId: cmd.commandId, allPumpsOff: true });
  });

  it('stops locally on link loss and reports the outcome after reconnect', async () => {
    const { c, events } = setup();
    c.configure({ disconnectAtFraction: 0.3 });
    const cmd = dispense();
    c.handle(cmd);
    await sleep(150);
    expect(c.view().activeCommandId).toBeNull();
    expect(events.some((e) => e.type === 'CONNECTION' && !e.connected)).toBe(true);
    c.setConnected(true);
    await flush();
    await flush();
    expect(of(events, 'FAILED')[0]).toMatchObject({ commandId: cmd.commandId, code: 'CONNECTION_LOST' });
    expect(of(events, 'STATUS').at(-1)).toMatchObject({ anyPumpOn: false, lastCommandOutcome: 'FAILED' });
  });

  it('reports scale faults on tare', async () => {
    const { c, events } = setup();
    c.configure({ scaleUnstable: true });
    c.handle({ v: 1, type: 'TARE', commandId: 't1', machineId: 'M1', seq: 1, issuedAt: Date.now(), orderId: 'o1' });
    await flush();
    await flush();
    expect(of(events, 'TARE_DONE')[0]).toMatchObject({ ok: false, stable: false, reason: 'SCALE_UNSTABLE' });
  });

  it('ignores commands for other machines', async () => {
    const { c, events } = setup();
    c.handle(dispense({ machineId: 'OTHER' }));
    await flush();
    expect(events).toHaveLength(0);
  });
});
