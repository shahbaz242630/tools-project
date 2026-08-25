import { z } from 'zod';
import { EnvironmentError } from './env.js';
import type { EnvSource } from './env.js';

/**
 * How many proxies we control sit in front of the web app.
 *
 * **Its own loader rather than a field on `loadWebEnv`**, for the reason
 * `PERSONAL_DATA_ENCRYPTION_KEY` has one: this is read by `clientIpFrom`, a
 * three-line parsing helper on the path of every audited request, and making it
 * depend on the *whole* web schema would mean that helper could not run without
 * Clerk's secret key and publishable key both being present.
 *
 * That is not hypothetical — it was the first attempt, and it broke eleven unit
 * tests of account actions that had no business knowing about Clerk
 * configuration. **A helper that parses a header should not be able to fail
 * because a payment provider is unconfigured.**
 */
const schema = z.object({
  /**
   * `clientIpFrom` counts back this many entries from the end of
   * `X-Forwarded-For`, because each proxy appends the peer it observed.
   *
   * **Zero by default, and zero means "trust nothing".** With nothing in front,
   * every entry in that header is one the caller typed — so the honest answer is
   * that the address is unknowable, and the result is written to
   * `audit_logs.ipAddress` as *evidence*. A default of one would record a
   * stranger's claim as fact.
   *
   * `0` remains the default and remains correct with nothing in front — local
   * development, and any environment reached directly. **Staging is no longer
   * one of them:** from 24 August 2026 it runs behind Cloudflare's Tunnel in
   * front of Caddy and sets `2`, which was done in the same change that brought
   * the proxy up rather than after it — the step ADR 0017 warned would
   * otherwise be silent.
   *
   * The value only reaches a deployed container because
   * `docker-compose.app.yml` now passes it. It did not until that change, so
   * setting it in the box's env file would have done nothing and said nothing —
   * the same silence, one layer down.
   *
   * **Bounded at 4**, because this is set by hand during a topology change: a
   * fat-fingered `40` would reach past every real entry and return null forever,
   * which looks exactly like a working fail-closed default.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(4).default(0),
});

export type ProxyEnv = z.infer<typeof schema>;

/**
 * Every variable this schema declares, derived from it rather than restated.
 *
 * See `SERVER_ENV_KEYS` in `env.ts` for why these exist: the deployed compose
 * file enumerates variables by name and passes no env file through, so a
 * variable added here reaches a deployed process only if that file was edited
 * too. It has been forgotten twice.
 */
export const PROXY_ENV_KEYS: readonly string[] = Object.keys(schema.shape);

/** Parse and validate, reporting every problem rather than only the first. */
export function loadProxyEnv(source: EnvSource = process.env): ProxyEnv {
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

  return result.data;
}
