import { Injectable } from '@nestjs/common';
import type { OrderStatus } from '@pegpal/shared';
import { allowedSourcesFor, isTerminalStatus } from '@pegpal/shared';
import { MachineServiceStatus, Prisma } from '@prisma/client';
import { Errors } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient;

export interface TransitionOptions {
  /** Further restrict the legal source states. */
  from?: OrderStatus[];
  data?: Omit<Prisma.OrderUpdateManyMutationInput, 'status'>;
  /** Terminal transitions only: put the machine into this status (e.g. NEEDS_ATTENTION). */
  machineStatus?: MachineServiceStatus;
  machineFaultReason?: string;
}

/**
 * The only place order status changes. Each transition is a single
 * conditional UPDATE guarded by the state machine, so concurrent actors can't
 * both win and illegal transitions are impossible.
 */
@Injectable()
export class OrdersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns true if this call performed the transition. */
  async tryTransition(orderId: string, to: OrderStatus, opts: TransitionOptions = {}, tx?: Tx): Promise<boolean> {
    const run = async (t: Tx) => {
      const legal = allowedSourcesFor(to).filter((s) => !opts.from || opts.from.includes(s));
      const now = new Date();
      const terminal = isTerminalStatus(to);
      const res = await t.order.updateMany({
        where: { id: orderId, status: { in: legal } },
        data: { ...opts.data, status: to, ...(terminal ? { finishedAt: now } : {}) },
      });
      if (res.count === 0) return false;
      if (terminal) {
        await t.orderItem.updateMany({ where: { orderId, status: 'PENDING' }, data: { status: 'SKIPPED' } });
        // Release the reservation held by this order (and only this order).
        await t.machine.updateMany({
          where: { activeOrderId: orderId },
          data: {
            activeOrderId: null,
            ...(opts.machineStatus ? { status: opts.machineStatus, faultReason: opts.machineFaultReason ?? null } : {}),
          },
        });
      }
      return true;
    };
    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  /** Like tryTransition but throws 409 INVALID_TRANSITION when it can't happen. */
  async transition(orderId: string, to: OrderStatus, opts: TransitionOptions = {}, tx?: Tx): Promise<void> {
    if (await this.tryTransition(orderId, to, opts, tx)) return;
    const current = await (tx ?? this.prisma).order.findUnique({ where: { id: orderId }, select: { status: true } });
    if (!current) throw Errors.orderNotFound();
    throw Errors.invalidTransition(current.status, to);
  }

  async status(orderId: string): Promise<{ status: OrderStatus; cancelRequestedAt: Date | null } | null> {
    return this.prisma.order.findUnique({ where: { id: orderId }, select: { status: true, cancelRequestedAt: true } });
  }
}
