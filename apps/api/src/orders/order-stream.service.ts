import { Injectable, Logger } from '@nestjs/common';
import type { OrderStreamMessage } from '@pegpal/shared';
import { isTerminalStatus } from '@pegpal/shared';
import { Observable, Subject, concat, defer, filter, from, map, takeWhile } from 'rxjs';
import { OrderViewsService } from './order-views.service';

interface Envelope {
  orderId: string;
  message: OrderStreamMessage;
}

/** In-process pub/sub for live order updates (SSE). Single backend instance assumed. */
@Injectable()
export class OrderStreamService {
  private readonly logger = new Logger('OrderStream');
  private readonly bus = new Subject<Envelope>();

  constructor(private readonly views: OrderViewsService) {}

  async publishSnapshot(orderId: string): Promise<void> {
    try {
      const order = await this.views.get(orderId);
      this.bus.next({ orderId, message: { type: 'snapshot', order } });
    } catch (err) {
      this.logger.warn({ msg: 'Snapshot publish failed', orderId, err: String(err) });
    }
  }

  publishProgress(orderId: string, itemId: string, progressMl: number | null, massG: number | null, simulated: boolean): void {
    this.views.setProgress(itemId, { progressMl, massG });
    this.bus.next({ orderId, message: { type: 'progress', orderId, itemId, progressMl, massG, simulated } });
  }

  /** Initial snapshot, then live updates; completes after a terminal snapshot. */
  stream(orderId: string): Observable<OrderStreamMessage> {
    const live = this.bus.pipe(
      filter((e) => e.orderId === orderId),
      map((e) => e.message),
    );
    const initial = defer(() => from(this.views.get(orderId).then((order): OrderStreamMessage => ({ type: 'snapshot', order }))));
    return concat(initial, live).pipe(
      takeWhile((m) => !(m.type === 'snapshot' && isTerminalStatus(m.order.status)), true),
    );
  }
}
