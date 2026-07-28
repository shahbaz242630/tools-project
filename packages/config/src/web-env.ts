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
});

export type RawWebEnv = z.infer<typeof schema>;

export interface WebEnv extends RawWebEnv {
  readonly isProduction: boolean;
}

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
