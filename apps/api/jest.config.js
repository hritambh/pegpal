/** @type {import('jest').Config} */
const transform = { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] };
const moduleNameMapper = { '^@pegpal/shared$': '<rootDir>/../../packages/shared/src/index.ts' };

module.exports = {
  testTimeout: 30000,
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      rootDir: __dirname,
      testMatch: ['<rootDir>/src/**/*.spec.ts'],
      transform,
      moduleNameMapper,
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      rootDir: __dirname,
      testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
      transform,
      moduleNameMapper,
      globalSetup: '<rootDir>/test/global-setup.ts',
      setupFiles: ['<rootDir>/test/env.ts'],
    },
  ],
};
