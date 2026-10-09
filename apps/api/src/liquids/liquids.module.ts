import { Module } from '@nestjs/common';
import { MachinesModule } from '../machines/machines.module';
import { LiquidsController } from './liquids.controller';
import { LiquidsService } from './liquids.service';

@Module({
  imports: [MachinesModule],
  controllers: [LiquidsController],
  providers: [LiquidsService],
  exports: [LiquidsService],
})
export class LiquidsModule {}
