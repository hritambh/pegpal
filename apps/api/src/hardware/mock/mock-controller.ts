import type {
  ControllerCommand,
  ControllerEvent,
  DispenseCommand,
  FailureCode,
  HardwareEvent,
  MockFaultConfig,
  MockStateView,
  StatusEvent,
} from '@pegpal/shared';
import { PUMP_CHANNEL_COUNT, PROTOCOL_VERSION } from '@pegpal/shared';
import { randomUUID } from 'node:crypto';

/** Simulated "true" flow per channel (mL/s). Differs per channel like real liquids would. */
export const DEFAULT_MOCK_FLOW_RATES = [2.0, 2.2, 1.8, 2.5, 1.5, 3.0, 2.0, 1.2, 2.8, 2.4];
/** Simulated liquid keeps flowing briefly after the pump stops. */
const RUN_ON_SEC = 0.25;
const PROGRESS_INTERVAL_SIM_MS = 250;
const RECENT_COMMANDS = 16;
const SIMULATED_GLASS_MASS_G = 250;

export const DEFAULT_MOCK_FAULTS: MockFaultConfig = {
  flowRateMultiplier: 1,
  channelFlowMultipliers: {},
  failChannel: null,
  dropAcks: false,
  dropCompletion: false,
  disconnectAtFraction: null,
  estopAtFraction: null,
  scaleUnstable: false,
  scaleMissing: false,
};

export interface MockControllerOptions {
  machineId: string;
  timeScale: number;
  tickMs: number;
  fwMaxRuntimeMs: number;
  flowRates?: number[];
  emit: (event: HardwareEvent) => void;
}

interface ActiveRun {
  cmd: DispenseCommand;
  elapsedSimMs: number;
  deliveredMl: number;
  trueFlowMlPerSec: number;
  nextProgressAt: number;
  timer: NodeJS.Timeout;
  faultsFired: Set<string>;
}

/**
 * In-process stand-in for the ESP32 firmware. It mirrors the firmware's
 * validation, idempotency and safe-stop rules so the backend is exercised the
 * same way, but every figure it reports is simulated and flagged as such.
 */
export class MockController {
  connected = true;
  estopActive = false;
  config: MockFaultConfig = { ...DEFAULT_MOCK_FAULTS, channelFlowMultipliers: {} };

  private lastSeq = 0;
  private deviceSeq = 0;
  private readonly bootAt = Date.now();
  private bootedRecently = true;
  private active: ActiveRun | null = null;
  private readonly recent = new Map<string, { ack?: ControllerEvent; final?: ControllerEvent }>();
  private lastCommandId: string | null = null;
  private lastOutcome: StatusEvent['lastCommandOutcome'] = 'NONE';
  private tare: { orderId: string | null; at: number } | null = null;
  private readonly undelivered: ControllerEvent[] = [];
  private readonly flowRates: number[];

  constructor(private readonly opts: MockControllerOptions) {
    this.flowRates = opts.flowRates ?? DEFAULT_MOCK_FLOW_RATES;
  }

  view(): MockStateView {
    return {
      machineId: this.opts.machineId,
      connected: this.connected,
      estopActive: this.estopActive,
      activeCommandId: this.active?.cmd.commandId ?? null,
      config: { ...this.config, channelFlowMultipliers: { ...this.config.channelFlowMultipliers } },
    };
  }

  /** What the simulator would deliver on a channel for a given runtime. */
  simulatedVolume(channel: number, runtimeMs: number): number {
    return (runtimeMs / 1000) * this.trueFlow(channel);
  }

  configure(patch: Partial<MockFaultConfig>): void {
    this.config = {
      ...this.config,
      ...patch,
      channelFlowMultipliers: { ...this.config.channelFlowMultipliers, ...(patch.channelFlowMultipliers ?? {}) },
    };
  }

  start(): void {
    this.emitRaw({ type: 'CONNECTION', machineId: this.opts.machineId, connected: true });
    this.emit(this.status());
  }

  stopAll(): void {
    if (this.active) clearInterval(this.active.timer);
    this.active = null;
  }

  // ------------------------------------------------------------- physical sim

  setConnected(connected: boolean): void {
    if (connected === this.connected) return;
    this.connected = connected;
    if (!connected) {
      // Firmware safe-stop policy: link loss stops the pump locally.
      if (this.active) this.finishActive('FAILED', { code: 'CONNECTION_LOST', message: 'Link lost; pump stopped locally' });
      this.emitRaw({ type: 'CONNECTION', machineId: this.opts.machineId, connected: false, reason: 'simulated' });
      return;
    }
    this.emitRaw({ type: 'CONNECTION', machineId: this.opts.machineId, connected: true });
    for (const e of this.undelivered.splice(0)) this.emit(e);
    this.emit(this.status());
  }

  /** Simulates the physical mushroom button. No protocol message can do this. */
  setEstop(active: boolean): void {
    if (active === this.estopActive) return;
    this.estopActive = active;
    const interrupted = active && this.active ? this.active.cmd.commandId : null;
    if (active && this.active) this.finishActive('ESTOP');
    this.emit({ ...this.base(), type: 'ESTOP', active, interruptedCommandId: interrupted });
  }

  // ------------------------------------------------------------- protocol

  handle(cmd: ControllerCommand): void {
    if (!this.connected) return; // lost on the wire
    if (cmd.machineId !== this.opts.machineId || cmd.v !== PROTOCOL_VERSION) return;

    if (cmd.type === 'STOP') {
      // Always honoured, regardless of sequence or state.
      const interrupted = this.active?.cmd.commandId ?? null;
      const { runtimeMs, massDeltaG } = this.active ? this.finishActive('STOPPED') : { runtimeMs: null, massDeltaG: null };
      this.lastSeq = Math.max(this.lastSeq, cmd.seq);
      this.ack(cmd.commandId, true);
      this.emit({
        ...this.base(),
        type: 'STOPPED',
        commandId: cmd.commandId,
        interruptedCommandId: interrupted,
        runtimeMs,
        massDeltaG,
        allPumpsOff: true,
      });
      return;
    }

    const known = this.recent.get(cmd.commandId);
    if (known) {
      this.ack(cmd.commandId, true, undefined, true);
      if (known.final) this.emit({ ...known.final, eventId: randomUUID(), deviceSeq: ++this.deviceSeq });
      return;
    }
    if (cmd.seq <= this.lastSeq) {
      this.ack(cmd.commandId, false, 'STALE_SEQUENCE');
      return;
    }
    this.lastSeq = cmd.seq;
    this.remember(cmd.commandId);

    switch (cmd.type) {
      case 'STATUS_REQUEST':
        this.ack(cmd.commandId, true);
        this.emit(this.status());
        return;
      case 'TARE':
        return this.handleTare(cmd.commandId, cmd.orderId);
      case 'DISPENSE':
        return this.handleDispense(cmd);
    }
  }

  private handleTare(commandId: string, orderId: string | null): void {
    this.ack(commandId, true);
    let event: ControllerEvent;
    if (this.config.scaleMissing) {
      event = { ...this.base(), type: 'TARE_DONE', commandId, ok: false, stable: false, platformMassG: null, reason: 'SCALE_FAULT' };
    } else if (this.config.scaleUnstable) {
      event = { ...this.base(), type: 'TARE_DONE', commandId, ok: false, stable: false, platformMassG: null, reason: 'SCALE_UNSTABLE' };
    } else {
      this.tare = { orderId, at: Date.now() };
      event = { ...this.base(), type: 'TARE_DONE', commandId, ok: true, stable: true, platformMassG: SIMULATED_GLASS_MASS_G };
    }
    this.later(() => this.finalEvent(commandId, event));
  }

  private validate(cmd: DispenseCommand): FailureCode | null {
    if (!Number.isInteger(cmd.channel) || cmd.channel < 0 || cmd.channel >= PUMP_CHANNEL_COUNT) return 'INVALID_COMMAND';
    if (this.estopActive) return 'ESTOP';
    if (this.active) return 'BUSY';
    if (!(cmd.maxDurationMs > 0) || cmd.maxDurationMs > this.opts.fwMaxRuntimeMs) return 'LIMIT_EXCEEDED';
    if (cmd.strategy === 'TIMED' && !(cmd.runtimeMs && cmd.runtimeMs > 0 && cmd.runtimeMs <= cmd.maxDurationMs))
      return 'INVALID_COMMAND';
    if (cmd.strategy === 'WEIGHT') {
      if (this.config.scaleMissing) return 'SCALE_FAULT';
      if (!cmd.targetMassG || cmd.targetMassG <= (cmd.cutoffMarginG ?? 0)) return 'INVALID_COMMAND';
      if (!this.tare || this.tare.orderId !== cmd.orderId) return 'SCALE_FAULT';
    }
    return null;
  }

  private handleDispense(cmd: DispenseCommand): void {
    const reason = this.validate(cmd);
    if (reason) {
      this.ack(cmd.commandId, false, reason);
      return;
    }
    this.ack(cmd.commandId, true);
    this.lastCommandId = cmd.commandId;
    this.lastOutcome = 'UNKNOWN';
    const run: ActiveRun = {
      cmd,
      elapsedSimMs: 0,
      deliveredMl: 0,
      trueFlowMlPerSec: this.trueFlow(cmd.channel),
      nextProgressAt: PROGRESS_INTERVAL_SIM_MS,
      faultsFired: new Set(),
      timer: setInterval(() => this.tick(), this.opts.tickMs),
    };
    this.active = run;
  }

  private tick(): void {
    const run = this.active;
    if (!run) return;
    const { cmd } = run;
    const dt = this.opts.tickMs * this.opts.timeScale;
    run.elapsedSimMs += dt;
    run.deliveredMl += (run.trueFlowMlPerSec * dt) / 1000;

    const goal =
      cmd.strategy === 'TIMED' ? (cmd.runtimeMs ?? 0) : (cmd.targetMassG ?? 0) - (cmd.cutoffMarginG ?? 0);
    const progress = cmd.strategy === 'TIMED' ? run.elapsedSimMs : run.deliveredMl; // simulated density 1 g/mL
    const fraction = goal > 0 ? progress / goal : 1;

    if (this.config.failChannel === cmd.channel && fraction >= 0.5) {
      this.finishActive('FAILED', { code: 'PUMP_FAULT', message: 'Simulated pump fault' });
      return;
    }
    if (this.config.disconnectAtFraction !== null && fraction >= this.config.disconnectAtFraction && !run.faultsFired.has('disc')) {
      run.faultsFired.add('disc');
      this.setConnected(false);
      return;
    }
    if (this.config.estopAtFraction !== null && fraction >= this.config.estopAtFraction && !run.faultsFired.has('estop')) {
      run.faultsFired.add('estop');
      this.setEstop(true);
      return;
    }
    if (fraction >= 1) {
      this.finishActive('DONE');
      return;
    }
    if (run.elapsedSimMs >= Math.min(cmd.maxDurationMs, this.opts.fwMaxRuntimeMs)) {
      this.finishActive('FAILED', { code: 'MAX_DURATION_EXCEEDED', message: 'Pump runtime limit reached' });
      return;
    }
    if (run.elapsedSimMs >= run.nextProgressAt) {
      run.nextProgressAt += PROGRESS_INTERVAL_SIM_MS;
      const plannedFlow = cmd.runtimeMs ? cmd.targetMl / cmd.runtimeMs : null; // mL per ms from calibration
      this.emit({
        ...this.base(),
        type: 'PROGRESS',
        commandId: cmd.commandId,
        elapsedMs: Math.round(run.elapsedSimMs),
        estimatedMl: plannedFlow !== null ? round(plannedFlow * run.elapsedSimMs) : null,
        massG: cmd.strategy === 'WEIGHT' || cmd.runtimeMs === null ? round(run.deliveredMl) : null,
      });
    }
  }

  private finishActive(
    outcome: 'DONE' | 'FAILED' | 'STOPPED' | 'ESTOP',
    failure?: { code: FailureCode; message: string },
  ): { runtimeMs: number; massDeltaG: number } {
    const run = this.active!;
    clearInterval(run.timer);
    this.active = null;
    run.deliveredMl += run.trueFlowMlPerSec * RUN_ON_SEC;
    const runtimeMs = Math.round(run.elapsedSimMs);
    const massDeltaG = round(run.deliveredMl);
    const { commandId } = run.cmd;

    let final: ControllerEvent;
    if (outcome === 'DONE') {
      this.lastOutcome = 'DONE';
      final = { ...this.base(), type: 'DONE', commandId, runtimeMs, massDeltaG, massStable: true };
      if (this.config.dropCompletion) {
        this.recent.set(commandId, { ...this.recent.get(commandId), final });
        return { runtimeMs, massDeltaG };
      }
    } else if (outcome === 'FAILED' || outcome === 'ESTOP') {
      this.lastOutcome = 'FAILED';
      const f = failure ?? { code: 'ESTOP' as const, message: 'Emergency stop pressed' };
      final = { ...this.base(), type: 'FAILED', commandId, code: f.code, message: f.message, runtimeMs, massDeltaG };
      if (outcome === 'ESTOP') {
        // The ESTOP event itself tells the backend; keep the outcome for duplicate replay only.
        this.recent.set(commandId, { ...this.recent.get(commandId), final });
        return { runtimeMs, massDeltaG };
      }
    } else {
      this.lastOutcome = 'STOPPED';
      this.recent.set(commandId, {
        ...this.recent.get(commandId),
        final: { ...this.base(), type: 'FAILED', commandId, code: 'INVALID_COMMAND', message: 'Stopped by STOP command', runtimeMs, massDeltaG },
      });
      return { runtimeMs, massDeltaG };
    }
    this.finalEvent(commandId, final);
    return { runtimeMs, massDeltaG };
  }

  private finalEvent(commandId: string, event: ControllerEvent): void {
    this.recent.set(commandId, { ...this.recent.get(commandId), final: event });
    if (this.connected) this.emit(event);
    else this.undelivered.push(event);
  }

  private trueFlow(channel: number): number {
    const base = this.flowRates[channel] ?? 2;
    const perChannel = this.config.channelFlowMultipliers[String(channel)];
    return base * this.config.flowRateMultiplier * (perChannel ?? 1);
  }

  private status(): StatusEvent {
    const s: StatusEvent = {
      ...this.base(),
      type: 'STATUS',
      firmwareVersion: 'mock-1.0.0',
      estopActive: this.estopActive,
      anyPumpOn: this.active !== null,
      activeCommandId: this.active?.cmd.commandId ?? null,
      lastCommandId: this.lastCommandId,
      lastCommandOutcome: this.lastOutcome,
      scaleOk: !this.config.scaleMissing,
      bootedRecently: this.bootedRecently,
    };
    this.bootedRecently = false;
    return s;
  }

  private ack(commandId: string, accepted: boolean, reason?: string, duplicate?: boolean): void {
    if (this.config.dropAcks) return; // simulated broken uplink: commands still execute
    const event: ControllerEvent = {
      ...this.base(),
      type: 'ACK',
      commandId,
      accepted,
      ...(reason ? { reason } : {}),
      ...(duplicate ? { duplicate } : {}),
    };
    this.emit(event);
  }

  private remember(commandId: string): void {
    this.recent.set(commandId, {});
    while (this.recent.size > RECENT_COMMANDS) this.recent.delete(this.recent.keys().next().value!);
  }

  private base() {
    return {
      v: PROTOCOL_VERSION,
      eventId: randomUUID(),
      machineId: this.opts.machineId,
      deviceSeq: ++this.deviceSeq,
      uptimeMs: Date.now() - this.bootAt,
      simulated: true,
    } as const;
  }

  private emit(event: ControllerEvent): void {
    if (!this.connected) return;
    this.later(() => this.opts.emit(event));
  }

  private emitRaw(event: HardwareEvent): void {
    this.later(() => this.opts.emit(event));
  }

  private later(fn: () => void): void {
    setImmediate(fn);
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
