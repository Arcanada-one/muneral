// A2-304c: apps/api runs vitest (vitest.config.ts). This file is what is LEFT of the
// jest block that used to live in package.json, kept for exactly one consumer:
// test/assembly — the source suite of the mutation battery whose recorded outcomes
// (test/assembly/mutation-results.json) are bound to jest by construction. The reason
// is written out in vitest.config.ts next to the `exclude` that carves this suite out.
//
// Two runners is the honest state, not the target state. The card that regenerates the
// battery under vitest deletes this file.
export default {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  // Narrowed from ".*\\.spec\\.ts$": jest now owns only the battery's own suite.
  testRegex: 'test/assembly/.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json', useESM: true }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.module.ts', '!src/main.ts'],
  coverageDirectory: 'coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@muneral/types$': '<rootDir>/../../packages/types/dist/index.js',
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@nestjs/throttler$': '<rootDir>/test/support/throttler-test-double.ts',
  },
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
};
