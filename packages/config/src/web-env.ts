/**
 * Environment for the web application.
 *
 * A separate schema from `loadEnv`, not a relaxation of it. The API's schema
 * requires database and Redis credentials; the web app has neither and must
 * never be given them — it is the one process reachable from a browser, so
 * anything it can read is one bug away from being served to someone.
 *
 * It lives here rather than in `apps/web` because environment access goes
 * through one validated place (ADR 0006), and the invariant checker enforces
 * that by banning `process.env` everywhere else.
 */

import { z } from 'zod';
import { EnvironmentError } from './env.js';
import type { EnvSource } from './env.js';

/**
 * Total, never throwing.
 *
 * Zod 4 runs a `.refine` even when the preceding `.url()` check has already
 * failed, so a predicate that assumed a parseable URL would throw a raw
 * `TypeError` out of `loadWebEnv` — losing the collected list of problems that
 * is the whole point of validating here.
 */
function isHttpUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Deliberately small.
 *
 * No host or port: Next's standalone server reads `HOSTNAME` and `PORT`
 * directly and we do not get to name those. Validating our own copy would
 * create two settings that look authoritative and disagree.
 *
 * No log level either, until the web app logs something. Configuration nothing
 * reads is indistinguishable from configuration that stopped working.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * Where the API lives, as seen *from the web server process* — inside the
   * compose network that is `http://api:3000`, not a public hostname.
   *
   * Deliberately not `NEXT_PUBLIC_`: that prefix inlines a value into the
   * browser bundle, and the internal address of the API is not something to
   * publish. Every call through this URL is server-side.
   *
   * The protocol check is not redundant. `z.url()` alone accepts `api:3000` —
   * the URL parser reads it as scheme `api` with path `3000` — which is exactly
   * the typo someone makes when they forget `http://`, and it would then fail
   * at the first fetch inside a rendered page rather than at startup.
   */
  API_BASE_URL: z.url().refine(isHttpUrl, 'must be an http:// or https:// URL'),

  /**
   * Clerk's publishable key. Public by design — it is compiled into the browser
   * bundle, which is what the `NEXT_PUBLIC_` prefix means and why that prefix is
   * correct here and wrong for everything else in this file's history.
   */
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),

  /**
   * Clerk's secret key. Server-side only — never `NEXT_PUBLIC_`.
   *
   * **This is a real departure from the rule above and it should be read as
   * one.** The header of this file says the web app must hold nothing sensitive
   * because it is the process a browser can reach. Clerk's Next SDK gives us no
   * choice: `clerkMiddleware()` and `auth()` need the secret key to run the
   * session handshake, and that middleware is the app.
   *
   * So the internet-facing service now holds a credential that can read the
   * whole user directory. That is a genuine cost of choosing a hosted identity
   * provider over a library, it was weighed when the decision was made, and it
   * is recorded in ADR 0015 rather than left to be discovered.
   *
   * What limits the damage is that it stops here: the API does *not* get this
   * key, only the public one above it in `env.ts`.
   *
   * Declared here even though Clerk's SDK reads `process.env` itself, so a
   * missing key fails at startup with a named variable instead of at the first
   * sign-in with a stack trace from inside `node_modules`.
   */
  CLERK_SECRET_KEY: z.string().min(1),

  /**
   * Verifies the Standard Webhooks signature on Clerk deliveries.
   *
   * Here rather than in the API's schema, and that placement is the design
   * rather than an accident. The delivery arrives at the web app, which is the
   * only process on the edge network, and verification needs the raw unparsed
   * body — which exists there and nowhere downstream. Forwarding raw bytes
   * inward just to re-verify them adds a place for the payload to be re-encoded
   * and the signature to stop matching.
   *
   * **The reason that used to be given for the last clause was wrong, and ADR
   * 0050 replaces it.** It said re-verifying at the API "buys nothing: an
   * attacker who can reach the API internally can already reach Postgres beside
   * it" — which is false for `web` in particular, the one container an external
   * attacker reaches first: it holds **no** database credentials, deliberately.
   *
   * What actually settles it is one line below this: a compromised web app holds
   * `CLERK_SECRET_KEY` and can therefore manipulate identity at Clerk directly,
   * so protecting our *mirror* from it defends nothing. **That argument does not
   * transfer to money**, and ADR 0050 accordingly requires Phase 5's payment
   * webhooks to be verified at the API rather than here.
   *
   * Genuinely secret. The webhook is the sole external writer of the identity
   * mirror, so forging one means creating and modifying accounts.
   */
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().min(1),
});

export type RawWebEnv = z.infer<typeof schema>;

export interface WebEnv extends RawWebEnv {
  readonly isProduction: boolean;
}

/**
 * Every variable this schema declares, derived from it rather than restated.
 *
 * See `SERVER_ENV_KEYS` in `env.ts` for why these exist: the deployed compose
 * file enumerates variables by name and passes no env file through, so a
 * variable added here reaches a deployed process only if that file was edited
 * too. It has been forgotten twice.
 */
export const WEB_ENV_KEYS: readonly string[] = Object.keys(schema.shape);

/** Parse and validate, reporting every problem rather than only the first. */
export function loadWebEnv(source: EnvSource = process.env): WebEnv {
  // invariant-ok: no-direct-env — this module is part of the one validated
  // entry point that the rule exists to funnel every other module through.
  const result = schema.safeParse(source);

  if (!result.success) {
    throw new EnvironmentError(
      result.error.issues.map((issue) => {
        const name = issue.path.join('.') || '(root)';
        return issue.code === 'invalid_type' && issue.message === 'Required'
          ? `${name} is required but not set`
          : `${name}: ${issue.message}`;
      }),
    );
  }

  return { ...result.data, isProduction: result.data.NODE_ENV === 'production' };
}
