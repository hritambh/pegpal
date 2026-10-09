import { Controller, Get, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { HardwareMode } from '@pegpal/shared';
import type { Response } from 'express';
import { ControllerService } from '../hardware/controller.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly controller: ControllerService,
  ) {}

  @Get()
  async health(@Res({ passthrough: true }) res: Response): Promise<{ status: 'ok' | 'degraded'; db: boolean; hardwareMode: HardwareMode; uptimeSec: number }> {
    let db = false;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = true;
    } catch {
      db = false;
    }
    if (!db) res.status(503);
    return { status: db ? 'ok' : 'degraded', db, hardwareMode: this.controller.mode, uptimeSec: Math.round(process.uptime()) };
  }
}
