import { Injectable, Logger } from '@nestjs/common';
import type { ControllerCommand, HardwareEvent, MockFaultConfig, MockStateView } from '@pegpal/shared';
import type { HardwareAdapter } from '../hardware-adapter';
import { MockController } from './mock-controller';

export interface MockAdapterOptions {
  timeScale: number;
  tickMs: number;
  fwMaxRuntimeMs: number;
}

/** Runs one simulated controller per registered machine, entirely in-process. */
@Injectable()
export class MockHardwareAdapter implements HardwareAdapter {
  readonly mode = 'mock' as const;
  private readonly logger = new Logger('MockHardware');
  private readonly controllers = new Map<string, MockController>();
  private readonly listeners = new Set<(e: HardwareEvent) => void>();

  constructor(private readonly opts: MockAdapterOptions) {}

  get timeScale(): number {
    return this.opts.timeScale;
  }

  async register(machineId: string): Promise<void> {
    if (this.controllers.has(machineId)) return;
    const controller = new MockController({
      machineId,
      timeScale: this.opts.timeScale,
      tickMs: this.opts.tickMs,
      fwMaxRuntimeMs: this.opts.fwMaxRuntimeMs,
      emit: (e) => this.dispatch(e),
    });
    this.controllers.set(machineId, controller);
    controller.start();
    this.logger.log({ msg: 'Simulated controller started', machineId });
  }

  async send(command: ControllerCommand): Promise<void> {
    this.controllers.get(command.machineId)?.handle(command);
  }

  isConnected(machineId: string): boolean {
    return this.controllers.get(machineId)?.connected ?? false;
  }

  onEvent(listener: (event: HardwareEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async shutdown(): Promise<void> {
    for (const c of this.controllers.values()) c.stopAll();
    this.controllers.clear();
  }

  // ------------------------------------------------ simulator controls (admin/tests)

  state(machineId: string): MockStateView | null {
    return this.controllers.get(machineId)?.view() ?? null;
  }

  configure(machineId: string, patch: Partial<MockFaultConfig>): MockStateView | null {
    const c = this.controllers.get(machineId);
    if (!c) return null;
    c.configure(patch);
    return c.view();
  }

  setEstop(machineId: string, active: boolean): MockStateView | null {
    const c = this.controllers.get(machineId);
    c?.setEstop(active);
    return c?.view() ?? null;
  }

  setConnected(machineId: string, connected: boolean): MockStateView | null {
    const c = this.controllers.get(machineId);
    c?.setConnected(connected);
    return c?.view() ?? null;
  }

  simulatedVolume(machineId: string, channel: number, runtimeMs: number): number | null {
    return this.controllers.get(machineId)?.simulatedVolume(channel, runtimeMs) ?? null;
  }

  private dispatch(event: HardwareEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        this.logger.error({ msg: 'Hardware event listener failed', err: String(err) });
      }
    }
  }
}
