import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AdminLiquidView, CalibrationRunView, DoneEvent, EstopEvent, FailedEvent, HardwareEvent, StoppedEvent, TareDoneEvent } from '@pegpal/shared';
import { densityFrom, flowRateFrom, percentError } from '@pegpal/shared';
import type { CalibrationRun, Liquid } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DispensePlan, PlanError, planDispense } from '../dispensing/plan';
import { CommandRejectedError, ControllerService, MachineRef, UncertainOutcomeError } from '../hardware/controller.service';
import { ControllerDisconnectedError, WaitTimeoutError } from '../hardware/waiters';
import { toAdminLiquidView } from '../liquids/liquids.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CalibrationMeasurementDto, StartCalibrationDto } from './admin.dto';

type Final = DoneEvent | FailedEvent | StoppedEvent | EstopEvent;
type RunResult = { ok: true; runtimeMs: number; simulatedMl: number | null } | { ok: false; reason: string; uncertain: boolean };

/**
 * Operator calibration: bounded test dispenses, manual measurement entry
 * (graduated cylinder / scale), flow-rate & density computation, and an
 * explicit "apply" step. In mock mode everything is labelled simulated.
 */
@Injectable()
export class CalibrationService {
  private readonly logger = new Logger('Calibration');
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly controller: ControllerService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async idle(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }

  async list(liquidId: string | undefined, limit = 50): Promise<CalibrationRunView[]> {
    const runs = await this.prisma.calibrationRun.findMany({
      where: liquidId ? { liquidId } : {},
      include: { liquid: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return runs.map(toView);
  }

  async get(id: string): Promise<CalibrationRunView> {
    const run = await this.prisma.calibrationRun.findUnique({ where: { id }, include: { liquid: { select: { name: true } } } });
    if (!run) throw Errors.notFound('CALIBRATION_NOT_FOUND', 'Calibration run not found');
    return toView(run);
  }

  async start(dto: StartCalibrationDto, actor: string): Promise<CalibrationRunView> {
    const liquid = await this.prisma.liquid.findUnique({ where: { id: dto.liquidId }, include: { machine: true } });
    if (!liquid) throw Errors.liquidNotFound();
    const machine = liquid.machine;

    let plan: DispensePlan | null = null;
    let runtimeMs: number | null = null;
    if (dto.kind === 'FLOW_RATE') {
      runtimeMs = dto.runtimeMs!;
      if (runtimeMs > this.config.CALIBRATION_MAX_RUNTIME_MS || runtimeMs > this.config.PUMP_MAX_RUNTIME_MS)
        throw Errors.unprocessable('CALIBRATION_LIMIT', `runtimeMs must not exceed ${Math.min(this.config.CALIBRATION_MAX_RUNTIME_MS, this.config.PUMP_MAX_RUNTIME_MS)} ms`);
    } else {
      try {
        plan = planDispense(liquid, dto.targetMl!, {
          safetyFactor: this.config.RUNTIME_SAFETY_FACTOR,
          allowanceMs: this.config.RUNTIME_ALLOWANCE_MS,
          pumpMaxRuntimeMs: Math.min(this.config.CALIBRATION_MAX_RUNTIME_MS, this.config.PUMP_MAX_RUNTIME_MS),
        });
      } catch (err) {
        if (err instanceof PlanError) throw Errors.unprocessable('CALIBRATION_NOT_POSSIBLE', err.message);
        throw err;
      }
    }

    if (machine.status !== 'IN_SERVICE' && machine.status !== 'OUT_OF_SERVICE')
      throw Errors.machineUnavailable('machine needs attention; clear the fault first');
    if (machine.estopActive) throw Errors.machineUnavailable('emergency stop active');
    if (!this.controller.isConnected(machine.publicId)) throw Errors.hardwareUnavailable('Controller offline');

    const simulated = this.controller.mode === 'mock';
    const run = await this.prisma.$transaction(async (tx) => {
      const created = await tx.calibrationRun.create({
        data: {
          machineId: machine.id,
          liquidId: liquid.id,
          pumpChannel: liquid.pumpChannel,
          kind: dto.kind,
          commandedRuntimeMs: runtimeMs ?? plan?.runtimeMs ?? null,
          targetMl: dto.kind === 'VALIDATION' ? dto.targetMl! : null,
          previousFlowRate: liquid.flowRateMlPerSec,
          simulated,
          operator: actor,
        },
      });
      // Calibration takes the machine out of customer use (operators may calibrate while OUT_OF_SERVICE).
      const reserved = await tx.machine.updateMany({
        where: { id: machine.id, activeOrderId: null, activeCalibrationRunId: null, estopActive: false, status: { in: ['IN_SERVICE', 'OUT_OF_SERVICE'] } },
        data: { activeCalibrationRunId: created.id },
      });
      if (reserved.count !== 1) throw Errors.machineBusy();
      return created;
    });
    await this.audit.record({
      type: 'CALIBRATION_STARTED',
      severity: 'WARN',
      machineId: machine.id,
      calibrationRunId: run.id,
      liquidId: liquid.id,
      pumpChannel: liquid.pumpChannel,
      actor,
      payload: { kind: dto.kind, runtimeMs, targetMl: dto.targetMl ?? null, simulated },
    });

    const exec = this.execute(run, liquid, machine, plan).finally(() => this.running.delete(run.id));
    this.running.set(run.id, exec);
    return this.get(run.id);
  }

  async measure(id: string, dto: CalibrationMeasurementDto, actor: string): Promise<CalibrationRunView> {
    const run = await this.prisma.calibrationRun.findUnique({ where: { id } });
    if (!run) throw Errors.notFound('CALIBRATION_NOT_FOUND', 'Calibration run not found');
    if (run.status !== 'AWAITING_MEASUREMENT') throw Errors.conflict('CALIBRATION_STATE', `Run is ${run.status}`);

    const density = dto.measuredMassG !== undefined ? round(densityFrom(dto.measuredMassG, dto.measuredMl), 4) : null;
    let flow: number | null = null;
    let errorPct: number | null = null;
    if (run.kind === 'FLOW_RATE') {
      if (!run.actualRuntimeMs) throw Errors.conflict('CALIBRATION_STATE', 'No confirmed runtime for this run');
      flow = round(flowRateFrom(dto.measuredMl, run.actualRuntimeMs), 4);
    } else {
      errorPct = round(percentError(run.targetMl!, dto.measuredMl), 2);
    }
    await this.prisma.calibrationRun.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        measuredMl: dto.measuredMl,
        measuredMassG: dto.measuredMassG ?? null,
        computedDensity: density,
        computedFlowRate: flow,
        errorPct,
        completedAt: new Date(),
      },
    });
    await this.audit.record({
      type: 'CALIBRATION_MEASURED',
      machineId: run.machineId,
      calibrationRunId: id,
      liquidId: run.liquidId,
      actor,
      payload: { ...dto, computedFlowRate: flow, computedDensity: density, errorPct, simulated: run.simulated },
    });
    return this.get(id);
  }

  async apply(id: string, actor: string): Promise<AdminLiquidView> {
    const run = await this.prisma.calibrationRun.findUnique({ where: { id } });
    if (!run) throw Errors.notFound('CALIBRATION_NOT_FOUND', 'Calibration run not found');
    if (run.kind !== 'FLOW_RATE' || run.status !== 'COMPLETED' || run.computedFlowRate === null)
      throw Errors.conflict('CALIBRATION_STATE', 'Only completed FLOW_RATE runs can be applied');
    if (run.applied) throw Errors.conflict('CALIBRATION_APPLIED', 'Run already applied');
    const liquid = await this.prisma.liquid.findUniqueOrThrow({ where: { id: run.liquidId } });
    if (liquid.pumpChannel !== run.pumpChannel)
      throw Errors.conflict('CALIBRATION_STALE', 'Liquid was moved to another pump since this run');

    const [updated] = await this.prisma.$transaction([
      this.prisma.liquid.update({
        where: { id: liquid.id },
        data: {
          flowRateMlPerSec: run.computedFlowRate,
          ...(run.computedDensity !== null ? { densityGPerMl: run.computedDensity } : {}),
          calibratedAt: new Date(),
          calibrationSimulated: run.simulated,
        },
      }),
      this.prisma.calibrationRun.update({ where: { id }, data: { applied: true } }),
    ]);
    await this.audit.record({
      type: 'CALIBRATION_APPLIED',
      severity: 'WARN',
      machineId: run.machineId,
      calibrationRunId: id,
      liquidId: liquid.id,
      pumpChannel: liquid.pumpChannel,
      actor,
      payload: { previousFlowRate: liquid.flowRateMlPerSec, newFlowRate: run.computedFlowRate, density: run.computedDensity, simulated: run.simulated },
    });
    return toAdminLiquidView(updated);
  }

  // ---------------------------------------------------------------- execution

  private async execute(run: CalibrationRun, liquid: Liquid, machine: MachineRef, plan: DispensePlan | null): Promise<void> {
    let result: RunResult;
    try {
      result = await this.dispense(run, liquid, machine, plan);
    } catch (err) {
      this.logger.error({ msg: 'Calibration run crashed', runId: run.id, err: String(err) });
      await this.controller.stopBestEffort(machine, 'Calibration error');
      result = { ok: false, reason: 'Internal error; outcome uncertain', uncertain: true };
    }

    await this.prisma.$transaction([
      this.prisma.calibrationRun.update({
        where: { id: run.id },
        data: result.ok
          ? { status: 'AWAITING_MEASUREMENT', actualRuntimeMs: result.runtimeMs, simulatedReadingMl: result.simulatedMl }
          : { status: 'FAILED', failureReason: result.reason, completedAt: new Date() },
      }),
      this.prisma.machine.updateMany({
        where: { activeCalibrationRunId: run.id },
        data: {
          activeCalibrationRunId: null,
          ...(!result.ok && result.uncertain ? { status: 'NEEDS_ATTENTION', faultReason: `Calibration ${run.id}: ${result.reason}` } : {}),
        },
      }),
    ]);
    await this.audit.record({
      type: result.ok ? 'CALIBRATION_DISPENSE_DONE' : 'CALIBRATION_FAILED',
      severity: result.ok ? 'INFO' : result.uncertain ? 'SAFETY' : 'WARN',
      machineId: machine.id,
      calibrationRunId: run.id,
      liquidId: liquid.id,
      pumpChannel: liquid.pumpChannel,
      payload: result,
    });
  }

  private async dispense(run: CalibrationRun, liquid: Liquid, machine: MachineRef, plan: DispensePlan | null): Promise<RunResult> {
    const links = { calibrationRunId: run.id };
    const ackBudget = this.config.ACK_TIMEOUT_MS * (this.config.ACK_RETRIES + 1);

    if (plan?.strategy === 'WEIGHT') {
      const tare = await this.controller.issue(machine, { type: 'TARE', orderId: null }, links);
      const tareDone = this.controller.waitFor(
        'TARE_DONE',
        (e): e is TareDoneEvent => e.type === 'TARE_DONE' && e.commandId === tare.commandId,
        ackBudget + this.config.TARE_TIMEOUT_MS,
        machine.publicId,
      );
      try {
        await this.controller.deliver(tare);
        const ev = await tareDone.promise;
        if (!ev.ok) return { ok: false, reason: `Tare failed: ${ev.reason ?? 'unstable'}`, uncertain: false };
      } catch {
        tareDone.cancel();
        return { ok: false, reason: 'Tare not confirmed', uncertain: false };
      }
    }

    const runtimeMs = plan ? plan.runtimeMs : run.commandedRuntimeMs!;
    const maxDurationMs = plan
      ? plan.maxDurationMs
      : Math.min(Math.ceil(runtimeMs! * 1.2 + 1000), this.config.PUMP_MAX_RUNTIME_MS, this.config.CALIBRATION_MAX_RUNTIME_MS + 1000);
    const cmd = await this.controller.issue(
      machine,
      {
        type: 'DISPENSE',
        orderId: null,
        purpose: 'CALIBRATION',
        channel: liquid.pumpChannel,
        strategy: plan?.strategy ?? 'TIMED',
        targetMl: plan?.targetMl ?? (liquid.flowRateMlPerSec ? round((runtimeMs! / 1000) * liquid.flowRateMlPerSec, 1) : 0),
        runtimeMs,
        targetMassG: plan?.targetMassG ?? null,
        cutoffMarginG: plan?.cutoffMarginG ?? null,
        maxDurationMs,
      },
      links,
    );
    const final = this.controller.waitFor(
      'calibration completion',
      (e: HardwareEvent): e is Final =>
        ((e.type === 'DONE' || e.type === 'FAILED') && e.commandId === cmd.commandId) ||
        (e.type === 'STOPPED' && e.interruptedCommandId === cmd.commandId) ||
        (e.type === 'ESTOP' && e.active && e.machineId === machine.publicId),
      ackBudget + this.controller.realMs(maxDurationMs) + this.config.COMPLETION_GRACE_MS,
      machine.publicId,
    );
    try {
      try {
        await this.controller.deliver(cmd);
      } catch (err) {
        final.cancel();
        if (err instanceof CommandRejectedError) return { ok: false, reason: `Rejected by controller: ${err.reason}`, uncertain: false };
        if (err instanceof UncertainOutcomeError) return this.uncertain(machine, cmd.commandId, err.message);
        throw err;
      }
      let ev: Final;
      try {
        ev = await final.promise;
      } catch (err) {
        if (err instanceof WaitTimeoutError || err instanceof ControllerDisconnectedError)
          return this.uncertain(machine, cmd.commandId, err.message);
        throw err;
      }
      if (ev.type === 'DONE') {
        return { ok: true, runtimeMs: ev.runtimeMs, simulatedMl: ev.simulated ? ev.massDeltaG : null };
      }
      if (ev.type === 'ESTOP') return { ok: false, reason: 'Emergency stop pressed', uncertain: true };
      if (ev.type === 'STOPPED') return { ok: false, reason: 'Stopped by operator', uncertain: false };
      return { ok: false, reason: `${ev.code}: ${ev.message}`, uncertain: false };
    } finally {
      this.controller.release(cmd.commandId);
    }
  }

  private async uncertain(machine: MachineRef, commandId: string, why: string): Promise<RunResult> {
    await this.controller.markUnknown(commandId);
    await this.controller.stopBestEffort(machine, `Calibration outcome uncertain: ${why}`);
    return { ok: false, reason: `Outcome uncertain: ${why}`, uncertain: true };
  }
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function toView(r: CalibrationRun & { liquid: { name: string } }): CalibrationRunView {
  return {
    id: r.id,
    liquidId: r.liquidId,
    liquidName: r.liquid.name,
    pumpChannel: r.pumpChannel,
    kind: r.kind,
    status: r.status,
    commandedRuntimeMs: r.commandedRuntimeMs,
    actualRuntimeMs: r.actualRuntimeMs,
    targetMl: r.targetMl,
    measuredMl: r.measuredMl,
    measuredMassG: r.measuredMassG,
    computedDensity: r.computedDensity,
    computedFlowRate: r.computedFlowRate,
    previousFlowRate: r.previousFlowRate,
    errorPct: r.errorPct,
    simulated: r.simulated,
    simulatedReadingMl: r.simulatedReadingMl,
    applied: r.applied,
    operator: r.operator,
    failureReason: r.failureReason,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
  };
}
