import type {
  HardwareConnection,
  HardwareMode,
  MachineAvailability,
  MachineServiceStatus,
  OrderItemStatus,
  OrderStatus,
  VerificationLevel,
} from '@pegpal/shared';

export type Tone = 'green' | 'amber' | 'red' | 'grey' | 'blue';

export const AVAILABILITY_LABEL: Record<MachineAvailability, { label: string; tone: Tone }> = {
  AVAILABLE: { label: 'Available', tone: 'green' },
  BUSY: { label: 'Busy', tone: 'amber' },
  OFFLINE: { label: 'Offline', tone: 'grey' },
  OUT_OF_SERVICE: { label: 'Out of Service', tone: 'red' },
};

export const ORDER_STATUS_LABEL: Record<OrderStatus, { label: string; tone: Tone }> = {
  CREATED: { label: 'Awaiting confirmation', tone: 'blue' },
  AUTHORIZED: { label: 'Confirmed', tone: 'blue' },
  QUEUED: { label: 'Starting soon', tone: 'blue' },
  DISPENSING: { label: 'Dispensing', tone: 'amber' },
  COMPLETED: { label: 'Completed', tone: 'green' },
  FAILED: { label: 'Failed', tone: 'red' },
  CANCELLED: { label: 'Cancelled', tone: 'grey' },
  SAFETY_STOPPED: { label: 'Safety stop', tone: 'red' },
};

export const ITEM_STATUS_LABEL: Record<OrderItemStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Waiting', tone: 'grey' },
  DISPENSING: { label: 'Pouring now', tone: 'amber' },
  COMPLETED: { label: 'Done', tone: 'green' },
  FAILED: { label: 'Failed', tone: 'red' },
  STOPPED: { label: 'Stopped part-way', tone: 'red' },
  SKIPPED: { label: 'Not poured', tone: 'grey' },
  UNKNOWN: { label: 'Outcome unknown', tone: 'red' },
};

export function verificationLabel(level: VerificationLevel | null): string {
  switch (level) {
    case 'SIMULATED':
      return 'Simulated (no real measurement)';
    case 'ESTIMATED':
      return 'Estimated from pump timing';
    case 'MASS_DELTA':
      return 'Measured by weight change';
    case 'UNVERIFIED':
      return 'Not verified';
    default:
      return 'Not verified yet';
  }
}

export const SERVICE_STATUS_LABEL: Record<MachineServiceStatus, { label: string; tone: Tone }> = {
  IN_SERVICE: { label: 'In service', tone: 'green' },
  OUT_OF_SERVICE: { label: 'Out of service', tone: 'grey' },
  NEEDS_ATTENTION: { label: 'Needs attention', tone: 'red' },
};

export const CONNECTION_LABEL: Record<HardwareConnection, { label: string; tone: Tone }> = {
  CONNECTED: { label: 'Connected', tone: 'green' },
  DISCONNECTED: { label: 'Disconnected', tone: 'red' },
  UNKNOWN: { label: 'Unknown', tone: 'grey' },
};

export function hardwareModeLabel(mode: HardwareMode): { label: string; tone: Tone } {
  return mode === 'mock' ? { label: 'MOCK hardware (simulated)', tone: 'amber' } : { label: 'PHYSICAL hardware', tone: 'red' };
}

/** Final message for a terminal order. Null while still active. */
export function finalMessage(status: OrderStatus): { title: string; body: string; tone: Tone } | null {
  switch (status) {
    case 'COMPLETED':
      return { title: 'Your drink is ready', body: 'Please take your glass. Enjoy!', tone: 'green' };
    case 'CANCELLED':
      return { title: 'Order cancelled', body: 'The pumps have stopped. Nothing more will be dispensed.', tone: 'grey' };
    case 'FAILED':
      return { title: 'Something went wrong', body: 'Dispensing did not finish. Please contact staff.', tone: 'red' };
    case 'SAFETY_STOPPED':
      return { title: 'Safety stop', body: 'The machine stopped for safety. Please contact staff.', tone: 'red' };
    default:
      return null;
  }
}
