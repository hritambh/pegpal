import { Inject, Injectable } from '@nestjs/common';
import type { AdminMachineView, AdminOverview, DispensingEventView, OrderView, StatusEvent } from '@pegpal/shared';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import { APP_CONFIG, AppConfig } from '../config/config';
import { ControllerService, UncertainOutcomeError } from '../hardware/controller.service';
import { ControllerDisconnectedError, WaitTimeoutError } from '../hardware/waiters';
import { MachinesService } from '../machines/machines.service';
import { ORDER_INCLUDE, OrderViewsService } from '../orders/order-views.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ListQueryDto } from './admin.dto';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly machines: MachinesService,
    private readonly views: OrderViewsService,
    private readonly controller: ControllerService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async overview(): Promise<AdminOverview> {
    const machines = await this.prisma.machine.findMany({ orderBy: { publicId: 'asc' } });
    return {
      hardwareMode: this.controller.mode,
      paymentMode: this.config.PAYMENT_MODE,
      machines: machines.map((m) => this.machines.toAdminView(m)),
    };
  }

  async orders(q: ListQueryDto): Promise<OrderView[]> {
    const orders = await this.prisma.order.findMany({
      where: q.machineId ? { machineId: q.machineId } : {},
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: q.limit ?? 50,
    });
    return orders.map((o) => this.views.toView(o));
  }

  async events(q: ListQueryDto): Promise<DispensingEventView[]> {
    const events = await this.prisma.dispensingEvent.findMany({
      where: {
        ...(q.machineId ? { machineId: q.machineId } : {}),
        ...(q.orderId ? { orderId: q.orderId } : {}),
        ...(q.severity ? { severity: q.severity } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit ?? 100,
    });
    return events.map((e) => ({
      id: e.id,
      machineId: e.machineId,
      orderId: e.orderId,
      calibrationRunId: e.calibrationRunId,
      type: e.type,
      severity: e.severity,
      pumpChannel: e.pumpChannel,
      liquidId: e.liquidId,
      payload: e.payload,
      actor: e.actor,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  async setStatus(id: string, status: 'IN_SERVICE' | 'OUT_OF_SERVICE', actor: string): Promise<AdminMachineView> {
    const m = await this.machines.getById(id);
    if (status === 'IN_SERVICE' && m.status === 'NEEDS_ATTENTION')
      throw Errors.conflict('FAULT_NOT_CLEARED', 'Machine needs attention; use clear-fault after inspection');
    const updated = await this.prisma.machine.update({ where: { id }, data: { status } });
    await this.audit.record({ type: 'MACHINE_STATUS_SET', severity: 'WARN', machineId: id, actor, payload: { from: m.status, to: status } });
    return this.machines.toAdminView(updated);
  }

  /** Software stop of all pumps. Cannot and does not touch the physical e-stop. */
  async stop(id: string, reason: string, actor: string): Promise<AdminMachineView> {
    const m = await this.machines.getById(id);
    await this.audit.record({ type: 'ADMIN_STOP_REQUESTED', severity: 'SAFETY', machineId: id, actor, payload: { reason } });
    try {
      await this.controller.stop(m, `Operator stop: ${reason}`, { orderId: m.activeOrderId });
    } catch (err) {
      if (!(err instanceof UncertainOutcomeError)) throw err;
      await this.prisma.machine.update({ where: { id }, data: { status: 'NEEDS_ATTENTION', faultReason: 'Operator stop was not confirmed by the controller' } });
      throw Errors.hardwareUnavailable('Controller did not confirm the stop. Use the physical emergency stop.');
    }
    return this.machines.toAdminView(await this.machines.getById(id));
  }

  /**
   * Returns a NEEDS_ATTENTION machine to service after operator inspection.
   * Requires a fresh controller STATUS showing no pump on and no e-stop.
   */
  async clearFault(id: string, note: string, actor: string): Promise<AdminMachineView> {
    const m = await this.machines.getById(id);
    if (m.activeOrderId || m.activeCalibrationRunId) throw Errors.machineBusy();
    if (!this.controller.isConnected(m.publicId)) throw Errors.hardwareUnavailable('Controller offline; cannot verify state');

    const status = await this.freshStatus(m);
    if (status.anyPumpOn) throw Errors.conflict('PUMP_RUNNING', 'Controller reports a pump running');
    if (status.estopActive) throw Errors.conflict('ESTOP_ACTIVE', 'Physical emergency stop is active; release and reset it locally');

    const updated = await this.prisma.machine.update({
      where: { id },
      data: { status: m.status === 'NEEDS_ATTENTION' ? 'IN_SERVICE' : m.status, faultReason: null },
    });
    await this.audit.record({ type: 'FAULT_CLEARED', severity: 'SAFETY', machineId: id, actor, payload: { note, previousFault: m.faultReason, status } });
    return this.machines.toAdminView(updated);
  }

  private async freshStatus(m: { id: string; publicId: string }): Promise<StatusEvent> {
    const cmd = await this.controller.issue(m, { type: 'STATUS_REQUEST' });
    const wait = this.controller.waitFor(
      'STATUS',
      (e): e is StatusEvent => e.type === 'STATUS' && e.machineId === m.publicId,
      this.config.ACK_TIMEOUT_MS * (this.config.ACK_RETRIES + 1) + 1000,
      m.publicId,
    );
    try {
      await this.controller.deliver(cmd);
      return await wait.promise;
    } catch (err) {
      wait.cancel();
      if (err instanceof UncertainOutcomeError || err instanceof WaitTimeoutError || err instanceof ControllerDisconnectedError)
        throw Errors.hardwareUnavailable('Controller did not report its status');
      throw err;
    }
  }
}
