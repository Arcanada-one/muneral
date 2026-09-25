// A2-304c: apps/api moved from jest+ts-jest to vitest. Every option below replaces
// a named line of the old `jest` block in package.json — the mapping is in the PR.
import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [
    // NOT esbuild. Vitest's default TypeScript transform is esbuild, and esbuild
    // does not implement `emitDecoratorMetadata` (tsconfig.json sets it true).
    // Without that metadata Nest's injector reads no `design:paramtypes`, and every
    // `Test.createTestingModule` that lists a class provider dies with
    // "Nest can't resolve dependencies of the X (?)". swc does implement it.
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
      sourceMaps: true,
    }),
  ],
  test: {
    // jest `testEnvironment: "node"`.
    environment: 'node',
    // jest injected describe/it/expect/beforeEach as globals even under ESM; only
    // the `jest` object had to be imported. `globals: true` keeps all 85 files
    // reading the same way, so the diff is the `jest` -> `vi` rename and nothing else.
    globals: true,
    // jest `rootDir: "."` + `testRegex: ".*\\.spec\\.ts$"`, MINUS test/assembly.
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // test/assembly stays on jest, and that is a measurement, not a preference.
    // The 85 recorded outcomes in test/assembly/mutation-results.json are bound to
    // jest BY CONSTRUCTION, three ways:
    //   1. 9 of 85 are KILLED_BY_TYPECHECK — ts-jest refuses to compile a type-invalid
    //      mutant (mutation-harness.js:400). vitest transforms with swc, which STRIPS
    //      types without checking them, so those 9 mutants would come back SURVIVED.
    //   2. all 76 KILLED_BY_TEST details are jest reporter lines ("● SUITE › test")
    //      and the 9 others are ts-jest diagnostics; `detailSha256` binds every byte.
    //   3. `tools.jest: "29.7.0"` is re-checked against the installed jest by
    //      mutation-harness.js --verify-structure (:734).
    // Moving the battery therefore means regenerating all 85 outcomes under a runner
    // that kills differently — a change to the evidence itself, not to its runner.
    // That is its own card. `pnpm test` runs both suites; the total stays 1620.
    exclude: ['node_modules/**', 'dist/**', 'dist-test/**', 'test/assembly/**'],
    // jest `setupFiles`. Still FIRST: it imports reflect-metadata, without which
    // `Optional()`/`Inject()` silently no-op (see the file's own comment).
    setupFiles: ['./test/setup-env.ts'],
    // jest `--runInBand`. Not cosmetic: the e2e specs share ONE PostgreSQL database
    // and truncate tables between cases, so two files in parallel corrupt each other.
    fileParallelism: false,
    // jest applies `testTimeout` to hooks as well; vitest defaults hooks to 10s and
    // tests to 5s. Pinned to jest's 5s so a hook that got slower goes red here too.
    testTimeout: 5_000,
    hookTimeout: 5_000,
    // jest `collectCoverageFrom`.
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.module.ts', 'src/main.ts'],
      reportsDirectory: 'coverage',
    },
  },
  resolve: {
    alias: [
      // jest moduleNameMapper "^@muneral/types$". The BUILT entry point, as before:
      // the api compiles against packages/types/dist, and CI builds it before testing.
      { find: /^@muneral\/types$/, replacement: resolve(import.meta.dirname, '../../packages/types/dist/index.js') },
      // jest moduleNameMapper "^@nestjs/throttler$" -> the test double.
      { find: /^@nestjs\/throttler$/, replacement: resolve(import.meta.dirname, 'test/support/throttler-test-double.ts') },
      // jest moduleNameMapper "^(\\.{1,2}/.*)\\.js$" -> "$1". The sources are NodeNext
      // ESM, so they import each other as "./foo.js" while the file on disk is
      // "./foo.ts". Vite resolves that pair itself for TypeScript importers, so the
      // rule needs no alias here — recorded so the absence is a decision, not a gap.
    ],
  },
});
