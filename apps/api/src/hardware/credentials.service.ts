import { Inject, Injectable } from '@nestjs/common';
import type { IssuedMachineCredential, MachineCredentialView, SignedEnvelope } from '@pegpal/shared';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret, encryptSecret, verify } from './esp32/envelope';

export interface SigningKey {
  keyId: string;
  secret: Buffer;
}

/**
 * Per-machine HMAC keys for the controller protocol. Secrets are encrypted at
 * rest, shown once on issue, and can be revoked at any time.
 */
@Injectable()
export class CredentialsService {
  private readonly encKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.encKey = Buffer.from(config.MACHINE_SECRET_ENCRYPTION_KEY, 'base64');
  }

  async issue(machineId: string, actor: string): Promise<IssuedMachineCredential> {
    const machine = await this.prisma.machine.findUnique({ where: { id: machineId } });
    if (!machine) throw Errors.machineNotFound();
    const keyId = `k_${randomBytes(8).toString('hex')}`;
    const secret = randomBytes(32).toString('base64url');
    await this.prisma.machineCredential.create({
      data: { machineId, keyId, secretEncrypted: encryptSecret(this.encKey, Buffer.from(secret, 'utf8')) },
    });
    await this.audit.record({ type: 'CREDENTIAL_ISSUED', severity: 'WARN', machineId, actor, payload: { keyId } });
    return { keyId, secret };
  }

  async revoke(keyId: string, actor: string): Promise<MachineCredentialView> {
    const cred = await this.prisma.machineCredential.findUnique({ where: { keyId } });
    if (!cred) throw Errors.notFound('CREDENTIAL_NOT_FOUND', 'Credential not found');
    const updated = cred.revokedAt
      ? cred
      : await this.prisma.machineCredential.update({ where: { keyId }, data: { revokedAt: new Date() } });
    await this.audit.record({ type: 'CREDENTIAL_REVOKED', severity: 'WARN', machineId: cred.machineId, actor, payload: { keyId } });
    return toView(updated);
  }

  async list(machineId: string): Promise<MachineCredentialView[]> {
    const creds = await this.prisma.machineCredential.findMany({ where: { machineId }, orderBy: { createdAt: 'desc' } });
    return creds.map(toView);
  }

  /** Newest non-revoked key, used to sign outgoing commands. */
  async signingKeyFor(machinePublicId: string): Promise<SigningKey | null> {
    const cred = await this.prisma.machineCredential.findFirst({
      where: { revokedAt: null, machine: { publicId: machinePublicId } },
      orderBy: { createdAt: 'desc' },
    });
    return cred ? { keyId: cred.keyId, secret: decryptSecret(this.encKey, cred.secretEncrypted) } : null;
  }

  /**
   * Verifies an incoming envelope. Returns the machine's public id when the key
   * is valid, not revoked, belongs to that machine, and deviceSeq advanced.
   */
  async verifyIncoming(
    envelope: SignedEnvelope,
    claimedMachinePublicId: string,
    deviceSeq: (payload: string) => number | null,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const cred = await this.prisma.machineCredential.findUnique({
      where: { keyId: envelope.keyId },
      include: { machine: { select: { publicId: true } } },
    });
    if (!cred) return { ok: false, reason: 'unknown keyId' };
    if (cred.revokedAt) return { ok: false, reason: 'revoked keyId' };
    if (cred.machine.publicId !== claimedMachinePublicId) return { ok: false, reason: 'key belongs to another machine' };
    if (!verify(decryptSecret(this.encKey, cred.secretEncrypted), envelope)) return { ok: false, reason: 'bad signature' };
    const seq = deviceSeq(envelope.payload);
    if (seq === null) return { ok: false, reason: 'missing deviceSeq' };
    // Atomic replay guard: only advance if strictly greater.
    const advanced = await this.prisma.machineCredential.updateMany({
      where: { id: cred.id, lastDeviceSeq: { lt: seq } },
      data: { lastDeviceSeq: seq, lastUsedAt: new Date() },
    });
    if (advanced.count === 0) return { ok: false, reason: 'replayed or stale deviceSeq' };
    return { ok: true };
  }
}

function toView(c: { keyId: string; createdAt: Date; revokedAt: Date | null; lastUsedAt: Date | null }): MachineCredentialView {
  return {
    keyId: c.keyId,
    createdAt: c.createdAt.toISOString(),
    revokedAt: c.revokedAt?.toISOString() ?? null,
    lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
  };
}
