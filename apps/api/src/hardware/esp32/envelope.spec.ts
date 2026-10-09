import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, parseEnvelope, seal, verify } from './envelope';

const secret = Buffer.from('test-secret-value', 'utf8');

describe('signed envelopes', () => {
  it('round-trips and verifies', () => {
    const env = seal('k_0123456789abcdef', secret, { type: 'STOP', seq: 3 });
    const parsed = parseEnvelope(JSON.stringify(env));
    expect(parsed).not.toBeNull();
    expect(verify(secret, parsed!)).toBe(true);
    expect(JSON.parse(parsed!.payload)).toEqual({ type: 'STOP', seq: 3 });
  });

  it('rejects tampered payloads', () => {
    const env = seal('k_x', secret, { type: 'DISPENSE', channel: 1, targetMl: 30 });
    const tampered = { ...env, payload: env.payload.replace('30', '300') };
    expect(verify(secret, tampered)).toBe(false);
  });

  it('rejects a different key', () => {
    const env = seal('k_x', secret, { a: 1 });
    expect(verify(Buffer.from('other'), env)).toBe(false);
  });

  it('rejects malformed envelopes', () => {
    expect(parseEnvelope('not json')).toBeNull();
    expect(parseEnvelope(JSON.stringify({ keyId: 'k', sig: 'zz', payload: '{}' }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ keyId: 'k', payload: '{}' }))).toBeNull();
  });
});

describe('secret encryption at rest', () => {
  const key = randomBytes(32);
  it('round-trips', () => {
    const sealed = encryptSecret(key, secret);
    expect(sealed).not.toContain('test-secret');
    expect(decryptSecret(key, sealed).toString()).toBe('test-secret-value');
  });
  it('fails with the wrong key', () => {
    expect(() => decryptSecret(randomBytes(32), encryptSecret(key, secret))).toThrow();
  });
});
