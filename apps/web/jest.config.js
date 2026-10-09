/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'commonjs', jsx: 'react-jsx', isolatedModules: true, esModuleInterop: true, strict: true, target: 'ES2022', types: ['node', 'jest'] } }],
  },
};
