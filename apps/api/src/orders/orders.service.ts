import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { CreateOrderResponse, OrderView } from '@pegpal/shared';
import { isTerminalStatus, validateQuantity } from '@pegpal/shared';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DispensingService } from '../dispensing/dispensing.service';
import { ControllerService } from '../hardware/controller.service';
import { liquidIssue } from '../liquids/liquids.service';
import { unavailableReason } from '../machines/availability';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateOrderDto } from './order.dto';
import { OrderStreamService } from './order-stream.service';
import { orderToken, verifyOrderToken } from './order-token';
import { OrderViewsService } from './order-views.service';
import { OrdersRepository } from './orders.repository';
import { priceLines } from './pricing';

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

export interface CreateResult {
  status: HttpStatus.CREATED | HttpStatus.OK;
  body: CreateOrderResponse;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: OrdersRepository,
    private readonly views: OrderViewsService,
    private readonly stream: OrderStreamService,
    private readonly dispensing: DispensingService,
    private readonly controller: ControllerService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(dto: CreateOrderDto, idempotencyKey: string | undefined): Promise<CreateResult> {
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey))
      throw Errors.unprocessable('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header (8-128 chars of [A-Za-z0-9_-]) is required');

    const requestHash = hashRequest(dto);
    const replay = await this.replay(idempotencyKey, requestHash);
    if (replay) return replay;

    const machine = await this.prisma.machine.findUnique({ where: { publicId: dto.machineId } });
    if (!machine) throw Errors.machineNotFound();
    if (machine.activeOrderId || machine.activeCalibrationRunId) throw Errors.machineBusy();
    const notReady = unavailableReason(machine) ?? (this.controller.isConnected(machine.publicId) ? null : 'controller offline');
    if (notReady) throw Errors.machineUnavailable(notReady);

    // ---- validate items (collect every problem for the client)
    const problems: string[] = [];
    if (dto.items.length > this.config.ORDER_MAX_ITEMS) problems.push(`At most ${this.config.ORDER_MAX_ITEMS} liquids per order`);
    const ids = dto.items.map((i) => i.liquidId);
    if (new Set(ids).size !== ids.length) problems.push('Each liquid may appear only once');
    const liquids = await this.prisma.liquid.findMany({ where: { id: { in: ids }, machineId: machine.id } });
    const byId = new Map(liquids.map((l) => [l.id, l]));
    for (const [idx, item] of dto.items.entries()) {
      const l = byId.get(item.liquidId);
      if (!l) {
        problems.push(`items.${idx}: liquid not found on this machine`);
        continue;
      }
      const qty = validateQuantity(item.volumeMl, { minMl: l.minMl, maxMl: l.maxMl });
      if (qty) problems.push(`items.${idx} (${l.name}): ${qty}`);
      const issue = liquidIssue(l, item.volumeMl);
      if (issue) problems.push(`items.${idx} (${l.name}): ${issue}`);
    }
    const totalVolumeMl = dto.items.reduce((s, i) => s + i.volumeMl, 0);
    if (totalVolumeMl > this.config.ORDER_MAX_TOTAL_ML)
      problems.push(`Total volume ${totalVolumeMl} mL exceeds the ${this.config.ORDER_MAX_TOTAL_ML} mL limit`);
    if (problems.length) throw Errors.invalidOrder(problems);

    const priced = priceLines(dto.items.map((i) => ({ ...i, pricePerMl: byId.get(i.liquidId)!.pricePerMl })));
    const orderId = randomUUID();

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.order.create({
          data: {
            id: orderId,
            machineId: machine.id,
            totalVolumeMl,
            totalPrice: priced.total,
            currency: machine.currency,
            idempotencyKey,
            requestHash,
            paymentMode: this.config.PAYMENT_MODE,
            expiresAt: new Date(Date.now() + this.config.ORDER_CONFIRM_TTL_SEC * 1000),
            items: {
              create: priced.lines.map((line, position) => {
                const l = byId.get(line.liquidId)!;
                return {
                  position,
                  liquidId: l.id,
                  liquidName: l.name,
                  pumpChannel: l.pumpChannel,
                  unitPrice: line.unitPrice,
                  linePrice: line.linePrice,
                  requestedMl: line.volumeMl,
                };
              }),
            },
          },
        });
        // Atomic reservation: only one order (or calibration run) may hold the machine.
        const reserved = await tx.machine.updateMany({
          where: { id: machine.id, activeOrderId: null, activeCalibrationRunId: null, status: 'IN_SERVICE', estopActive: false },
          data: { activeOrderId: orderId },
        });
        if (reserved.count !== 1) throw Errors.machineBusy();
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = JSON.stringify(err.meta?.target ?? '');
        if (target.includes('idempotencyKey')) {
          const again = await this.replay(idempotencyKey, requestHash);
          if (again) return again;
        }
        // Partial unique index one_active_order_per_machine, or activeOrderId uniqueness.
        throw Errors.machineBusy();
      }
      throw err;
    }

    await this.audit.record({
      type: 'ORDER_CREATED',
      machineId: machine.id,
      orderId,
      payload: { items: dto.items, totalVolumeMl, totalPrice: priced.total.toFixed(2) },
    });
    return { status: HttpStatus.CREATED, body: { order: await this.views.get(orderId), orderToken: orderToken(this.config.ORDER_TOKEN_SECRET, orderId) } };
  }

  get(orderId: string): Promise<OrderView> {
    return this.views.get(orderId);
  }

  async confirm(orderId: string, token: string | undefined, testPaymentConfirmed: boolean | undefined): Promise<OrderView> {
    this.checkToken(orderId, token);
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw Errors.orderNotFound();

    if (order.status !== 'CREATED') {
      // Idempotent: a repeated confirm returns the current state.
      if (['AUTHORIZED', 'QUEUED', 'DISPENSING', 'COMPLETED'].includes(order.status)) return this.views.get(orderId);
      throw Errors.invalidTransition(order.status, 'AUTHORIZED');
    }
    if (order.expiresAt && order.expiresAt < new Date()) {
      await this.expire(orderId);
      throw Errors.conflict('ORDER_EXPIRED', 'Order expired before confirmation');
    }

    const mode = this.config.PAYMENT_MODE;
    if (mode === 'TEST_MODE' && testPaymentConfirmed !== true) throw Errors.paymentRequired();
    const payment =
      mode === 'TEST_MODE'
        ? { paymentStatus: 'TEST_CONFIRMED' as const, paymentReference: `TEST-${randomUUID()}` }
        : { paymentStatus: 'NOT_REQUIRED' as const, paymentReference: null };

    const won = await this.prisma.$transaction(async (tx) => {
      if (!(await this.repo.tryTransition(orderId, 'AUTHORIZED', { data: { ...payment, authorizedAt: new Date() } }, tx))) return false;
      await this.repo.transition(orderId, 'QUEUED', {}, tx);
      return true;
    });
    if (!won) {
      // Lost a race with a concurrent confirm/cancel.
      const view = await this.views.get(orderId);
      if (['AUTHORIZED', 'QUEUED', 'DISPENSING', 'COMPLETED'].includes(view.status)) return view;
      throw Errors.invalidTransition(view.status, 'AUTHORIZED');
    }

    await this.audit.record({
      type: 'ORDER_AUTHORIZED',
      machineId: order.machineId,
      orderId,
      payload: { paymentMode: mode, ...payment, note: 'No real payment is processed in this mode' },
    });
    await this.stream.publishSnapshot(orderId);
    this.dispensing.start(orderId);
    return this.views.get(orderId);
  }

  async cancel(orderId: string, token: string | undefined): Promise<{ status: HttpStatus; body: OrderView }> {
    this.checkToken(orderId, token);
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw Errors.orderNotFound();
    if (isTerminalStatus(order.status)) return { status: HttpStatus.OK, body: await this.views.get(orderId) };

    // No pump command is ever sent before DISPENSING, so these can end immediately.
    const immediate = await this.repo.tryTransition(orderId, 'CANCELLED', {
      from: ['CREATED', 'AUTHORIZED', 'QUEUED'],
      data: { failureReason: 'Cancelled by customer', cancelRequestedAt: new Date() },
    });
    if (immediate) {
      await this.audit.record({ type: 'ORDER_CANCELLED', machineId: order.machineId, orderId, payload: { from: order.status } });
      await this.stream.publishSnapshot(orderId);
      return { status: HttpStatus.OK, body: await this.views.get(orderId) };
    }

    // Dispensing: record the request; the runner stops the pump and only it may mark CANCELLED.
    const flagged = await this.prisma.order.updateMany({
      where: { id: orderId, status: 'DISPENSING', cancelRequestedAt: null },
      data: { cancelRequestedAt: new Date() },
    });
    if (flagged.count === 1) {
      await this.audit.record({ type: 'ORDER_CANCEL_REQUESTED', machineId: order.machineId, orderId });
      this.dispensing.requestCancel(orderId);
      await this.stream.publishSnapshot(orderId);
    }
    const view = await this.views.get(orderId);
    return { status: isTerminalStatus(view.status) ? HttpStatus.OK : HttpStatus.ACCEPTED, body: view };
  }

  /** Cancels CREATED orders whose confirmation window passed. Returns how many. */
  async expireStale(now = new Date()): Promise<number> {
    const stale = await this.prisma.order.findMany({ where: { status: 'CREATED', expiresAt: { lt: now } }, select: { id: true } });
    let n = 0;
    for (const { id } of stale) if (await this.expire(id)) n++;
    return n;
  }

  private async expire(orderId: string): Promise<boolean> {
    const done = await this.repo.tryTransition(orderId, 'CANCELLED', {
      from: ['CREATED'],
      data: { failureReason: 'Expired before confirmation' },
    });
    if (done) {
      await this.audit.record({ type: 'ORDER_EXPIRED', orderId });
      await this.stream.publishSnapshot(orderId);
    }
    return done;
  }

  private checkToken(orderId: string, token: string | undefined): void {
    if (!verifyOrderToken(this.config.ORDER_TOKEN_SECRET, orderId, token)) throw Errors.badOrderToken();
  }

  private async replay(key: string, requestHash: string): Promise<CreateResult | null> {
    const existing = await this.prisma.order.findUnique({ where: { idempotencyKey: key }, select: { id: true, requestHash: true } });
    if (!existing) return null;
    if (existing.requestHash !== requestHash) throw Errors.idempotencyConflict();
    return {
      status: HttpStatus.OK,
      body: { order: await this.views.get(existing.id), orderToken: orderToken(this.config.ORDER_TOKEN_SECRET, existing.id) },
    };
  }
}

function hashRequest(dto: CreateOrderDto): string {
  const normalized = {
    machineId: dto.machineId,
    items: dto.items.map((i) => ({ liquidId: i.liquidId, volumeMl: i.volumeMl })),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
