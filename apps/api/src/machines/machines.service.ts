import { Inject, Injectable } from '@nestjs/common';
import type { AdminMachineView, MachinePublicView } from '@pegpal/shared';
import type { Machine } from '@prisma/client';
import { Errors } from '../common/errors';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { machineAvailability } from './availability';

@Injectable()
export class MachinesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async getByPublicId(publicId: string): Promise<Machine> {
    const machine = await this.prisma.machine.findUnique({ where: { publicId } });
    if (!machine) throw Errors.machineNotFound();
    return machine;
  }

  async getById(id: string): Promise<Machine> {
    const machine = await this.prisma.machine.findUnique({ where: { id } });
    if (!machine) throw Errors.machineNotFound();
    return machine;
  }

  toPublicView(m: Machine): MachinePublicView {
    return {
      id: m.publicId,
      name: m.name,
      availability: machineAvailability(m),
      currency: m.currency,
      paymentMode: this.config.PAYMENT_MODE,
      limits: { maxTotalMl: this.config.ORDER_MAX_TOTAL_ML, maxItems: this.config.ORDER_MAX_ITEMS },
    };
  }

  toAdminView(m: Machine): AdminMachineView {
    return {
      id: m.id,
      publicId: m.publicId,
      name: m.name,
      status: m.status,
      availability: machineAvailability(m),
      hardwareConnection: m.hardwareConnection,
      estopActive: m.estopActive,
      faultReason: m.faultReason,
      activeOrderId: m.activeOrderId,
      activeCalibrationRunId: m.activeCalibrationRunId,
      lastSeenAt: m.lastSeenAt?.toISOString() ?? null,
      currency: m.currency,
    };
  }
}
