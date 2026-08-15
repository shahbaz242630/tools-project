import { fileURLToPath } from 'node:url';

/**
 * The Content Security Policy, shipped in **report-only** mode.
 *
 * **Report-only is the decision, not a stepping stone somebody forgot to
 * finish.** This app loads Clerk's own script from `*.clerk.accounts.dev`, and
 * Next injects inline bootstrap scripts and inline styles of its own — so a
 * policy that is wrong in any of half a dozen small ways does not degrade the
 * page, it breaks sign-in for everybody. There is no browser in CI, so nothing
 * here would catch that: the first person to find out would be a user. Reported
 * first, enforced once a human has walked sign-up, sign-in, the account page and
 * a search with the console open and seen no violations.
 *
 * **`'unsafe-inline'` in `script-src` is why enforcing would buy less than it
 * looks like anyway.** Next's App Router emits inline scripts for hydration and
 * routing, and the way to allow those specifically is a per-request nonce
 * generated in middleware and threaded through — which is a real slice, in a
 * file this change does not own. Until then the policy's value is `frame-ancestors`,
 * `object-src`, `base-uri` and `form-action`, which are exact, plus a report of
 * what the page actually loads.
 *
 * **Every host named here is one we already depend on**, and the list is written
 * as tightly as it can honestly be while nobody has watched it in a browser:
 *
 * - `*.clerk.accounts.dev` — where a *development* Clerk instance serves
 *   `clerk.browser.js` and answers the frontend API. **A production instance
 *   serves both from `clerk.<our-domain>` instead**, so this list is incomplete
 *   the day a domain exists and the production Clerk instance is created
 *   (ADR 0015). That is the single most likely reason for this policy to be
 *   wrong later.
 * - `img.clerk.com` — avatars rendered by Clerk's own components.
 * - `challenges.cloudflare.com` — Turnstile, which Clerk loads into an iframe
 *   when bot protection is on. It is not on today; allowing it costs nothing and
 *   omitting it would make sign-up fail the moment somebody enables it.
 * - `clerk-telemetry.com` — Clerk's SDK telemetry beacon.
 *
 * Deliberately **not** listed: `'unsafe-eval'`, which `next dev` needs for hot
 * reload. A developer will see report-only violations from HMR on their own
 * machine; widening the policy so a development-only mechanism stops complaining
 * would weaken the thing production actually ships.
 *
 * The font is self-hosted — `next/font` downloads it at build time and serves it
 * from `/_next/static` — so `font-src 'self'` is complete and `fonts.gstatic.com`
 * is deliberately absent.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // Exact, and worth having even while the rest is advisory: these four cannot
  // be got wrong by a missing host, and three of them are what stops a
  // clickjacking frame, a rewritten <base> and a form posting somebody's input
  // to another origin.
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' https://*.clerk.accounts.dev https://challenges.cloudflare.com",
  // Clerk composes its appearance into inline styles (see lib/clerk-appearance),
  // and Next inlines critical CSS. Nonces would cover both and need middleware.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://img.clerk.com",
  "font-src 'self'",
  "connect-src 'self' https://*.clerk.accounts.dev https://clerk-telemetry.com",
  // Clerk runs its session refresh in a worker created from a blob URL.
  "worker-src 'self' blob:",
  "frame-src 'self' https://challenges.cloudflare.com",
].join('; ');

/**
 * Security headers for the one service a browser reaches.
 *
 * **They were on the wrong service until 15 August 2026.** `@fastify/helmet` is
 * registered on `apps/api`, which serves JSON to another container and whose CSP
 * no browser will ever evaluate; `apps/web`, which every visitor loads, set
 * `poweredByHeader: false` and nothing else. `infra/compose/Caddyfile` adds
 * `X-Content-Type-Options` and strips `Server`, and that was the whole of it.
 * Recorded as finding 2.2 in docs/SECURITY.md and required by BRD §10.
 *
 * **They are set here rather than at the ingress** for the reason the ingress
 * comment now gives: Caddy has never run, it does not front local development or
 * `next start`, and a control that only exists in the deployed path is a control
 * nobody can test. Set at the application, they travel with it.
 *
 * **HSTS carries `includeSubDomains` and deliberately not `preload`.** No domain
 * is registered yet, so this is a decision about a name nobody has bought — and
 * the two flags are not the same kind of commitment. `includeSubDomains` is
 * reversible: every host we plan to serve sits behind the same HTTPS edge
 * (ADR 0037), and if one ever cannot, serving a shorter `max-age` retires it on
 * each visitor's next request. `preload` is a one-way door — the list ships
 * inside browser binaries, removal is a request to somebody else measured in
 * months, and it would bind every subdomain of a domain whose layout we have not
 * chosen. That is exactly the shape of thing this project does not ship (see
 * slice 2.8d). A year of `max-age` is the usual floor for being taken seriously
 * and is what we can honour.
 *
 * Over plain HTTP the header is ignored by every browser, so it is harmless on
 * the localhost rehearsals and the SSH-tunnelled staging box in the meantime.
 *
 * **`Referrer-Policy` is `strict-origin-when-cross-origin` for a reason specific
 * to us**: our most-linked URL is `/browse?postcode=…`, and a full referrer would
 * hand somebody's postcode to every third-party host a page talks to. This sends
 * only the origin off-site and keeps the full path for our own navigations.
 *
 * `Permissions-Policy` denies the capabilities this product has no use for. It
 * is a list of what we do *not* do, so it needs revisiting when slice 2.6 adds
 * photographs — a camera capture flow would need `camera=(self)`.
 *
 * `X-Frame-Options` duplicates CSP's `frame-ancestors`, on purpose: the CSP is
 * report-only, so `frame-ancestors` is currently advice and this header is the
 * clickjacking control that actually enforces.
 */
const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy-Report-Only', value: CONTENT_SECURITY_POLICY },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
];

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

  /**
   * One entry, matching every path.
   *
   * `/:path*` matches the root as well as nested routes, and `headers()` is
   * evaluated before the filesystem, so it covers pages, route handlers and
   * anything served from `public/` alike. Splitting it per route would be a list
   * to keep in step with the app; there is no page here that wants a weaker
   * policy than another.
   */
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};

export default config;
