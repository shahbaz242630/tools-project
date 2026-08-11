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

  // Next 16.3 writes `AGENTS.md` and `CLAUDE.md` into this directory on every
  // `next dev` when it detects an agent, and Claude Code loads that `CLAUDE.md`
  // as project instructions automatically. Off, deliberately, on the product
  // owner's decision of 11 August 2026.
  //
  // **The objection is not the advice, which is good — it is who writes it and
  // when.** A dependency that generates agent instructions can change what they
  // say on any version bump, the new text lands on disk the next time somebody
  // runs the dev server rather than in the Dependabot diff, and it is read as
  // guidance before anybody notices it changed. Nothing in review would show it.
  // That fails the product owner's own rule that we do not ship what cannot be
  // undone or traced.
  //
  // **Its substance is kept rather than lost**: the warning that Next 16 differs
  // from what a model was trained on, and where its bundled docs live, is now in
  // the root `CLAUDE.md` in our own words — version controlled, reviewable, and
  // ours to correct. Turning this back on would give us two sources for the same
  // instruction, one of which we do not control.
  //
  // Gated on `agentRules !== false` in `start-server.js`, so `false` is the only
  // value that stops it; the default is true.
  agentRules: false,

  poweredByHeader: false,
};

export default config;
