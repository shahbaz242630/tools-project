/**
 * Environment for verifying identity.
 *
 * A separate schema from `loadEnv`, for the same reason `loadWebEnv` is: not
 * every process needs this. `loadEnv` is shared by the API and the worker, and
 * the worker has nothing to do with identity — folding these fields into it
 * made a queue consumer refuse to start without a JWT key, which is both wrong
 * and the kind of coupling that every later service would inherit.
 *
 * So the API loads both, and fails fast on either. The worker loads one.
 */

import { z } from 'zod';
import { EnvironmentError } from './env.js';
import type { EnvSource } from './env.js';

/**
 * A PEM public key supplied through an environment variable.
 *
 * PEM is inherently multi-line and dotenv has no multi-line syntax we can rely
 * on across a shell, `node --env-file` and Docker Compose alike, so the value is
 * stored on one line with `\n` escaped. Unescaping here means every consumer
 * receives a real PEM and none of them has to know that.
 *
 * Idempotent: a value that already contains real newlines — a secret manager
 * can supply one — passes through unchanged.
 *
 * The prefix check earns its place. A truncated or wrongly-pasted key otherwise
 * fails inside the JOSE library at the first token verification, as an opaque
 * decode error on a request, rather than at startup pointing at the variable.
 */
const pemPublicKey = z
  .string()
  .min(1)
  .transform((value) => value.replace(/\\n/g, '\n'))
  .refine(
    (value) => value.startsWith('-----BEGIN PUBLIC KEY-----'),
    'must be a PEM-encoded public key beginning -----BEGIN PUBLIC KEY-----',
  );

/** Comma-separated origins, trimmed, empties dropped. */
const originList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  )
  .refine((origins) => origins.length > 0, 'must list at least one origin');

const schema = z.object({
  /**
   * Clerk's JWT signing key, in PEM form (ADR 0015).
   *
   * **A public key, and that is the point.** Supplying it makes session
   * verification networkless: the API validates a signature locally and never
   * calls Clerk. The alternative — omitting it and letting the SDK fetch JWKS —
   * requires `CLERK_SECRET_KEY`, which can mint sessions, read the entire user
   * directory and impersonate anyone. The API has no business holding that to
   * perform an operation a public key answers.
   *
   * Derive it from the instance's published JWKS; there is nothing to protect
   * and nothing to rotate secretly. Required, because an API that starts
   * without it authenticates nobody and only discovers that on first request.
   */
  CLERK_JWT_PUBLIC_KEY: pemPublicKey,

  /**
   * Origins whose tokens this API will accept, as the `azp` claim.
   *
   * Without this a token minted by *any* Clerk application verifies against our
   * key set for its own issuer — so an attacker who signs in to an unrelated
   * Clerk app on our instance's frontend origin could present that token here.
   * Clerk's own documentation calls this out; it is not defence in depth, it is
   * the check that makes the audience meaningful.
   */
  CLERK_AUTHORIZED_PARTIES: originList,
});

export type IdentityEnv = z.infer<typeof schema>;

/** Parse and validate, reporting every problem rather than only the first. */
export function loadIdentityEnv(source: EnvSource = process.env): IdentityEnv {
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
