import {
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  InvalidTransitionError,
  TERMINAL_ORDER_STATUSES,
  allowedSourcesFor,
  assertTransition,
  canTransition,
} from './order-state';

describe('order state machine', () => {
  it('follows the happy path', () => {
    const path = ['CREATED', 'AUTHORIZED', 'QUEUED', 'DISPENSING', 'COMPLETED'] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1], path[i])).toBe(true);
  });

  it('never leaves a terminal state', () => {
    for (const terminal of TERMINAL_ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) expect(canTransition(terminal, to)).toBe(false);
    }
  });

  it.each([
    ['CREATED', 'DISPENSING'],
    ['CREATED', 'COMPLETED'],
    ['AUTHORIZED', 'COMPLETED'],
    ['QUEUED', 'COMPLETED'],
    ['DISPENSING', 'QUEUED'],
    ['COMPLETED', 'CANCELLED'],
    ['CANCELLED', 'AUTHORIZED'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
  });

  it('only allows SAFETY_STOPPED once hardware may be involved', () => {
    expect(allowedSourcesFor('SAFETY_STOPPED').sort()).toEqual(['DISPENSING', 'QUEUED']);
  });

  it('has a transition entry for every status', () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual([...ORDER_STATUSES].sort());
  });
});
