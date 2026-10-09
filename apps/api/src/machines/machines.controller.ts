import { Controller, Get, Param } from '@nestjs/common';
import type { MachinePublicView } from '@pegpal/shared';
import { MachineIdParam } from '../common/params';
import { MachinesService } from './machines.service';

@Controller('machines')
export class MachinesController {
  constructor(private readonly machines: MachinesService) {}

  @Get(':machineId')
  async get(@Param() { machineId }: MachineIdParam): Promise<MachinePublicView> {
    return this.machines.toPublicView(await this.machines.getByPublicId(machineId));
  }
}
