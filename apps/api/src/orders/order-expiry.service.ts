import { Inject, Injectable, Logger, OnApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { OrdersService } from './orders.service';

/** Releases machines held by orders that were never confirmed. */
@Injectable()
export class OrderExpiryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('OrderExpiry');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly orders: OrdersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.sweep(), this.config.EXPIRY_SWEEP_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const n = await this.orders.expireStale();
      if (n) this.logger.log({ msg: 'Expired unconfirmed orders', count: n });
    } catch (err) {
      this.logger.error({ msg: 'Expiry sweep failed', err: String(err) });
    } finally {
      this.running = false;
    }
  }
}
