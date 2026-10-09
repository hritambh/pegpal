import { Body, Controller, Get, Headers, HttpCode, MessageEvent, Param, Post, Res, Sse } from '@nestjs/common';
import type { CreateOrderResponse, OrderView } from '@pegpal/shared';
import type { Response } from 'express';
import { Observable, map } from 'rxjs';
import { OrderIdParam } from '../common/params';
import { ConfirmOrderDto, CreateOrderDto } from './order.dto';
import { OrderStreamService } from './order-stream.service';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly stream: OrderStreamService,
  ) {}

  @Post()
  async create(
    @Body() dto: CreateOrderDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CreateOrderResponse> {
    const result = await this.orders.create(dto, key);
    res.status(result.status);
    return result.body;
  }

  @Get(':orderId')
  get(@Param() { orderId }: OrderIdParam): Promise<OrderView> {
    return this.orders.get(orderId);
  }

  @Post(':orderId/confirm')
  @HttpCode(200)
  confirm(
    @Param() { orderId }: OrderIdParam,
    @Headers('x-order-token') token: string | undefined,
    @Body() dto: ConfirmOrderDto,
  ): Promise<OrderView> {
    return this.orders.confirm(orderId, token, dto.testPaymentConfirmed);
  }

  @Post(':orderId/cancel')
  async cancel(
    @Param() { orderId }: OrderIdParam,
    @Headers('x-order-token') token: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderView> {
    const result = await this.orders.cancel(orderId, token);
    res.status(result.status);
    return result.body;
  }

  @Sse(':orderId/events')
  events(@Param() { orderId }: OrderIdParam, @Res({ passthrough: true }) res: Response): Observable<MessageEvent> {
    // Defeat proxy buffering so progress arrives promptly.
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    return this.stream.stream(orderId).pipe(map((data) => ({ data })));
  }
}
