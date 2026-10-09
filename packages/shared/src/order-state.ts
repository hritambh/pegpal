/**
 * Order lifecycle. See docs/state-machine.md for the diagram and rationale.
 *
 * Terminal states are never left. CANCELLED is only reached once the
 * controller has confirmed that no pump is running (or no command was ever
 * sent for the order).
 */
export const ORDER_STATUSES = [
  'CREATED',
  'AUTHORIZED',
  'QUEUED',
  'DISPENSING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'SAFETY_STOPPED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  CREATED: ['AUTHORIZED', 'CANCELLED'],
  AUTHORIZED: ['QUEUED', 'CANCELLED', 'FAILED'],
  QUEUED: ['DISPENSING', 'CANCELLED', 'FAILED', 'SAFETY_STOPPED'],
  DISPENSING: ['COMPLETED', 'CANCELLED', 'FAILED', 'SAFETY_STOPPED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  SAFETY_STOPPED: [],
};

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'SAFETY_STOPPED'];

/** Statuses that hold the machine reservation. */
export const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = ['CREATED', 'AUTHORIZED', 'QUEUED', 'DISPENSING'];

export function isTerminalStatus(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/** Every status that may legally transition into `to`. */
export function allowedSourcesFor(to: OrderStatus): OrderStatus[] {
  return ORDER_STATUSES.filter((from) => canTransition(from, to));
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`Invalid order transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export const ORDER_ITEM_STATUSES = [
  'PENDING',
  'DISPENSING',
  'COMPLETED',
  'FAILED',
  /** Pump was stopped part-way (cancel or e-stop). */
  'STOPPED',
  /** Never started because the order ended earlier. */
  'SKIPPED',
  /** Command outcome could not be determined (timeout, disconnect, restart). */
  'UNKNOWN',
] as const;

export type OrderItemStatus = (typeof ORDER_ITEM_STATUSES)[number];

/**
 * How much confidence we have in the delivered quantity of an item.
 *
 * - MASS_DELTA: inferred from the change in total glass mass between two stable
 *   load-cell readings, converted with the configured density. Not an
 *   independent volume measurement.
 * - ESTIMATED: derived from pump runtime and the calibrated flow rate.
 * - SIMULATED: produced by the mock controller; no physical measurement.
 * - UNVERIFIED: no trustworthy evidence of the delivered amount.
 */
export const VERIFICATION_LEVELS = ['MASS_DELTA', 'ESTIMATED', 'SIMULATED', 'UNVERIFIED'] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];
