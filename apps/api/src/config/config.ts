import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);
const num = (def: number, min = 0) => z.coerce.number().min(min).default(def);

const DEV_PLACEHOLDER = 'change-me';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: int(3001, 1),
    LOG_LEVEL: z.enum(['debug', 'log', 'warn', 'error']).default('log'),
    LOG_JSON: bool,
    CORS_ORIGINS: z.string().default(''),
    DATABASE_URL: z.string().url(),

    HARDWARE_MODE: z.enum(['mock', 'esp32']).default('mock'),
    /** Second, explicit switch so a single typo can't drive real pumps. */
    ENABLE_ESP32_ADAPTER: bool,
    /** Controller has a load cell fitted; enables tare + mass evidence for TIMED liquids too. */
    SCALE_FITTED: bool,

    PAYMENT_MODE: z.enum(['TEST_MODE', 'PAYMENT_DISABLED']).default('TEST_MODE'),
    ALLOW_UNPAID_DISPENSING: bool,

    ADMIN_USERNAME: z.string().min(3),
    /** scrypt$<saltB64>$<hashB64>; generate with `bun run --cwd apps/api hash-password`. */
    ADMIN_PASSWORD_HASH: z.string().regex(/^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/, 'must be scrypt$salt$hash'),
    ADMIN_JWT_SECRET: z.string().min(32),
    ADMIN_JWT_TTL_SEC: int(3600, 60),
    ORDER_TOKEN_SECRET: z.string().min(32),
    /** 32 bytes, base64. Encrypts machine HMAC secrets at rest. */
    MACHINE_SECRET_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes base64-encoded'),

    ORDER_MAX_TOTAL_ML: int(400, 1),
    ORDER_MAX_ITEMS: int(10, 1),
    ORDER_CONFIRM_TTL_SEC: int(300, 10),
    ORDER_MAX_DURATION_MS: int(300_000, 1000),
    PUMP_MAX_RUNTIME_MS: int(60_000, 100),
    RUNTIME_SAFETY_FACTOR: num(1.5, 1),
    RUNTIME_ALLOWANCE_MS: int(1500),
    ACK_TIMEOUT_MS: int(1500, 10),
    ACK_RETRIES: int(3),
    COMPLETION_GRACE_MS: int(3000, 10),
    STOP_CONFIRM_TIMEOUT_MS: int(5000, 10),
    TARE_TIMEOUT_MS: int(8000, 10),
    CALIBRATION_MAX_RUNTIME_MS: int(30_000, 100),
    /** Mass evidence is rejected if it differs from the expectation by more than this. */
    MASS_PLAUSIBILITY_PCT: num(35, 1),
    STATUS_FRESH_MS: int(30_000, 100),
    RATE_LIMIT_PER_MIN: int(120, 1),
    EXPIRY_SWEEP_MS: int(5000, 50),

    MQTT_URL: z.string().optional(),
    MQTT_USERNAME: z.string().optional(),
    MQTT_PASSWORD: z.string().optional(),
    MQTT_CA_FILE: z.string().optional(),
    HEARTBEAT_TIMEOUT_MS: int(30_000, 1000),

    /** >1 makes the simulator run faster than real time (used by tests). */
    MOCK_TIME_SCALE: num(1, 0.001),
    MOCK_TICK_MS: int(100, 5),
    MOCK_FW_MAX_RUNTIME_MS: int(60_000, 100),
  })
  .superRefine((c, ctx) => {
    if (c.HARDWARE_MODE === 'esp32') {
      if (!c.ENABLE_ESP32_ADAPTER)
        ctx.addIssue({ code: 'custom', message: 'HARDWARE_MODE=esp32 also requires ENABLE_ESP32_ADAPTER=true' });
      if (!c.MQTT_URL?.startsWith('mqtts://'))
        ctx.addIssue({ code: 'custom', message: 'HARDWARE_MODE=esp32 requires MQTT_URL with mqtts:// (TLS)' });
    }
    if (c.NODE_ENV === 'production') {
      if (!c.ALLOW_UNPAID_DISPENSING)
        ctx.addIssue({
          code: 'custom',
          message: `PAYMENT_MODE=${c.PAYMENT_MODE} takes no real payment; refusing to start in production without ALLOW_UNPAID_DISPENSING=true (controlled internal testing only)`,
        });
      for (const key of ['ADMIN_JWT_SECRET', 'ORDER_TOKEN_SECRET'] as const) {
        if (c[key].includes(DEV_PLACEHOLDER)) ctx.addIssue({ code: 'custom', message: `${key} still has a placeholder value` });
      }
    }
  });

export type AppConfig = z.infer<typeof schema>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'config'}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
