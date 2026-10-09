import { Injectable } from '@nestjs/common';
import type { AdminLiquidView, LiquidPublicView } from '@pegpal/shared';
import { Liquid, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateLiquidDto, UpdateLiquidDto } from './liquid.dto';

/** Why a liquid can't be dispensed right now, or null if it can. */
export function liquidIssue(l: Liquid, requestedMl?: number): string | null {
  if (!l.active) return 'Not available';
  if (l.flowRateMlPerSec === null) return 'Awaiting calibration';
  if (l.strategy === 'WEIGHT' && l.densityGPerMl === null) return 'Awaiting density measurement';
  if (l.remainingStockMl !== null && l.remainingStockMl < (requestedMl ?? l.minMl)) return 'Out of stock';
  return null;
}

@Injectable()
export class LiquidsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async publicList(machineId: string): Promise<LiquidPublicView[]> {
    const liquids = await this.prisma.liquid.findMany({ where: { machineId, active: true }, orderBy: { pumpChannel: 'asc' } });
    return liquids.map((l) => {
      const issue = liquidIssue(l);
      return {
        id: l.id,
        name: l.name,
        imageUrl: l.imageUrl,
        pricePerMl: l.pricePerMl.toFixed(4),
        minMl: l.minMl,
        maxMl: l.maxMl,
        available: issue === null,
        unavailableReason: issue,
      };
    });
  }

  async adminList(machineId: string): Promise<AdminLiquidView[]> {
    const liquids = await this.prisma.liquid.findMany({ where: { machineId }, orderBy: { pumpChannel: 'asc' } });
    return liquids.map(toAdminLiquidView);
  }

  async get(id: string): Promise<Liquid> {
    const l = await this.prisma.liquid.findUnique({ where: { id } });
    if (!l) throw Errors.liquidNotFound();
    return l;
  }

  async create(machineId: string, dto: CreateLiquidDto, actor: string): Promise<AdminLiquidView> {
    validateLimits(dto.minMl, dto.maxMl);
    const machine = await this.prisma.machine.findUnique({ where: { id: machineId } });
    if (!machine) throw Errors.machineNotFound();
    try {
      const l = await this.prisma.liquid.create({
        data: {
          machineId,
          name: dto.name,
          imageUrl: dto.imageUrl ?? null,
          pumpChannel: dto.pumpChannel,
          strategy: dto.strategy,
          densityGPerMl: dto.densityGPerMl ?? null,
          cutoffMarginG: dto.cutoffMarginG ?? 1,
          minMl: dto.minMl,
          maxMl: dto.maxMl,
          pricePerMl: new Prisma.Decimal(dto.pricePerMl),
          active: dto.active,
          remainingStockMl: dto.remainingStockMl ?? null,
        },
      });
      await this.audit.record({ type: 'LIQUID_CREATED', machineId, liquidId: l.id, pumpChannel: l.pumpChannel, actor, payload: dto });
      return toAdminLiquidView(l);
    } catch (err) {
      throw mapUniqueChannel(err);
    }
  }

  async update(id: string, dto: UpdateLiquidDto, actor: string): Promise<AdminLiquidView> {
    const current = await this.get(id);
    validateLimits(dto.minMl ?? current.minMl, dto.maxMl ?? current.maxMl);
    const machine = await this.prisma.machine.findUniqueOrThrow({ where: { id: current.machineId } });
    // Re-mapping a pump while it might be in use would make the running order's channel ambiguous.
    if (dto.pumpChannel !== undefined && dto.pumpChannel !== current.pumpChannel && (machine.activeOrderId || machine.activeCalibrationRunId))
      throw Errors.conflict('MACHINE_BUSY', 'Cannot change pump mapping while the machine is busy');
    try {
      const l = await this.prisma.liquid.update({
        where: { id },
        data: {
          ...dto,
          ...(dto.pricePerMl !== undefined ? { pricePerMl: new Prisma.Decimal(dto.pricePerMl) } : {}),
          // A different pump or liquid invalidates the old calibration.
          ...(dto.pumpChannel !== undefined && dto.pumpChannel !== current.pumpChannel
            ? { flowRateMlPerSec: null, calibratedAt: null, calibrationSimulated: false }
            : {}),
        },
      });
      await this.audit.record({ type: 'LIQUID_UPDATED', machineId: l.machineId, liquidId: l.id, pumpChannel: l.pumpChannel, actor, payload: dto });
      return toAdminLiquidView(l);
    } catch (err) {
      throw mapUniqueChannel(err);
    }
  }
}

function validateLimits(minMl: number, maxMl: number): void {
  if (minMl > maxMl) throw Errors.unprocessable('INVALID_LIMITS', 'minMl must not exceed maxMl');
}

function mapUniqueChannel(err: unknown): unknown {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
    return Errors.conflict('PUMP_CHANNEL_IN_USE', 'Another liquid is already mapped to that pump channel');
  return err;
}

export function toAdminLiquidView(l: Liquid): AdminLiquidView {
  return {
    id: l.id,
    machineId: l.machineId,
    name: l.name,
    imageUrl: l.imageUrl,
    pumpChannel: l.pumpChannel,
    strategy: l.strategy,
    densityGPerMl: l.densityGPerMl,
    flowRateMlPerSec: l.flowRateMlPerSec,
    cutoffMarginG: l.cutoffMarginG,
    calibratedAt: l.calibratedAt?.toISOString() ?? null,
    calibrationSimulated: l.calibrationSimulated,
    minMl: l.minMl,
    maxMl: l.maxMl,
    pricePerMl: l.pricePerMl.toFixed(4),
    active: l.active,
    remainingStockMl: l.remainingStockMl,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  };
}
