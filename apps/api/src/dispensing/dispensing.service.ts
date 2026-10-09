import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import type {
  DoneEvent,
  EstopEvent,
  FailedEvent,
  HardwareEvent,
  StoppedEvent,
  TareDoneEvent,
} from '@pegpal/shared';
import type { Liquid, Machine, OrderItem } from '@prisma/client';
import { Subject, filter } from 'rxjs';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import {
  CommandRejectedError,
  ControllerService,
  MachineRef,
  UncertainOutcomeError,
} from '../hardware/controller.service';
import { ControllerDisconnectedError, WaitTimeoutError } from '../hardware/waiters';
import { OrderStreamService } from '../orders/order-stream.service';
import { OrderViewsService } from '../orders/order-views.service';
import { OrdersRepository } from '../orders/orders.repository';
import { PrismaService } from '../prisma/prisma.service';
import { evaluateEvidence } from './evidence';
import { DispensePlan, PlanError, planDispense } from './plan';

type FinalEvent = DoneEvent | FailedEvent | StoppedEvent | EstopEvent;

type StepOutcome =
  | { kind: 'COMPLETED' }
  | { kind: 'CANCELLED' }
  | { kind: 'SAFETY'; reason: string }
  /** certain=false: we don't know what the pump did; machine must be inspected. */
  | { kind: 'FAILED'; reason: string; certain: boolean };

/**
 * Executes confirmed orders one ingredient at a time. This is the only code
 * that sends pump commands for orders. It never retries a dispense whose
 * outcome is unknown and never resumes an interrupted order.
 */
@Injectable()
export class DispensingService implements OnApplicationShutdown {
  private readonly logger = new Logger('Dispensing');
  private readonly runners = new Map<string, Promise<void>>();
  private readonly cancelSignals = new Map<string, Subject<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly controller: ControllerService,
    private readonly orders: OrdersRepository,
    private readonly views: OrderViewsService,
    private readonly stream: OrderStreamService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Starts the runner for a QUEUED order (no-op if already running). */
  start(orderId: string): void {
    if (this.runners.has(orderId)) return;
    const run = this.run(orderId).finally(() => this.runners.delete(orderId));
    this.runners.set(orderId, run);
  }

  /** Signals a running order to stop its pump. The runner owns the resulting state change. */
  requestCancel(orderId: string): boolean {
    const signal = this.cancelSignals.get(orderId);
    signal?.next();
    return signal !== undefined;
  }

  isRunning(orderId: string): boolean {
    return this.runners.has(orderId);
  }

  /** Resolves when all runners have finished (tests, graceful shutdown). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.runners.values()]);
  }

  async onApplicationShutdown(): Promise<void> {
    for (const s of this.cancelSignals.values()) s.next();
    await this.idle();
  }

  private async run(orderId: string): Promise<void> {
    const cancel$ = new Subject<void>();
    this.cancelSignals.set(orderId, cancel$);
    try {
      await this.execute(orderId, cancel$);
    } catch (err) {
      this.logger.error({ msg: 'Order runner crashed', orderId, err: err instanceof Error ? err.stack : String(err) });
      const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { machine: true } });
      if (order) {
        await this.controller.stopBestEffort(order.machine, 'Backend error during order', { orderId });
        await this.finish(orderId, 'FAILED', `Internal error; outcome uncertain`, { attention: true });
      }
    } finally {
      this.cancelSignals.delete(orderId);
      cancel$.complete();
      await this.stream.publishSnapshot(orderId);
    }
  }

  private async execute(orderId: string, cancel$: Subject<void>): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { orderBy: { position: 'asc' }, include: { liquid: true } }, machine: true },
    });
    if (!order || order.status !== 'QUEUED') return;
    const machine: MachineRef = { id: order.machine.id, publicId: order.machine.publicId };

    const notReady = this.preflight(order.machine);
    if (notReady) return this.finish(orderId, 'FAILED', `Not started: ${notReady}`);

    // Plan every step before any pump runs so a misconfiguration can't fail half-way.
    let plans: DispensePlan[];
    try {
      plans = order.items.map((i) => planDispense(i.liquid, i.requestedMl, this.planLimits()));
    } catch (err) {
      if (err instanceof PlanError) return this.finish(orderId, 'FAILED', `Not started: ${err.message}`);
      throw err;
    }

    if (!(await this.orders.tryTransition(orderId, 'DISPENSING', { data: { dispensingStartedAt: new Date() } }))) return;
    await this.stream.publishSnapshot(orderId);
    const deadline = Date.now() + this.controller.realMs(this.config.ORDER_MAX_DURATION_MS);

    if (this.config.SCALE_FITTED || plans.some((p) => p.strategy === 'WEIGHT')) {
      const tareProblem = await this.tare(machine, orderId);
      if (tareProblem) return this.finish(orderId, 'FAILED', `Scale not ready: ${tareProblem}`);
    }

    for (const [idx, item] of order.items.entries()) {
      const current = await this.orders.status(orderId);
      if (!current || current.status !== 'DISPENSING') return;
      if (current.cancelRequestedAt) return this.finish(orderId, 'CANCELLED', 'Cancelled by customer');
      if (Date.now() > deadline) return this.finish(orderId, 'FAILED', 'Maximum order duration exceeded');
      const m = await this.prisma.machine.findUniqueOrThrow({ where: { id: machine.id } });
      if (m.estopActive) return this.finish(orderId, 'SAFETY_STOPPED', 'Emergency stop active', { attention: true });

      const outcome = await this.dispenseItem(machine, orderId, item, item.liquid, plans[idx], cancel$);
      switch (outcome.kind) {
        case 'COMPLETED':
          continue;
        case 'CANCELLED':
          return this.finish(orderId, 'CANCELLED', 'Cancelled by customer; pump stop confirmed by controller');
        case 'SAFETY':
          return this.finish(orderId, 'SAFETY_STOPPED', outcome.reason, { attention: true });
        case 'FAILED':
          return this.finish(orderId, 'FAILED', outcome.reason, { attention: !outcome.certain });
      }
    }
    await this.finish(orderId, 'COMPLETED', null);
  }

  private preflight(m: Machine): string | null {
    if (m.status !== 'IN_SERVICE') return `machine is ${m.status}`;
    if (m.estopActive) return 'emergency stop active';
    if (!this.controller.isConnected(m.publicId)) return 'controller offline';
    return null;
  }

  private planLimits() {
    return {
      safetyFactor: this.config.RUNTIME_SAFETY_FACTOR,
      allowanceMs: this.config.RUNTIME_ALLOWANCE_MS,
      pumpMaxRuntimeMs: this.config.PUMP_MAX_RUNTIME_MS,
    };
  }

  private ackBudgetMs(): number {
    return this.config.ACK_TIMEOUT_MS * (this.config.ACK_RETRIES + 1);
  }

  /** Returns a problem description, or null when the scale is tared and stable. */
  private async tare(machine: MachineRef, orderId: string): Promise<string | null> {
    const cmd = await this.controller.issue(machine, { type: 'TARE', orderId }, { orderId });
    const done = this.controller.waitFor(
      `TARE_DONE ${cmd.commandId}`,
      (e): e is TareDoneEvent => e.type === 'TARE_DONE' && e.commandId === cmd.commandId,
      this.ackBudgetMs() + this.config.TARE_TIMEOUT_MS,
      machine.publicId,
    );
    try {
      await this.controller.deliver(cmd);
      const ev = await done.promise;
      if (!ev.ok || !ev.stable) return ev.reason ?? 'unstable reading';
      return null;
    } catch (err) {
      done.cancel();
      // A tare never moves liquid, so a failure here is safe to report as a plain failure.
      if (err instanceof CommandRejectedError) return err.reason;
      if (err instanceof UncertainOutcomeError || err instanceof WaitTimeoutError || err instanceof ControllerDisconnectedError)
        return 'no response from scale';
      throw err;
    }
  }

  private async dispenseItem(
    machine: MachineRef,
    orderId: string,
    item: OrderItem,
    liquid: Liquid,
    plan: DispensePlan,
    cancel$: Subject<void>,
  ): Promise<StepOutcome> {
    await this.prisma.orderItem.update({
      where: { id: item.id },
      data: { status: 'DISPENSING', startedAt: new Date(), targetMassG: plan.targetMassG },
    });
    await this.stream.publishSnapshot(orderId);

    // Persisted (with its sequence number) before anything is transmitted.
    const cmd = await this.controller.issue(
      machine,
      {
        type: 'DISPENSE',
        orderId,
        purpose: 'ORDER',
        channel: item.pumpChannel,
        strategy: plan.strategy,
        targetMl: plan.targetMl,
        runtimeMs: plan.runtimeMs,
        targetMassG: plan.targetMassG,
        cutoffMarginG: plan.cutoffMarginG,
        maxDurationMs: plan.maxDurationMs,
      },
      { orderId, orderItemId: item.id },
    );

    const final = this.controller.waitFor(
      `completion ${cmd.commandId}`,
      (e: HardwareEvent): e is FinalEvent =>
        ((e.type === 'DONE' || e.type === 'FAILED') && e.commandId === cmd.commandId) ||
        (e.type === 'STOPPED' && e.interruptedCommandId === cmd.commandId) ||
        (e.type === 'ESTOP' && e.active && e.machineId === machine.publicId),
      this.ackBudgetMs() + this.controller.realMs(plan.maxDurationMs) + this.config.COMPLETION_GRACE_MS,
      machine.publicId,
    );

    const progressSub = this.controller.events$
      .pipe(filter((e) => e.type === 'PROGRESS' && e.commandId === cmd.commandId))
      .subscribe((e) => {
        if (e.type !== 'PROGRESS') return;
        const ml = e.estimatedMl ?? (e.massG !== null && liquid.densityGPerMl ? e.massG / liquid.densityGPerMl : null);
        this.stream.publishProgress(orderId, item.id, ml === null ? null : Math.round(ml * 10) / 10, e.massG, e.simulated);
      });

    let stopRequested = false;
    let stopFailed = false;
    const requestStop = () => {
      if (stopRequested) return;
      stopRequested = true;
      void this.controller.stop(machine, 'Cancelled by customer', { orderId }).catch(() => {
        stopFailed = true;
      });
    };
    const cancelSub = cancel$.subscribe(requestStop);

    try {
      // Cancel may have landed between the step check and subscribing.
      if ((await this.orders.status(orderId))?.cancelRequestedAt) {
        final.cancel();
        await this.prisma.hardwareCommand.update({
          where: { id: cmd.commandId },
          data: { outcome: 'REJECTED', finishedAt: new Date(), result: { notSent: 'cancelled before transmission' } },
        });
        await this.prisma.orderItem.update({ where: { id: item.id }, data: { status: 'PENDING', startedAt: null } });
        return { kind: 'CANCELLED' };
      }

      try {
        await this.controller.deliver(cmd);
      } catch (err) {
        if (err instanceof CommandRejectedError) {
          final.cancel();
          await this.updateItem(item.id, 'FAILED', {
            deliveredMl: 0,
            measuredMassG: null,
            verification: 'UNVERIFIED',
            note: `Controller rejected the command (${err.reason}); the pump did not start.`,
          });
          return { kind: 'FAILED', reason: `Controller rejected ${item.liquidName}: ${err.reason}`, certain: true };
        }
        if (err instanceof UncertainOutcomeError) {
          final.cancel();
          return this.uncertain(machine, orderId, item, cmd.commandId, err.message);
        }
        throw err;
      }

      let ev: FinalEvent;
      try {
        ev = await final.promise;
      } catch (err) {
        if (err instanceof WaitTimeoutError)
          return this.uncertain(machine, orderId, item, cmd.commandId, stopFailed ? 'Stop not confirmed by controller' : 'No completion report before the deadline');
        if (err instanceof ControllerDisconnectedError)
          return this.uncertain(machine, orderId, item, cmd.commandId, 'Controller disconnected while dispensing');
        throw err;
      }

      const evidenceBase = {
        flowRateMlPerSec: liquid.flowRateMlPerSec,
        densityGPerMl: liquid.densityGPerMl,
        simulated: 'simulated' in ev && ev.simulated,
        plausibilityPct: this.config.MASS_PLAUSIBILITY_PCT,
      };

      switch (ev.type) {
        case 'DONE': {
          const evidence = evaluateEvidence({
            ...evidenceBase,
            expectedMl: item.requestedMl,
            runtimeMs: ev.runtimeMs,
            massDeltaG: ev.massDeltaG,
            massStable: ev.massStable,
          });
          await this.updateItem(item.id, 'COMPLETED', evidence, ev.runtimeMs);
          await this.consumeStock(liquid.id, evidence.deliveredMl ?? item.requestedMl);
          return { kind: 'COMPLETED' };
        }
        case 'FAILED': {
          const evidence = evaluateEvidence({ ...evidenceBase, expectedMl: null, runtimeMs: ev.runtimeMs, massDeltaG: ev.massDeltaG, massStable: null });
          await this.updateItem(item.id, 'FAILED', evidence, ev.runtimeMs);
          if (evidence.deliveredMl) await this.consumeStock(liquid.id, evidence.deliveredMl);
          if (ev.code === 'ESTOP') return { kind: 'SAFETY', reason: 'Emergency stop pressed' };
          return { kind: 'FAILED', reason: `${item.liquidName}: ${ev.code} – ${ev.message}`, certain: true };
        }
        case 'STOPPED': {
          const evidence = evaluateEvidence({ ...evidenceBase, expectedMl: null, runtimeMs: ev.runtimeMs, massDeltaG: ev.massDeltaG, massStable: null });
          await this.updateItem(item.id, 'STOPPED', evidence, ev.runtimeMs);
          if (evidence.deliveredMl) await this.consumeStock(liquid.id, evidence.deliveredMl);
          if (stopRequested) return { kind: 'CANCELLED' };
          return { kind: 'FAILED', reason: 'Stopped by operator', certain: true };
        }
        case 'ESTOP': {
          await this.updateItem(item.id, 'STOPPED', {
            deliveredMl: null,
            measuredMassG: null,
            verification: 'UNVERIFIED',
            note: 'Interrupted by emergency stop; partial amount not verified.',
          });
          return { kind: 'SAFETY', reason: 'Emergency stop pressed during dispensing' };
        }
      }
    } finally {
      progressSub.unsubscribe();
      cancelSub.unsubscribe();
      this.views.clearProgress(item.id);
      this.controller.release(cmd.commandId);
    }
  }

  /** We don't know what the pump did: stop it, record UNKNOWN, lock the machine. Never retry. */
  private async uncertain(machine: MachineRef, orderId: string, item: OrderItem, commandId: string, why: string): Promise<StepOutcome> {
    await this.controller.markUnknown(commandId);
    const stopped = await this.controller.stopBestEffort(machine, `Uncertain outcome: ${why}`, { orderId });
    await this.updateItem(item.id, 'UNKNOWN', {
      deliveredMl: null,
      measuredMassG: null,
      verification: 'UNVERIFIED',
      note: `Outcome unknown (${why}). The pump may have run; operator inspection required.`,
    });
    await this.audit.record({
      type: 'DISPENSE_OUTCOME_UNKNOWN',
      severity: 'SAFETY',
      machineId: machine.id,
      orderId,
      pumpChannel: item.pumpChannel,
      liquidId: item.liquidId,
      payload: { commandId, why, stopConfirmed: stopped },
    });
    return { kind: 'FAILED', reason: `${item.liquidName}: ${why}; outcome unverified`, certain: false };
  }

  private async updateItem(
    itemId: string,
    status: 'COMPLETED' | 'FAILED' | 'STOPPED' | 'UNKNOWN',
    evidence: { deliveredMl: number | null; measuredMassG: number | null; verification: OrderItem['verification']; note: string },
    runtimeMs?: number | null,
  ): Promise<void> {
    await this.prisma.orderItem.update({
      where: { id: itemId },
      data: {
        status,
        completedAt: new Date(),
        deliveredMl: evidence.deliveredMl,
        measuredMassG: evidence.measuredMassG,
        verification: evidence.verification,
        verificationNote: evidence.note,
        runtimeMs: runtimeMs ?? null,
      },
    });
  }

  private async consumeStock(liquidId: string, ml: number): Promise<void> {
    await this.prisma.liquid.updateMany({
      where: { id: liquidId, remainingStockMl: { not: null } },
      data: { remainingStockMl: { decrement: Math.ceil(ml) } },
    });
  }

  private async finish(
    orderId: string,
    to: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'SAFETY_STOPPED',
    reason: string | null,
    opts: { attention?: boolean } = {},
  ): Promise<void> {
    const done = await this.orders.tryTransition(orderId, to, {
      data: { failureReason: reason && to !== 'COMPLETED' ? reason : null },
      ...(opts.attention ? { machineStatus: 'NEEDS_ATTENTION', machineFaultReason: `Order ${orderId}: ${reason}` } : {}),
    });
    if (!done) {
      this.logger.warn({ msg: 'Final transition lost (order already terminal?)', orderId, to });
      return;
    }
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { machineId: true } });
    await this.audit.record({
      type: `ORDER_${to}`,
      severity: to === 'COMPLETED' ? 'INFO' : to === 'SAFETY_STOPPED' || opts.attention ? 'SAFETY' : 'WARN',
      machineId: order.machineId,
      orderId,
      payload: { reason, machineNeedsAttention: opts.attention ?? false },
    });
    await this.stream.publishSnapshot(orderId);
  }
}
