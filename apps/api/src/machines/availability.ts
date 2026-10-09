import type { MachineAvailability } from '@pegpal/shared';
import type { Machine } from '@prisma/client';

type AvailabilityInput = Pick<
  Machine,
  'status' | 'estopActive' | 'hardwareConnection' | 'activeOrderId' | 'activeCalibrationRunId'
>;

/** Customer-facing availability. Order of checks = order of severity. */
export function machineAvailability(m: AvailabilityInput): MachineAvailability {
  if (m.status !== 'IN_SERVICE' || m.estopActive) return 'OUT_OF_SERVICE';
  if (m.hardwareConnection !== 'CONNECTED') return 'OFFLINE';
  if (m.activeOrderId || m.activeCalibrationRunId) return 'BUSY';
  return 'AVAILABLE';
}

export function unavailableReason(m: AvailabilityInput): string | null {
  if (m.status === 'OUT_OF_SERVICE') return 'out of service';
  if (m.status === 'NEEDS_ATTENTION') return 'awaiting operator inspection';
  if (m.estopActive) return 'emergency stop active';
  if (m.hardwareConnection !== 'CONNECTED') return 'controller offline';
  if (m.activeOrderId || m.activeCalibrationRunId) return 'busy';
  return null;
}
