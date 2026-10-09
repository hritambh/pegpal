import type { SignedEnvelope } from '@pegpal/shared';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sign(secret: Buffer, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

export function seal(keyId: string, secret: Buffer, message: unknown): SignedEnvelope {
  const payload = JSON.stringify(message);
  return { keyId, sig: sign(secret, payload), payload };
}

export function parseEnvelope(raw: Buffer | string): SignedEnvelope | null {
  try {
    const obj = JSON.parse(raw.toString()) as Partial<SignedEnvelope>;
    if (typeof obj.keyId !== 'string' || typeof obj.sig !== 'string' || typeof obj.payload !== 'string') return null;
    if (!/^[0-9a-f]{64}$/.test(obj.sig)) return null;
    return obj as SignedEnvelope;
  } catch {
    return null;
  }
}

/** Constant-time signature check over the exact payload bytes received. */
export function verify(secret: Buffer, envelope: SignedEnvelope): boolean {
  const expected = Buffer.from(sign(secret, envelope.payload), 'hex');
  const actual = Buffer.from(envelope.sig, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** AES-256-GCM for machine secrets at rest. Format: iv.tag.ciphertext (base64). */
export function encryptSecret(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}

export function decryptSecret(key: Buffer, sealed: string): Buffer {
  const [iv, tag, ct] = sealed.split('.').map((p) => Buffer.from(p, 'base64'));
  if (!iv || !tag || !ct) throw new Error('Malformed encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
