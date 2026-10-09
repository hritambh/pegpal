import { machineAvailability } from './availability';

const ok = {
  status: 'IN_SERVICE' as const,
  estopActive: false,
  hardwareConnection: 'CONNECTED' as const,
  activeOrderId: null,
  activeCalibrationRunId: null,
};

describe('machineAvailability', () => {
  it.each([
    [{}, 'AVAILABLE'],
    [{ activeOrderId: 'x' }, 'BUSY'],
    [{ activeCalibrationRunId: 'x' }, 'BUSY'],
    [{ hardwareConnection: 'DISCONNECTED' as const }, 'OFFLINE'],
    [{ hardwareConnection: 'UNKNOWN' as const }, 'OFFLINE'],
    [{ status: 'OUT_OF_SERVICE' as const }, 'OUT_OF_SERVICE'],
    [{ status: 'NEEDS_ATTENTION' as const }, 'OUT_OF_SERVICE'],
    [{ estopActive: true, activeOrderId: 'x' }, 'OUT_OF_SERVICE'],
  ])('%p -> %s', (patch, expected) => {
    expect(machineAvailability({ ...ok, ...patch })).toBe(expected);
  });
});
