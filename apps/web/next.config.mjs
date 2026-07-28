import { fileURLToPath } from 'node:url';

/**
 * @type {import('next').NextConfig}
 */
const config = {
  // Emits a self-contained server bundle with only the files actually reached,
  // so the runtime image needs no node_modules and no pnpm. Without it the web
  // image would have to carry the whole workspace install.
  output: 'standalone',

  // The repository root, not apps/web. pnpm symlinks dependencies into a store
  // above the app, and standalone output traces through those symlinks — given
  // the wrong root it silently omits files that only fail once the container
  // runs.
  //
  // fileURLToPath, not `.pathname`: the latter yields `/C:/…/Tools%20Project/`
  // on Windows — leading slash, percent-encoded space — which Turbopack rejects
  // as escaping the project. It would have worked in CI, where the checkout
  // path has no spaces, and failed only on a developer machine.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),

  // A build must fail on a type error rather than shipping one.
  typescript: { ignoreBuildErrors: false },

  poweredByHeader: false,
};

export default config;
