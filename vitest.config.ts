import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  // Workspace packages resolve to TypeScript source during tests, so the suite
  // runs without a build step and a failure points at the line you edited
  // rather than at compiled output.
  //
  // The cost is that tests never exercise the built entry points -- which is
  // exactly how these packages came to be unloadable by a real Node process
  // while the suite stayed green. `pnpm verify:runtime` closes that gap and
  // runs in CI after the build.
  resolve: {
    alias: {
      '@platform/core': fromRoot('./packages/core/src/index.ts'),
      '@platform/config': fromRoot('./packages/config/src/index.ts'),
      '@platform/observability': fromRoot('./packages/observability/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    // Timezone-sensitive assertions pin their zone explicitly with luxon rather
    // than depending on the machine's, so CI and a developer laptop agree
    // without TZ being set here.
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
