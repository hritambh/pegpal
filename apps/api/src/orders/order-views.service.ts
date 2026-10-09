import { Injectable } from '@nestjs/common';
import type { OrderItemView, OrderView } from '@pegpal/shared';
import type { Machine, Order, OrderItem } from '@prisma/client';
import { Errors } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

export type OrderWithRelations = Order & { items: OrderItem[]; machine: Pick<Machine, 'publicId' | 'name'> };

export const ORDER_INCLUDE = {
  items: { orderBy: { position: 'asc' } },
  machine: { select: { publicId: true, name: true } },
} as const;

interface LiveProgress {
  progressMl: number | null;
  massG: number | null;
}

/** Builds OrderView, overlaying live (non-persisted) progress of the running item. */
@Injectable()
export class OrderViewsService {
  private readonly progress = new Map<string, LiveProgress>();

  constructor(private readonly prisma: PrismaService) {}

  setProgress(itemId: string, p: LiveProgress): void {
    this.progress.set(itemId, p);
  }

  clearProgress(itemId: string): void {
    this.progress.delete(itemId);
  }

  async get(orderId: string): Promise<OrderView> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
    if (!order) throw Errors.orderNotFound();
    return this.toView(order);
  }

  toView(o: OrderWithRelations): OrderView {
    return {
      id: o.id,
      machineId: o.machine.publicId,
      machineName: o.machine.name,
      status: o.status,
      totalVolumeMl: o.totalVolumeMl,
      totalPrice: o.totalPrice.toFixed(2),
      currency: o.currency,
      payment: { mode: o.paymentMode, status: o.paymentStatus, isTest: o.paymentStatus === 'TEST_CONFIRMED' },
      cancelRequested: o.cancelRequestedAt !== null,
      failureReason: o.failureReason,
      expiresAt: o.status === 'CREATED' ? (o.expiresAt?.toISOString() ?? null) : null,
      items: o.items.map((i) => this.itemView(i)),
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
    };
  }

  private itemView(i: OrderItem): OrderItemView {
    const live = i.status === 'DISPENSING' ? this.progress.get(i.id) : undefined;
    return {
      id: i.id,
      position: i.position,
      liquidId: i.liquidId,
      liquidName: i.liquidName,
      pumpChannel: i.pumpChannel,
      requestedMl: i.requestedMl,
      unitPrice: i.unitPrice.toFixed(4),
      linePrice: i.linePrice.toFixed(2),
      targetMassG: i.targetMassG,
      status: i.status,
      progressMl: live?.progressMl ?? (i.status === 'DISPENSING' ? 0 : null),
      deliveredMl: i.deliveredMl,
      measuredMassG: i.measuredMassG,
      verification: i.verification,
      verificationNote: i.verificationNote,
      startedAt: i.startedAt?.toISOString() ?? null,
      completedAt: i.completedAt?.toISOString() ?? null,
    };
  }
}
