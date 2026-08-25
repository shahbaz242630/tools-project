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
