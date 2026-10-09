import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { CommandOutcome, Prisma } from '@prisma/client';
import type {
  AckEvent,
  ControllerCommand,
  ControllerEvent,
  HardwareEvent,
  StatusEvent,
} from '@pegpal/shared';
import { PROTOCOL_VERSION, eventCommandId } from '@pegpal/shared';
import { randomUUID } from 'node:crypto';
import { Subject } from 'rxjs';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { HARDWARE_ADAPTER, HardwareAdapter } from './hardware-adapter';
import { ControllerDisconnectedError, EventWaiters, Wait, WaitTimeoutError } from './waiters';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type CommandSpec = DistributiveOmit<ControllerCommand, 'v' | 'commandId' | 'machineId' | 'seq' | 'issuedAt'>;

export interface MachineRef {
  id: string;
  publicId: string;
}

export interface CommandLinks {
  orderId?: string | null;
  orderItemId?: string | null;
  calibrationRunId?: string | null;
}

/** Raised when we cannot tell whether the controller executed a command. */
export class UncertainOutcomeError extends Error {
  constructor(
    readonly reason: 'ACK_TIMEOUT' | 'COMPLETION_TIMEOUT' | 'CONNECTION_LOST' | 'STOP_UNCONFIRMED',
    message: string,
  ) {
    super(message);
    this.name = 'UncertainOutcomeError';
  }
}

export class CommandRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`Controller rejected command: ${reason}`);
    this.name = 'CommandRejectedError';
  }
}

const SEEN_EVENT_LIMIT = 5000;

/**
 * Owns the conversation with controllers: persists every command before it
 * is sent, assigns sequence numbers, retransmits identical commands until
 * acknowledged, ingests and audits events, keeps machine connection / e-stop
 * state current, and reconciles after reconnects.
 */
@Injectable()
export class ControllerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Controller');
  private readonly waiters = new EventWaiters();
  private readonly seenEvents = new Set<string>();
  private readonly machineIds = new Map<string, string>(); // publicId -> id
  /** DISPENSE commands this process is legitimately waiting on. */
  private readonly inFlight = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly lastSeenWrite = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;

  /** All processed events, for progress streaming. */
  readonly events$ = new Subject<HardwareEvent>();

  constructor(
    @Inject(HARDWARE_ADAPTER) private readonly adapter: HardwareAdapter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  get mode() {
    return this.adapter.mode;
  }

  /** Converts a duration in controller time into real wall-clock time. */
  realMs(controllerMs: number): number {
    return controllerMs / this.adapter.timeScale;
  }

  async onModuleInit(): Promise<void> {
    this.unsubscribe = this.adapter.onEvent((e) => {
      this.queue = this.queue.then(() => this.process(e)).catch((err) =>
        this.logger.error({ msg: 'Event processing failed', err: String(err) }),
      );
    });
    const machines = await this.prisma.machine.findMany({ select: { id: true, publicId: true } });
    await this.prisma.machine.updateMany({ data: { hardwareConnection: 'UNKNOWN' } });
    for (const m of machines) await this.registerMachine(m);
    this.logger.log({ msg: 'Hardware adapter ready', mode: this.adapter.mode, machines: machines.length });
  }

  async onApplicationShutdown(): Promise<void> {
    this.unsubscribe?.();
    this.waiters.rejectAll(new Error('Shutting down'));
    await this.adapter.shutdown();
    await this.queue;
  }

  async registerMachine(m: MachineRef): Promise<void> {
    this.machineIds.set(m.publicId, m.id);
    await this.adapter.register(m.publicId);
  }

  isConnected(publicId: string): boolean {
    return this.adapter.isConnected(publicId);
  }

  /** Allocates a sequence number and persists the command. Nothing is sent yet. */
  async issue(machine: MachineRef, spec: CommandSpec, links: CommandLinks = {}): Promise<ControllerCommand> {
    const commandId = randomUUID();
    const command = await this.prisma.$transaction(async (tx) => {
      const { commandSeq } = await tx.machine.update({
        where: { id: machine.id },
        data: { commandSeq: { increment: 1 } },
        select: { commandSeq: true },
      });
      const cmd = {
        ...spec,
        v: PROTOCOL_VERSION,
        commandId,
        machineId: machine.publicId,
        seq: commandSeq,
        issuedAt: Date.now(),
      } as ControllerCommand;
      await tx.hardwareCommand.create({
        data: {
          id: commandId,
          machineId: machine.id,
          type: cmd.type,
          seq: commandSeq,
          payload: cmd as unknown as Prisma.InputJsonValue,
          orderId: links.orderId ?? null,
          orderItemId: links.orderItemId ?? null,
          calibrationRunId: links.calibrationRunId ?? null,
        },
      });
      return cmd;
    });
    if (command.type === 'DISPENSE') this.inFlight.add(command.commandId);
    await this.audit.record({
      type: `COMMAND_${command.type}`,
      machineId: machine.id,
      orderId: links.orderId ?? null,
      calibrationRunId: links.calibrationRunId ?? null,
      pumpChannel: command.type === 'DISPENSE' ? command.channel : null,
      payload: command,
    });
    return command;
  }

  /**
   * Sends a persisted command and waits for its ACK, retransmitting the
   * identical message (same commandId and seq) on timeout. The controller
   * deduplicates, so retries can never cause a second dispense.
   */
  async deliver(command: ControllerCommand): Promise<AckEvent> {
    const attempts = this.config.ACK_RETRIES + 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const wait = this.waitFor(
        `ACK ${command.commandId}`,
        (e): e is AckEvent => e.type === 'ACK' && e.commandId === command.commandId,
        this.config.ACK_TIMEOUT_MS,
        command.machineId,
      );
      await this.prisma.hardwareCommand.update({ where: { id: command.commandId }, data: { attempts: { increment: 1 } } });
      await this.adapter.send(command);
      try {
        const ack = await wait.promise;
        if (!ack.accepted) throw new CommandRejectedError(ack.reason ?? 'unspecified');
        return ack;
      } catch (err) {
        if (err instanceof ControllerDisconnectedError)
          throw new UncertainOutcomeError('CONNECTION_LOST', 'Controller disconnected before acknowledging');
        if (!(err instanceof WaitTimeoutError)) throw err;
        this.logger.warn({ msg: 'ACK timeout, retransmitting', commandId: command.commandId, attempt });
      }
    }
    throw new UncertainOutcomeError('ACK_TIMEOUT', `No acknowledgement after ${attempts} attempts`);
  }

  waitFor<T extends HardwareEvent>(
    what: string,
    match: (e: HardwareEvent) => e is T,
    timeoutMs: number,
    abortOnDisconnectOf?: string,
  ): Wait<T> {
    return this.waiters.waitFor(what, match, timeoutMs, { abortOnDisconnectOf });
  }

  /** Stops the dispense command tracking (after it resolved or was given up on). */
  release(commandId: string): void {
    this.inFlight.delete(commandId);
  }

  /**
   * Sends STOP and waits for STOPPED with all pumps off. Throws
   * UncertainOutcomeError if the controller doesn't confirm.
   */
  async stop(machine: MachineRef, reason: string, links: CommandLinks = {}) {
    const cmd = await this.issue(machine, { type: 'STOP', orderId: links.orderId ?? null, reason }, links);
    const stopped = this.waitFor(
      `STOPPED ${cmd.commandId}`,
      (e): e is Extract<HardwareEvent, { type: 'STOPPED' }> => e.type === 'STOPPED' && e.commandId === cmd.commandId,
      this.config.STOP_CONFIRM_TIMEOUT_MS,
      machine.publicId,
    );
    try {
      await this.deliver(cmd);
      const ev = await stopped.promise;
      if (!ev.allPumpsOff) throw new UncertainOutcomeError('STOP_UNCONFIRMED', 'Controller reported pumps still on');
      return ev;
    } catch (err) {
      stopped.cancel();
      if (err instanceof UncertainOutcomeError) throw new UncertainOutcomeError('STOP_UNCONFIRMED', err.message);
      if (err instanceof WaitTimeoutError || err instanceof ControllerDisconnectedError)
        throw new UncertainOutcomeError('STOP_UNCONFIRMED', 'Controller did not confirm the stop');
      throw err;
    }
  }

  /** Best-effort STOP that never throws (used on failure paths). */
  async stopBestEffort(machine: MachineRef, reason: string, links: CommandLinks = {}): Promise<boolean> {
    try {
      await this.stop(machine, reason, links);
      return true;
    } catch (err) {
      this.logger.warn({ msg: 'Best-effort STOP not confirmed', machineId: machine.publicId, err: String(err) });
      return false;
    }
  }

  // ------------------------------------------------------------------ ingest

  private async process(event: HardwareEvent): Promise<void> {
    if (event.type !== 'CONNECTION') {
      if (this.seenEvents.has(event.eventId)) return;
      this.seenEvents.add(event.eventId);
      if (this.seenEvents.size > SEEN_EVENT_LIMIT) this.seenEvents.delete(this.seenEvents.values().next().value!);
    }
    const machineId = this.machineIds.get(event.machineId);
    if (!machineId) return;

    try {
      if (event.type !== 'CONNECTION') await this.touch(machineId);
      await this.persist(machineId, event);
    } catch (err) {
      this.logger.error({ msg: 'Failed to persist hardware event', type: event.type, err: String(err) });
    }
    this.waiters.notify(event);
    this.events$.next(event);
  }

  private async persist(machineId: string, event: HardwareEvent): Promise<void> {
    const now = new Date();
    switch (event.type) {
      case 'CONNECTION': {
        await this.prisma.machine.update({
          where: { id: machineId },
          data: { hardwareConnection: event.connected ? 'CONNECTED' : 'DISCONNECTED', ...(event.connected ? { lastSeenAt: now } : {}) },
        });
        await this.audit.record({
          type: event.connected ? 'CONTROLLER_CONNECTED' : 'CONTROLLER_DISCONNECTED',
          severity: event.connected ? 'INFO' : 'WARN',
          machineId,
          payload: { reason: event.reason },
        });
        if (event.connected) void this.requestStatus(machineId, event.machineId);
        return;
      }
      case 'PROGRESS':
        return;
      case 'ACK':
        await this.prisma.hardwareCommand.updateMany({
          where: { id: event.commandId, outcome: 'PENDING' },
          data: { outcome: event.accepted ? 'ACKED' : 'REJECTED', ackedAt: now, ...(event.accepted ? {} : { result: event as never, finishedAt: now }) },
        });
        if (!event.accepted) await this.audit.record({ type: 'COMMAND_REJECTED', severity: 'WARN', machineId, payload: event });
        return;
      case 'DONE':
      case 'FAILED':
      case 'TARE_DONE':
        await this.finishCommand(event.commandId, event.type === 'FAILED' ? 'FAILED' : 'DONE', event);
        this.inFlight.delete(event.commandId);
        await this.audit.record({
          type: `CONTROLLER_${event.type}`,
          severity: event.type === 'FAILED' ? 'WARN' : 'INFO',
          machineId,
          payload: event,
        });
        return;
      case 'STOPPED':
        await this.finishCommand(event.commandId, 'DONE', event);
        if (event.interruptedCommandId) {
          await this.finishCommand(event.interruptedCommandId, 'STOPPED', event);
          this.inFlight.delete(event.interruptedCommandId);
        }
        await this.audit.record({ type: 'CONTROLLER_STOPPED', severity: 'WARN', machineId, payload: event });
        return;
      case 'ESTOP':
        await this.prisma.machine.update({ where: { id: machineId }, data: { estopActive: event.active, lastSeenAt: now } });
        if (event.interruptedCommandId) {
          await this.finishCommand(event.interruptedCommandId, 'STOPPED', event);
          this.inFlight.delete(event.interruptedCommandId);
        }
        await this.audit.record({
          type: event.active ? 'ESTOP_PRESSED' : 'ESTOP_RELEASED',
          severity: 'SAFETY',
          machineId,
          payload: event,
        });
        return;
      case 'FAULT':
        await this.prisma.machine.update({
          where: { id: machineId },
          data: { status: 'NEEDS_ATTENTION', faultReason: `Controller fault ${event.code}: ${event.message}` },
        });
        if (event.interruptedCommandId) {
          await this.finishCommand(event.interruptedCommandId, 'FAILED', event);
          this.inFlight.delete(event.interruptedCommandId);
        }
        await this.audit.record({ type: 'CONTROLLER_FAULT', severity: 'SAFETY', machineId, payload: event });
        return;
      case 'STATUS':
        await this.prisma.machine.update({
          where: { id: machineId },
          data: { lastStatus: event as never, lastSeenAt: now, estopActive: event.estopActive, hardwareConnection: 'CONNECTED' },
        });
        await this.reconcile(machineId, event);
        return;
    }
  }

  /** Records controller liveness, at most every few seconds per machine. */
  private async touch(machineId: string): Promise<void> {
    const now = Date.now();
    if (now - (this.lastSeenWrite.get(machineId) ?? 0) < 5000) return;
    this.lastSeenWrite.set(machineId, now);
    await this.prisma.machine.update({ where: { id: machineId }, data: { lastSeenAt: new Date(now) } });
  }

  private async finishCommand(commandId: string, outcome: CommandOutcome, result: ControllerEvent): Promise<void> {
    await this.prisma.hardwareCommand.updateMany({
      where: { id: commandId, outcome: { in: ['PENDING', 'ACKED', 'UNKNOWN'] } },
      data: { outcome, result: result as never, finishedAt: new Date() },
    });
  }

  /**
   * Compares the controller's report with our records after (re)connect.
   * Never replays anything: it only records the evidence and, if a pump is
   * running that we don't expect, stops it and locks the machine.
   */
  private async reconcile(machineId: string, status: StatusEvent): Promise<void> {
    if (status.lastCommandId && ['DONE', 'FAILED', 'STOPPED'].includes(status.lastCommandOutcome)) {
      const cmd = await this.prisma.hardwareCommand.findUnique({ where: { id: status.lastCommandId } });
      if (cmd && cmd.outcome === 'UNKNOWN') {
        await this.prisma.hardwareCommand.update({
          where: { id: cmd.id },
          data: { result: { reconciledFromStatus: status } as never },
        });
        await this.audit.record({
          type: 'COMMAND_RECONCILED',
          severity: 'WARN',
          machineId,
          orderId: cmd.orderId,
          payload: { commandId: cmd.id, reportedOutcome: status.lastCommandOutcome, note: 'Outcome reported after reconnect; order not changed, operator review required' },
        });
      }
    }
    if (status.lastCommandOutcome === 'UNKNOWN' && status.bootedRecently) {
      await this.audit.record({
        type: 'CONTROLLER_REBOOTED_DURING_COMMAND',
        severity: 'SAFETY',
        machineId,
        payload: { lastCommandId: status.lastCommandId },
      });
    }
    if (status.anyPumpOn && (!status.activeCommandId || !this.inFlight.has(status.activeCommandId))) {
      await this.audit.record({ type: 'UNEXPECTED_PUMP_ACTIVITY', severity: 'SAFETY', machineId, payload: status });
      await this.prisma.machine.update({
        where: { id: machineId },
        data: { status: 'NEEDS_ATTENTION', faultReason: 'Controller reported a pump running that the backend did not expect' },
      });
      void this.stopBestEffort({ id: machineId, publicId: status.machineId }, 'Unexpected pump activity');
    }
  }

  private async requestStatus(machineId: string, publicId: string): Promise<void> {
    try {
      const cmd = await this.issue({ id: machineId, publicId }, { type: 'STATUS_REQUEST' });
      await this.deliver(cmd);
    } catch (err) {
      this.logger.warn({ msg: 'STATUS_REQUEST failed', machineId: publicId, err: String(err) });
    }
  }

  /** Records a command as uncertain (used when we give up waiting). */
  async markUnknown(commandId: string): Promise<void> {
    await this.prisma.hardwareCommand.updateMany({
      where: { id: commandId, outcome: { in: ['PENDING', 'ACKED'] } },
      data: { outcome: 'UNKNOWN', finishedAt: new Date() },
    });
    this.inFlight.delete(commandId);
  }

  commandIdOf(event: HardwareEvent): string | null {
    return eventCommandId(event);
  }
}
