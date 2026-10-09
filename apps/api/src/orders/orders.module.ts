import { Module } from '@nestjs/common';
import { DispensingModule } from '../dispensing/dispensing.module';
import { OrderExpiryService } from './order-expiry.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [DispensingModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderExpiryService],
  exports: [OrdersService],
})
export class OrdersModule {}
