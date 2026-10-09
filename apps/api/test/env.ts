/* Integration-test environment: dedicated database and a fast simulator. Self-contained (no .env needed). */
import { hashPassword } from '../src/admin/password';

const base = process.env.TEST_DATABASE_URL ?? 'postgresql://pegpal:pegpal_dev_only@localhost:5433/pegpal_test?schema=public';
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: base,
  HARDWARE_MODE: 'mock',
  ENABLE_ESP32_ADAPTER: 'false',
  PAYMENT_MODE: 'TEST_MODE',
  SCALE_FITTED: 'false',
  LOG_LEVEL: 'error',
  ADMIN_USERNAME: 'operator',
  ADMIN_PASSWORD_HASH: hashPassword('pegpal-dev-password'),
  ADMIN_JWT_SECRET: 'test-jwt-secret-test-jwt-secret-test-jwt-secret',
  ORDER_TOKEN_SECRET: 'test-order-token-secret-test-order-token-secret',
  MACHINE_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  MOCK_TIME_SCALE: '20',
  MOCK_TICK_MS: '10',
  ACK_TIMEOUT_MS: '150',
  ACK_RETRIES: '1',
  COMPLETION_GRACE_MS: '400',
  STOP_CONFIRM_TIMEOUT_MS: '800',
  TARE_TIMEOUT_MS: '500',
  RATE_LIMIT_PER_MIN: '10000',
  EXPIRY_SWEEP_MS: '60000',
  ORDER_CONFIRM_TTL_SEC: '300',
  ORDER_MAX_TOTAL_ML: '150',
});
