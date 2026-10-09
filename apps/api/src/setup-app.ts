import { INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpExceptionFilter } from './common/http-exception.filter';
import type { AppConfig } from './config/config';

/** Shared by main.ts and the integration tests so both run the same pipeline. */
export function setupApp(app: INestApplication, config: AppConfig): void {
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // Never coerce "5" into 5 for bodies: types must be exact.
      transformOptions: { enableImplicitConversion: false },
      stopAtFirstError: false,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  const origins = config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (origins.length) app.enableCors({ origin: origins, credentials: false });
  app.enableShutdownHooks();
}
