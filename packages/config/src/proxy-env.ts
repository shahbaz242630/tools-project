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
   * Today the correct value genuinely is `0`: the Caddy ingress has never run,
   * because bringing it up without a domain would put plain HTTP on a dialable
   * public IP (BRD §10.2). It becomes `1` when the ingress comes up and `2`
   * behind Cloudflare's Tunnel — **in the same change that brings the proxy up**,
   * which is the step ADR 0017 warned would otherwise be silent.
   *
   * **Bounded at 4**, because this is set by hand during a topology change: a
   * fat-fingered `40` would reach past every real entry and return null forever,
   * which looks exactly like a working fail-closed default.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(4).default(0),
});

export type ProxyEnv = z.infer<typeof schema>;

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
