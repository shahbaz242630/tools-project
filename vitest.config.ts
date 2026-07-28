import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const fromRoot = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

/** Tests that talk to a live Redis, by naming convention. */
const REQUIRES_REDIS = ['**/*.redis.test.ts'];

export default defineConfig({
  // Workspace packages resolve to TypeScript source during tests, so the suite
  // runs without a build step and a failure points at the line you edited
  // rather than at compiled output.
  //
  // The cost is that tests never exercise the built entry points -- which is
  // exactly how these packages came to be unloadable by a real Node process
  // while the suite stayed green. `pnpm verify:runtime` closes that gap and
  // runs in CI after the build. See ADR 0010.
  resolve: {
    alias: {
      '@platform/core': fromRoot('./packages/core/src/index.ts'),
      '@platform/config': fromRoot('./packages/config/src/index.ts'),
      // Longest specifier first: an exact-match alias for the bare package
      // would otherwise never be reached for the subpath.
      '@platform/observability/testing': fromRoot(
        './packages/observability/src/testing/index.ts',
      ),
      '@platform/observability': fromRoot('./packages/observability/src/index.ts'),
      '@platform/runtime': fromRoot('./packages/runtime/src/index.ts'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'packages',
          include: ['packages/*/src/**/*.test.ts'],
          exclude: REQUIRES_REDIS,
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'worker',
          include: ['apps/worker/src/**/*.test.ts'],
          exclude: REQUIRES_REDIS,
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'scripts',
          // Plain .mjs: `scripts/` runs under a bare `node` with no build step,
          // so the tests load exactly the files the deploy path loads.
          include: ['scripts/**/*.test.mjs'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          // Needs a live Redis, so it is not in the default run. `pnpm test`
          // names its projects explicitly rather than excluding this one --
          // a new project must be opted in, and forgetting shows up as tests
          // that visibly do not run rather than as silent coverage loss.
          include: REQUIRES_REDIS,
          environment: 'node',
        },
      },
      {
        extends: true,
        // esbuild, vitest's default transform, silently discards decorator
        // metadata. NestJS resolves constructor dependencies from exactly that
        // metadata, so without swc every injected dependency arrives as
        // `undefined` and the failure surfaces as a 500 at request time rather
        // than as a compile error. See ADR 0011.
        plugins: [
          swc.vite({
            module: { type: 'nodenext' },
            jsc: {
              target: 'es2023',
              parser: { syntax: 'typescript', decorators: true },
              transform: { legacyDecorator: true, decoratorMetadata: true },
            },
          }),
        ],
        test: {
          name: 'api',
          include: ['apps/api/src/**/*.test.ts'],
          exclude: REQUIRES_REDIS,
          environment: 'node',
        },
      },
    ],
    // Timezone-sensitive assertions pin their zone explicitly with luxon rather
    // than depending on the machine's, so CI and a developer laptop agree
    // without TZ being set here.
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        // Composition root. Asserting its wiring by mocking every constructor
        // would test the mocks; the integration test boots the real app instead.
        '**/main.ts',
        // Test doubles, exercised by the tests that use them.
        '**/testing/**',
        // Constructing a BullMQ Worker opens a Redis connection, so this file
        // cannot be reached without a live broker. Its routing and correlation
        // logic lives in processor.ts and is unit tested; what remains here is
        // construction and two log callbacks, covered by *.redis.test.ts in the
        // integration project. Keep this exclusion narrow — logic that moves
        // back into this file stops being counted.
        '**/worker/src/worker.ts',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
