import { Module } from '@nestjs/common';
import { DispensingService } from './dispensing.service';
import { RecoveryService } from './recovery.service';

@Module({
  providers: [DispensingService, RecoveryService],
  exports: [DispensingService, RecoveryService],
})
export class DispensingModule {}
