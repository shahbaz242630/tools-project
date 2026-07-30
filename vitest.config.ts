import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const fromRoot = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

/**
 * Tests that need a live service, by naming convention. Kept out of the default
 * run so `pnpm test` needs nothing running; `pnpm test:integration` opts in.
 */
const REQUIRES_SERVICES = ['**/*.redis.test.ts', '**/*.db.test.ts'];

// Connection details for those services live in `.env` on a developer machine.
// CI sets them directly as job environment, so an absent file is normal rather
// than an error — and swallowing the failure here is safe because the tests
// that need the values fail loudly and by name if they are missing.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env: CI, or a machine that has not run `pnpm db:up` yet.
}

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
      '@platform/contracts': fromRoot('./packages/contracts/src/index.ts'),
      '@platform/database': fromRoot('./packages/database/src/index.ts'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'packages',
          include: ['packages/*/src/**/*.test.ts'],
          exclude: REQUIRES_SERVICES,
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'worker',
          include: ['apps/worker/src/**/*.test.ts'],
          exclude: REQUIRES_SERVICES,
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          include: ['apps/web/src/**/*.test.{ts,tsx}'],
          // React components need a DOM. Only this project pays for it — the
          // others stay on `node`, which is markedly faster.
          environment: 'jsdom',
          setupFiles: ['./apps/web/vitest-setup.ts'],
        },
        // esbuild handles the JSX, so no @vitejs/plugin-react. That plugin
        // requires vite 8 and vitest 3 pins vite 7; adding it would mean an
        // unmet peer dependency for a transform we do not need. The app's own
        // tsconfig says `jsx: preserve` because Next requires it, which esbuild
        // cannot emit — hence the override here rather than there.
        esbuild: { jsx: 'automatic' },
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
          // Needs a live Redis or Postgres, so it is not in the default run.
          // `pnpm test`
          // names its projects explicitly rather than excluding this one --
          // a new project must be opted in, and forgetting shows up as tests
          // that visibly do not run rather than as silent coverage loss.
          include: REQUIRES_SERVICES,
          environment: 'node',

          // These files must not run in parallel with each other. They share
          // one database and each truncates in `beforeEach` to start from a
          // known state, so concurrently they delete each other's rows
          // mid-test — which surfaces as a row that vanished between being
          // written and being read, a failure indistinguishable from a bug in
          // the code under test.
          //
          // **`fileParallelism` is a root-level option and is silently ignored
          // here**, which is why it is not set in this block: it looks like it
          // works, and does nothing. The flag lives on the `test:integration`
          // script in package.json instead, so it applies to this project
          // without making the fast unit projects sequential too.
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
          exclude: REQUIRES_SERVICES,
          environment: 'node',
        },
      },
    ],
    // Timezone-sensitive assertions pin their zone explicitly with luxon rather
    // than depending on the machine's, so CI and a developer laptop agree
    // without TZ being set here.
    coverage: {
      provider: 'v8',
      // .tsx as well as .ts. A `**/*.ts` glob does not match `.tsx`, so without
      // this every React component is invisible to the thresholds — its tests
      // could be deleted and coverage would not move.
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts', 'apps/*/src/**/*.tsx'],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/index.ts',
        // Machine-written by `prisma generate`. Holding generated code to a
        // coverage threshold measures Prisma, not us.
        '**/generated/**',
        // App Router pages and layouts are composition roots, the same argument
        // as main.ts below: they wire a component to a data source and a route.
        // Testing them by mocking the framework would test the mocks, and they
        // are loaded for real by the Deploy rehearsal job, which asserts on the
        // rendered HTML. Presentational components live outside app/ and are
        // counted.
        '**/web/src/app/**',
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
        // Same argument as worker.ts: exercised in full by
        // prisma-identity-store.db.test.ts, which lives in the `integration`
        // project and so does not run under this command. Its whole purpose is
        // behaviour that only a real unique constraint produces, which is
        // exactly what cannot be covered here. Keep this exclusion narrow —
        // logic that moves out of this file stops being counted.
        '**/api/src/identity/prisma-identity-store.ts',
        // Declaration-only: two interfaces and nothing else, so it emits no
        // executable JavaScript at all and v8 reports its source lines as
        // uncovered because there is nothing to run. If any code appears in
        // here, delete this line rather than keeping it honest by accident.
        '**/api/src/identity/webhook-ledger.ts',
        // Composition root, same argument as main.ts: it hands a matcher to
        // Clerk's middleware factory. A test would assert that a mock was
        // called with a regex we also wrote.
        '**/web/src/proxy.ts',
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
