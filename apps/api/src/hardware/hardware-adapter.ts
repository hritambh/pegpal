import type { ControllerCommand, HardwareEvent, HardwareMode } from '@pegpal/shared';

export const HARDWARE_ADAPTER = Symbol('HARDWARE_ADAPTER');

/**
 * Transport to machine controllers. Adapters only move messages; all
 * sequencing, persistence and safety decisions live in ControllerService and
 * DispensingService so mock and real hardware are driven identically.
 */
export interface HardwareAdapter {
  readonly mode: HardwareMode;
  /** Simulated seconds per real second (mock speed-up); 1 for real hardware. Waits are divided by it. */
  readonly timeScale: number;
  /** Start tracking a machine (subscribe / start simulator). Idempotent. */
  register(machineId: string): Promise<void>;
  /** Fire-and-forget delivery. Must be safe to call again with the same command. */
  send(command: ControllerCommand): Promise<void>;
  isConnected(machineId: string): boolean;
  /** Every event from every registered machine. */
  onEvent(listener: (event: HardwareEvent) => void): () => void;
  shutdown(): Promise<void>;
}
