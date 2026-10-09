import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadConfig } from './config/config';
import { setupApp } from './setup-app';

const LEVELS = { debug: ['error', 'warn', 'log', 'debug'], log: ['error', 'warn', 'log'], warn: ['error', 'warn'], error: ['error'] } as const;

async function bootstrap(): Promise<void> {
  // Local development convenience; in containers the environment is injected.
  try {
    process.loadEnvFile('.env');
  } catch {
    /* no .env file */
  }
  // Fail fast on bad configuration before touching hardware or the DB.
  const config = loadConfig();
  const logger = new ConsoleLogger({ json: config.LOG_JSON, logLevels: [...LEVELS[config.LOG_LEVEL]] });
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  setupApp(app, config);
  await app.listen(config.PORT);
  logger.log(`PegPal API listening on :${config.PORT} (hardware=${config.HARDWARE_MODE}, payment=${config.PAYMENT_MODE})`, 'Bootstrap');
}

void bootstrap().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
