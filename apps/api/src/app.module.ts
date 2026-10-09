import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { APP_CONFIG, AppConfig } from './config/config';
import { ConfigModule } from './config/config.module';
import { DispensingModule } from './dispensing/dispensing.module';
import { HardwareModule } from './hardware/hardware.module';
import { HealthModule } from './health/health.module';
import { LiquidsModule } from './liquids/liquids.module';
import { MachinesModule } from './machines/machines.module';
import { OrderStoreModule } from './orders/order-store.module';
import { OrdersModule } from './orders/orders.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule,
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => [{ name: 'default', ttl: 60_000, limit: config.RATE_LIMIT_PER_MIN }],
    }),
    PrismaModule,
    AuditModule,
    HardwareModule,
    OrderStoreModule,
    MachinesModule,
    LiquidsModule,
    DispensingModule,
    OrdersModule,
    AdminModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
