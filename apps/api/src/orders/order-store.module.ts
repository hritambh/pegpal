import { Global, Module } from '@nestjs/common';
import { OrderStreamService } from './order-stream.service';
import { OrderViewsService } from './order-views.service';
import { OrdersRepository } from './orders.repository';

/** Order persistence + live views, shared by OrdersModule, DispensingModule and AdminModule. */
@Global()
@Module({
  providers: [OrdersRepository, OrderViewsService, OrderStreamService],
  exports: [OrdersRepository, OrderViewsService, OrderStreamService],
})
export class OrderStoreModule {}
