import { Injectable, Logger } from '@nestjs/common';
import { EventSeverity, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  type: string;
  severity?: EventSeverity;
  machineId?: string | null;
  orderId?: string | null;
  calibrationRunId?: string | null;
  pumpChannel?: number | null;
  liquidId?: string | null;
  payload?: unknown;
  actor?: string | null;
}

type Tx = Prisma.TransactionClient;

/**
 * Append-only audit trail (DispensingEvent) for commands, hardware events,
 * safety events and admin actions. Every entry is also logged.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: Tx): Promise<void> {
    const severity = entry.severity ?? 'INFO';
    const log = { msg: 'audit', ...entry, severity };
    if (severity === 'SAFETY') this.logger.warn(log);
    else this.logger.log(log);
    await (tx ?? this.prisma).dispensingEvent.create({
      data: {
        type: entry.type,
        severity,
        machineId: entry.machineId ?? null,
        orderId: entry.orderId ?? null,
        calibrationRunId: entry.calibrationRunId ?? null,
        pumpChannel: entry.pumpChannel ?? null,
        liquidId: entry.liquidId ?? null,
        payload: entry.payload ?? undefined,
        actor: entry.actor ?? null,
      },
    });
  }
}
