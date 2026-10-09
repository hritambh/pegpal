import { loadConfig } from './config';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  ADMIN_USERNAME: 'operator',
  ADMIN_PASSWORD_HASH: 'scrypt$c2FsdA==$aGFzaA==',
  ADMIN_JWT_SECRET: 'a'.repeat(40),
  ORDER_TOKEN_SECRET: 'b'.repeat(40),
  MACHINE_SECRET_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
};

describe('loadConfig', () => {
  it('defaults to mock hardware and test payments', () => {
    const c = loadConfig(valid);
    expect(c.HARDWARE_MODE).toBe('mock');
    expect(c.PAYMENT_MODE).toBe('TEST_MODE');
  });

  it('requires the explicit ESP32 feature flag and TLS', () => {
    expect(() => loadConfig({ ...valid, HARDWARE_MODE: 'esp32', MQTT_URL: 'mqtts://broker:8883' })).toThrow(/ENABLE_ESP32_ADAPTER/);
    expect(() => loadConfig({ ...valid, HARDWARE_MODE: 'esp32', ENABLE_ESP32_ADAPTER: 'true', MQTT_URL: 'mqtt://broker' })).toThrow(/mqtts/);
    expect(loadConfig({ ...valid, HARDWARE_MODE: 'esp32', ENABLE_ESP32_ADAPTER: 'true', MQTT_URL: 'mqtts://b:8883' }).HARDWARE_MODE).toBe('esp32');
  });

  it('refuses to run unpaid in production without an explicit override', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production' })).toThrow(/ALLOW_UNPAID_DISPENSING/);
    expect(loadConfig({ ...valid, NODE_ENV: 'production', ALLOW_UNPAID_DISPENSING: 'true' }).NODE_ENV).toBe('production');
  });

  it('rejects placeholder secrets in production', () => {
    expect(() =>
      loadConfig({ ...valid, NODE_ENV: 'production', ALLOW_UNPAID_DISPENSING: 'true', ADMIN_JWT_SECRET: `change-me-${'x'.repeat(30)}` }),
    ).toThrow(/placeholder/);
  });

  it('rejects short secrets and bad encryption keys', () => {
    expect(() => loadConfig({ ...valid, ADMIN_JWT_SECRET: 'short' })).toThrow();
    expect(() => loadConfig({ ...valid, MACHINE_SECRET_ENCRYPTION_KEY: 'abc' })).toThrow(/32 bytes/);
  });
});
