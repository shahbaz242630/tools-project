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

/**
 * A boolean from an environment variable, where **only the exact string `true`
 * turns it on**.
 *
 * Deliberately not `z.coerce.boolean()`, which treats every non-empty string as
 * true — including `"false"`, `"0"` and `"no"`. For a flag that removes an
 * authentication check, the reading of `DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA=false`
 * must be *off*, and a coercion that says otherwise is the worst possible
 * default.
 */
const explicitBoolean = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

/**
 * A Cloudflare Zero Trust team domain, which is both the JWT issuer and the
 * host the signing keys are fetched from.
 *
 * **No trailing slash, checked rather than trimmed.** The adapter builds
 * `${teamDomain}/cdn-cgi/access/certs` and compares the value against the
 * token's `iss` claim; a trailing slash makes the first a double slash and the
 * second a mismatch, so every admin request would fail verification with an
 * error pointing at the token rather than at this variable. Refusing it here
 * costs one line and names the actual problem.
 *
 * The `https://` prefix is required for the same reason: `iss` carries the
 * scheme, and a bare hostname silently never matches.
 */
/**
 * Optional, where an **empty string also means absent**.
 *
 * `.optional()` alone is not enough, and the gap is not theoretical: the
 * deployed compose file writes `${CLOUDFLARE_ACCESS_TEAM_DOMAIN:-}`, and Docker
 * Compose expands an unset variable to an *empty string* rather than omitting
 * the key. So an environment with Access simply not configured would hand this
 * schema `''`, fail `min(1)`, and the API would **refuse to boot** — turning an
 * optional feature into a required one, on staging, at deploy time.
 *
 * Written as a preprocess rather than by loosening the validators, so the
 * checks below still apply in full to any value somebody actually set.
 */
const absentWhenEmpty = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const accessTeamDomain = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith('https://'),
    'must begin https:// — it is compared against the token issuer, which carries the scheme',
  )
  .refine(
    (value) => !value.endsWith('/'),
    'must not end with a slash — the certs path is appended to it',
  );

/**
 * The Application Audience tag of the Access application guarding `/admin`.
 *
 * **This is what makes the assertion ours.** Cloudflare signs every
 * application's tokens with the same account keys, so signature alone proves
 * only that some Access application admitted somebody — the audience is what
 * says it was *this* one. Without it, an assertion minted for any other
 * application in the account would verify here.
 *
 * A 64-character hex string. Checked in shape rather than merely non-empty,
 * because pasting the application *name* or its UUID instead is an easy
 * mistake and both would fail as an opaque verification error on every request.
 */
const accessAudience = z
  .string()
  .regex(
    /^[0-9a-f]{64}$/,
    'must be the 64-character hex Application Audience (AUD) tag',
  );

const shape = z.object({
  /**
   * Read here as well as in `loadEnv`, and that is not duplication of a source
   * of truth — it is this schema needing to know the environment in order to
   * decide whether its *own* fields are valid. See the refinement below.
   */
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

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

  /**
   * Open every admin route to an administrator with no verified second factor.
   *
   * **A development escape hatch, and the name is the documentation.** ADR 0021
   * requires a second factor for administrative access and reads Clerk's `fva`
   * claim to prove it; Clerk gates every MFA strategy — and passkeys — behind a
   * paid plan, so on the free plan there is no second factor anybody can enrol
   * and the guard correctly refuses every administrator, everywhere. That was
   * accepted on 4 August as a cost to defer, and reversed on the same day once
   * it became clear what it costs: **four slices whose main surface no human has
   * ever used**, including a statutory confirmation, verified by tests alone.
   *
   * Being unable to open the admin pages is not merely inconvenient. Every
   * recent bug in this project was found by using a page — a form that threw on
   * submit, a refusal with an enabled form beneath it, an error rendered above
   * the fold. A surface nobody can operate is a surface where that class of
   * defect accumulates silently until launch.
   *
   * **It cannot reach a deployed environment.** Setting it with
   * `NODE_ENV=production` does not disable it, ignore it or warn about it: the
   * process refuses to start. A flag that is quietly dropped in production is
   * one somebody eventually believes is working.
   */
  DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA: explicitBoolean,

  /**
   * Cloudflare Access as a second-factor provider (ADR 0053, slice H8b).
   *
   * **Both optional, and both-or-neither.** Absent means the Access adapter is
   * not installed at all, which is correct for local development — Access
   * protects a public hostname and cannot see `localhost`. Present means the
   * chain gains a prover that verifies `Cf-Access-Jwt-Assertion` against
   * Cloudflare's rotating keys.
   *
   * Half-configured is refused rather than tolerated: a team domain with no
   * audience would verify tokens minted for *any* application in the account,
   * which is a weaker check that looks like a working one.
   */
  CLOUDFLARE_ACCESS_TEAM_DOMAIN: absentWhenEmpty(accessTeamDomain),
  CLOUDFLARE_ACCESS_AUD: absentWhenEmpty(accessAudience),
});

/**
 * Every variable this schema declares, derived from it rather than restated.
 *
 * See `SERVER_ENV_KEYS` in `env.ts` for why these exist: the deployed compose
 * file enumerates variables by name and passes no env file through, so a
 * variable added here reaches a deployed process only if that file was edited
 * too. It has been forgotten twice.
 */
export const IDENTITY_ENV_KEYS: readonly string[] = Object.keys(shape.shape);

const schema = shape.superRefine((env, ctx) => {
  // Both-or-neither. One without the other is a misconfiguration that would
  // otherwise present as "the second factor silently never works" (no domain)
  // or "any Access application in the account satisfies it" (no audience).
  const domain = env.CLOUDFLARE_ACCESS_TEAM_DOMAIN !== undefined;
  const audience = env.CLOUDFLARE_ACCESS_AUD !== undefined;
  if (domain !== audience) {
    ctx.addIssue({
      code: 'custom',
      message:
        'CLOUDFLARE_ACCESS_TEAM_DOMAIN and CLOUDFLARE_ACCESS_AUD must be set together — one without the other is a second factor that either never works or accepts any application in the account',
      path: [domain ? 'CLOUDFLARE_ACCESS_AUD' : 'CLOUDFLARE_ACCESS_TEAM_DOMAIN'],
    });
  }

  if (!env.DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA) return;
  if (env.NODE_ENV !== 'production') return;

  // Refusing to boot rather than falling back to the safe behaviour. Both end
  // with MFA enforced, and only this one tells somebody that what they
  // configured is not what they got — a silent correction here would be a
  // production instance running under an assumption nobody can see.
  ctx.addIssue({
    code: 'custom',
    path: ['DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA'],
    message:
      'cannot be enabled when NODE_ENV is production — it removes the second-factor ' +
      'check ADR 0021 and BRD §9 require for every administrative action. It exists ' +
      'only so the admin surface can be operated in local development while Clerk ' +
      'MFA is unavailable on the free plan',
  });
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
