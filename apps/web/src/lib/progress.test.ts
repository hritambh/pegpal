import type { OrderItemView, OrderView } from '@pegpal/shared';
import { applyStreamMessage, clampPercent, groupItems, itemProgressPercent, orderProgressPercent, parseStreamMessage } from './progress';

const item = (id: string, position: number, over: Partial<OrderItemView> = {}): OrderItemView => ({
  id,
  position,
  liquidId: `l-${id}`,
  liquidName: id,
  pumpChannel: position,
  requestedMl: 50,
  unitPrice: '0.05',
  linePrice: '2.50',
  targetMassG: null,
  status: 'PENDING',
  progressMl: null,
  deliveredMl: null,
  measuredMassG: null,
  verification: null,
  verificationNote: null,
  startedAt: null,
  completedAt: null,
  ...over,
});

const order = (items: OrderItemView[], over: Partial<OrderView> = {}): OrderView => ({
  id: 'o1',
  machineId: 'M1',
  machineName: 'Bar',
  status: 'DISPENSING',
  totalVolumeMl: 100,
  totalPrice: '5.00',
  currency: 'EUR',
  payment: { mode: 'TEST_MODE', status: 'TEST_CONFIRMED', isTest: true },
  cancelRequested: false,
  failureReason: null,
  expiresAt: null,
  items,
  createdAt: '',
  updatedAt: '',
  ...over,
});

describe('progress percent', () => {
  it('clamps', () => {
    expect(clampPercent(-3)).toBe(0);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(NaN)).toBe(0);
  });
  it('computes item and order progress', () => {
    expect(itemProgressPercent(item('a', 0, { status: 'DISPENSING', progressMl: 25 }))).toBe(50);
    expect(itemProgressPercent(item('a', 0, { status: 'DISPENSING', progressMl: 80 }))).toBe(100);
    const o = order([item('a', 0, { status: 'COMPLETED', deliveredMl: 50 }), item('b', 1, { status: 'DISPENSING', progressMl: 25 })]);
    expect(orderProgressPercent(o)).toBe(75);
  });
});

describe('groupItems', () => {
  it('only counts COMPLETED items as done', () => {
    const g = groupItems([
      item('b', 1, { status: 'DISPENSING' }),
      item('a', 0, { status: 'COMPLETED' }),
      item('c', 2, { status: 'PENDING' }),
      item('d', 3, { status: 'UNKNOWN' }),
    ]);
    expect(g.current?.id).toBe('b');
    expect(g.completed.map((i) => i.id)).toEqual(['a']);
    expect(g.remaining.map((i) => i.id)).toEqual(['c']);
    expect(g.other.map((i) => i.id)).toEqual(['d']);
  });
});

describe('stream messages', () => {
  it('parses typed and named events', () => {
    expect(parseStreamMessage(JSON.stringify({ type: 'snapshot', order: order([]) }))?.type).toBe('snapshot');
    expect(parseStreamMessage(JSON.stringify({ orderId: 'o1', itemId: 'a', progressMl: 3 }), 'progress')).toMatchObject({ type: 'progress', progressMl: 3 });
    expect(parseStreamMessage('not json')).toBeNull();
    expect(parseStreamMessage(JSON.stringify({ type: 'other' }))).toBeNull();
  });
  it('applies progress only to dispensing items and never changes status', () => {
    const o = order([item('a', 0, { status: 'DISPENSING' }), item('b', 1)]);
    const next = applyStreamMessage(o, { type: 'progress', orderId: 'o1', itemId: 'a', progressMl: 20, massG: null, simulated: true })!;
    expect(next.items[0].progressMl).toBe(20);
    expect(next.items[0].status).toBe('DISPENSING');
    const ignored = applyStreamMessage(o, { type: 'progress', orderId: 'o1', itemId: 'b', progressMl: 20, massG: null, simulated: true });
    expect(ignored).toBe(o);
  });
  it('ignores progress for terminal orders', () => {
    const o = order([item('a', 0, { status: 'DISPENSING' })], { status: 'FAILED' });
    expect(applyStreamMessage(o, { type: 'progress', orderId: 'o1', itemId: 'a', progressMl: 20, massG: null, simulated: true })).toBe(o);
  });
  it('snapshot replaces the order but keeps live progress for a running item', () => {
    const o = order([item('a', 0, { status: 'DISPENSING', progressMl: 30 })]);
    const snap = order([item('a', 0, { status: 'DISPENSING', progressMl: null })]);
    expect(applyStreamMessage(o, { type: 'snapshot', order: snap })!.items[0].progressMl).toBe(30);
    const done = order([item('a', 0, { status: 'COMPLETED', deliveredMl: 50 })], { status: 'COMPLETED' });
    expect(applyStreamMessage(o, { type: 'snapshot', order: done })!.status).toBe('COMPLETED');
  });
});
