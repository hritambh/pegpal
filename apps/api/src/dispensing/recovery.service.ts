import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { OrdersRepository } from '../orders/orders.repository';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Runs at boot, before HTTP traffic is accepted. Anything that was in flight
 * when the previous process died is closed out conservatively. Nothing is
 * resumed: a pump that may have run puts the machine into NEEDS_ATTENTION.
 * (A controller still running a pump is stopped by ControllerService when its
 * STATUS arrives, because no command is in flight in this process.)
 */
@Injectable()
export class RecoveryService implements OnModuleInit {
  private readonly logger = new Logger('Recovery');

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersRepository,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.recover();
  }

  async recover(): Promise<{ orders: number; calibrations: number }> {
    const interrupted = await this.prisma.order.findMany({
      where: { status: { in: ['AUTHORIZED', 'QUEUED', 'DISPENSING'] } },
      include: { items: true },
    });
    for (const order of interrupted) {
      const started = order.status === 'DISPENSING';
      await this.prisma.$transaction(async (tx) => {
        if (started) {
          await tx.orderItem.updateMany({
            where: { orderId: order.id, status: 'DISPENSING' },
            data: {
              status: 'UNKNOWN',
              verification: 'UNVERIFIED',
              verificationNote: 'Backend restarted during this step; outcome unknown. Operator inspection required.',
              completedAt: new Date(),
            },
          });
          await tx.hardwareCommand.updateMany({
            where: { orderId: order.id, outcome: { in: ['PENDING', 'ACKED'] } },
            data: { outcome: 'UNKNOWN', finishedAt: new Date() },
          });
        }
        await this.orders.transition(
          order.id,
          'FAILED',
          {
            data: {
              failureReason: started
                ? 'Interrupted by a backend restart while dispensing; outcome unverified'
                : 'Interrupted by a backend restart before dispensing started',
            },
            ...(started
              ? { machineStatus: 'NEEDS_ATTENTION', machineFaultReason: `Order ${order.id} interrupted by backend restart` }
              : {}),
          },
          tx,
        );
      });
      await this.audit.record({
        type: 'ORDER_RECOVERED_AFTER_RESTART',
        severity: started ? 'SAFETY' : 'WARN',
        machineId: order.machineId,
        orderId: order.id,
        payload: { previousStatus: order.status, resumed: false },
      });
    }

    const runs = await this.prisma.calibrationRun.findMany({ where: { status: 'RUNNING' } });
    for (const run of runs) {
      await this.prisma.$transaction([
        this.prisma.calibrationRun.update({
          where: { id: run.id },
          data: { status: 'FAILED', failureReason: 'Interrupted by backend restart', completedAt: new Date() },
        }),
        this.prisma.machine.updateMany({
          where: { activeCalibrationRunId: run.id },
          data: { activeCalibrationRunId: null, status: 'NEEDS_ATTENTION', faultReason: 'Calibration run interrupted by backend restart' },
        }),
      ]);
      await this.audit.record({ type: 'CALIBRATION_RECOVERED_AFTER_RESTART', severity: 'SAFETY', machineId: run.machineId, calibrationRunId: run.id });
    }

    if (interrupted.length || runs.length)
      this.logger.warn({ msg: 'Closed out interrupted work', orders: interrupted.length, calibrations: runs.length });
    return { orders: interrupted.length, calibrations: runs.length };
  }
}
