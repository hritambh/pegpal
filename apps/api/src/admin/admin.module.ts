import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_CONFIG, AppConfig } from '../config/config';
import { LiquidsModule } from '../liquids/liquids.module';
import { MachinesModule } from '../machines/machines.module';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminController, CalibrationController, MockController } from './admin.controller';
import { AdminService } from './admin.service';
import { AuthController } from './auth.controller';
import { CalibrationService } from './calibration.service';

@Module({
  imports: [
    MachinesModule,
    LiquidsModule,
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        secret: config.ADMIN_JWT_SECRET,
        signOptions: { expiresIn: config.ADMIN_JWT_TTL_SEC, algorithm: 'HS256' },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController, AdminController, CalibrationController, MockController],
  providers: [AdminService, CalibrationService, AdminAuthGuard],
  exports: [CalibrationService],
})
export class AdminModule {}
