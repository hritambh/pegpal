import { execSync } from 'node:child_process';

/** Applies migrations to the dedicated test database once per run. */
export default function globalSetup(): void {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://pegpal:pegpal_dev_only@localhost:5433/pegpal_test?schema=public';
  execSync('bunx prisma migrate deploy', { cwd: `${__dirname}/..`, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
}
