import { Controller, Get, Param } from '@nestjs/common';
import type { LiquidPublicView } from '@pegpal/shared';
import { MachineIdParam } from '../common/params';
import { MachinesService } from '../machines/machines.service';
import { LiquidsService } from './liquids.service';

@Controller('machines')
export class LiquidsController {
  constructor(
    private readonly machines: MachinesService,
    private readonly liquids: LiquidsService,
  ) {}

  @Get(':machineId/liquids')
  async list(@Param() { machineId }: MachineIdParam): Promise<LiquidPublicView[]> {
    const machine = await this.machines.getByPublicId(machineId);
    return this.liquids.publicList(machine.id);
  }
}
