/**
 * Environment loading and validation.
 *
 * Two rules drive the design.
 *
 * **Fail fast, and fail completely.** A missing variable is discovered at
 * startup with every problem listed at once, not one per restart, and never
 * halfway through serving a request.
 *
 * **Connection strings are composed, never stored.** The password appears once,
 * in one variable. Committing a `postgresql://user:pass@host/db` template
 * duplicates the credential into a URI and puts a credential-shaped string in
 * the repository for secret scanners to find. Composing also lets us
 * percent-encode correctly, which hand-written URLs reliably get wrong.
 */

import { z } from 'zod';

export class EnvironmentError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `Environment is not valid:\n${problems.map((p) => `  - ${p}`).join('\n')}\n\n` +
        `Copy .env.example to .env and fill in the missing values.`,
    );
    this.name = 'EnvironmentError';
    this.problems = problems;
  }
}

const port = z.coerce.number().int().min(1).max(65535);

/**
 * The TLS modes we accept — deliberately three of libpq's eight (ADR 0038).
 *
 * These are the only values that mean the same thing before and after
 * pg 9 / pg-connection-string 3. `disable` is no TLS, `no-verify` is encrypted
 * with the certificate unchecked, `verify-full` is encrypted with the chain and
 * the hostname checked. Nothing about those three is scheduled to change.
 */
export const POSTGRES_SSL_MODES = ['disable', 'no-verify', 'verify-full'] as const;

export type PostgresSslMode = (typeof POSTGRES_SSL_MODES)[number];

/**
 * Say why a rejected mode is rejected, and what to write instead.
 *
 * The four values below are the ones pg-connection-string warns about itself:
 * today it treats `prefer`, `require` and `verify-ca` as aliases for
 * `verify-full`, and in its next major it adopts libpq semantics under which
 * they are all weaker. A message naming the replacement is the difference
 * between a five-second fix and reading two changelogs.
 */
function explainRejectedSslMode(value: string): string {
  if (value === 'require' || value === 'verify-ca') {
    return (
      `\`${value}\` is not accepted because its meaning depends on the driver version: ` +
      `pg 8 treats it as an alias for verify-full, and pg 9 adopts libpq semantics under ` +
      `which it is encrypted but unverified. Written here, a routine dependency bump ` +
      `downgrades database TLS with nothing failing. Write \`verify-full\`, which means ` +
      `the same thing in both. See ADR 0038`
    );
  }

  if (value === 'prefer' || value === 'allow') {
    return (
      `\`${value}\` is not accepted because it falls back to an unencrypted connection ` +
      `when TLS is unavailable, and reports nothing when it does. Write \`disable\` if ` +
      `plaintext is what you mean, or \`no-verify\` / \`verify-full\` for a connection ` +
      `that is always encrypted. See ADR 0038`
    );
  }

  return (
    `must be one of ${POSTGRES_SSL_MODES.join(', ')}. Note that an unrecognised value is ` +
    `not an error to the driver — it silently enables TLS — which is why this list is ` +
    `checked here. See ADR 0038`
  );
}

/**
 * How to reach Postgres over TLS, or deliberately not to.
 *
 * Optional outside production, where an unset value composes exactly the URL
 * this file composed before the field existed — so local development against a
 * container with no TLS is unaffected. **Required in production**, because unset
 * means the URL carries no TLS instruction at all, and against a managed
 * database that is a plaintext connection across the internet nobody chose.
 *
 * An empty value is treated as absent: `POSTGRES_SSLMODE=` in an env file and an
 * unset variable are the same intent, and only one of them is spellable in
 * Compose.
 */
const sslMode = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .enum(POSTGRES_SSL_MODES, {
      error: (issue) => explainRejectedSslMode(String(issue.input)),
    })
    .optional(),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /**
   * Whether to collect and expose metrics (slice H1).
   *
   * **Defaults to on**, unlike most flags here. A service nobody can see the
   * state of is the situation this was built to end, and a default of "off"
   * would mean every environment has to remember to switch it on — which is the
   * one that will be forgotten in the environment that matters.
   *
   * Off is for a constrained box or a test that wants no registry. The endpoint
   * still answers when it is off; it serves an empty exposition, which tells a
   * scraper "reachable, collecting nothing" rather than failing to connect.
   */
  METRICS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  /**
   * `0.0.0.0`, not `localhost`. Inside a container, binding to the loopback
   * interface makes the service unreachable from outside it — the process
   * starts, logs that it is listening, and every request is refused.
   */
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: port.default(3000),

  POSTGRES_HOST: z.string().min(1).default('localhost'),
  POSTGRES_PORT: port.default(5433),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_TEST_DB: z.string().min(1).default('rental_test'),
  POSTGRES_SSLMODE: sslMode,

  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: port.default(6379),

  /**
   * Per-account rate limits, in requests per minute (slice H7a).
   *
   * **Optional, because `policy.ts` holds the defaults and the argument for
   * them.** A limit that turns out to be wrong is discovered under traffic, at
   * the worst possible moment, and needing a release to raise it is how an
   * incident gets longer — so the numbers are overridable without a deploy while
   * the tiers themselves stay in code, where a closed union keeps a metric label
   * from being minted by an environment variable.
   *
   * `.int().positive()` rather than a plain number: `0` reads like "no limit"
   * and would mean "refuse everybody", which is the one value nobody types on
   * purpose. `resolvePolicies` refuses it a second time, because an operator
   * raising a limit mid-incident should be told rather than silently defaulted.
   */
  RATE_LIMIT_READ_PER_MINUTE: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_WRITE_PER_MINUTE: z.coerce.number().int().positive().optional(),

  /**
   * The shared secret the worker presents to trigger scheduled work, and the API
   * checks (slice 4.7a, ADR 0048).
   *
   * **In the shared loader because both processes need it** — the worker to send,
   * the API to verify — which is the one thing that qualifies a field for this
   * schema. Contrast `PERSONAL_DATA_ENCRYPTION_KEY`, which lives in its own loader
   * precisely so a queue consumer cannot read a home address.
   *
   * **Required rather than optional, so an absent secret stops the process instead
   * of opening the route.** An optional secret has to be handled at the guard, and
   * the tempting handling is "no secret configured, so skip the check" — which is
   * an unauthenticated mutating endpoint reached by forgetting a line in an env
   * file. Refusing to boot is the same choice ADR 0038 made for
   * `POSTGRES_SSLMODE`: a default is invisible, and this one would be invisible and
   * open.
   *
   * **32 characters minimum, and length is the only thing checkable here.** It is a
   * bearer secret rather than a key for a cipher, so there is no shape to validate
   * — but a short one is guessable at leisure by anything that can reach the API,
   * and "changeme" would otherwise pass. Generate with `openssl rand -base64 32`.
   *
   * It is not personal data and it is not a provider credential, but it is a
   * credential: it belongs in the secret manager, must differ between staging and
   * production, and rotating it means restarting both processes.
   */
  INTERNAL_TRIGGER_SECRET: z
    .string()
    .min(
      32,
      'must be at least 32 characters — generate one with: openssl rand -base64 32',
    ),
});

/**
 * In production, how the database connection is protected must be stated.
 *
 * The safe-looking alternative is to default production to `verify-full`. It is
 * rejected for the reason ADR 0030 gives for refusing to boot rather than
 * silently correcting: a default is invisible, and the first environment to need
 * something else would get it wrong somewhere much further from here. `disable`
 * is a legitimate answer over a private network — it just has to be one somebody
 * typed.
 */
/**
 * Every variable this schema declares, derived from it rather than restated.
 *
 * **It exists so that `env-reaches-the-container.test.mjs` can check the one
 * bridge nothing else can see** (25 August 2026). A deployed container gets its
 * environment from `infra/compose/docker-compose.app.yml`, which **enumerates
 * every variable by name and does not pass an env file through** — so a variable
 * added here and set on the box reaches the process only if somebody also edited
 * that file. It has been forgotten twice: `TRUSTED_PROXY_HOPS` (silently, for a
 * month) and `MEDIA_S3_*` (caught by a refuse-to-boot guard, one layer below
 * where ADR 0017 predicted it).
 *
 * `Object.keys(shape)` rather than a written list, because a second list is the
 * thing that drifts — which is the defect this exists to prevent, one level up.
 */
export const SERVER_ENV_KEYS: readonly string[] = Object.keys(schema.shape);

const withProductionTlsStated = schema.superRefine((env, ctx) => {
  if (env.NODE_ENV !== 'production') return;
  if (env.POSTGRES_SSLMODE !== undefined) return;

  ctx.addIssue({
    code: 'custom',
    path: ['POSTGRES_SSLMODE'],
    message:
      'is required when NODE_ENV is production. Unset composes a URL with no TLS ' +
      'instruction at all, which against a managed database is a plaintext connection ' +
      'over the internet. Set verify-full, or disable if the database is genuinely ' +
      'reached over a private network. See ADR 0038',
  });
});

export type RawEnv = z.infer<typeof withProductionTlsStated>;

export interface Env extends RawEnv {
  /** Composed at runtime. Never read from a committed file. */
  readonly databaseUrl: string;
  /** Integration suite target. Separate database per BRD §12.4. */
  readonly testDatabaseUrl: string;
  readonly redisUrl: string;
  readonly isProduction: boolean;
}

/**
 * Build a Postgres connection URL from its parts.
 *
 * User and password are percent-encoded: a password containing `@`, `:`, `/`
 * or `#` silently produces a malformed URL otherwise, and the resulting
 * connection failure points at the wrong place entirely.
 *
 * `sslMode` is appended only when given, so an omitted one produces the exact
 * URL this function produced before the parameter existed. That is what keeps
 * the local stack and the integration suite — neither of which speaks TLS —
 * working unchanged.
 */
export function buildPostgresUrl(parts: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  // `| undefined` rather than a bare optional: `exactOptionalPropertyTypes` is
  // on, and the caller that matters — loadEnv — passes the field explicitly
  // holding undefined rather than omitting it.
  sslMode?: PostgresSslMode | undefined;
}): string {
  const user = encodeURIComponent(parts.user);
  const password = encodeURIComponent(parts.password);
  const database = encodeURIComponent(parts.database);
  const url = `postgresql://${user}:${password}@${parts.host}:${parts.port}/${database}`;
  return parts.sslMode === undefined ? url : `${url}?sslmode=${parts.sslMode}`;
}

export function buildRedisUrl(parts: { host: string; port: number }): string {
  return `redis://${parts.host}:${parts.port}`;
}

/**
 * Replace the password in a connection URL with `***`.
 *
 * Connection strings reach logs and error messages more often than anyone
 * intends — a failed connection usually reports the URL it tried. Always pass
 * URLs through this before they leave the process.
 */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z+]+:\/\/[^:/@]*):[^@]*@/i, '$1:***@');
}

/**
 * The shape we actually depend on. Narrower than `NodeJS.ProcessEnv`, so a
 * caller can pass any plain record — a test fixture, a parsed file, a secrets
 * manager response — without pretending it came from the process.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Parse and validate, reporting every problem rather than only the first. */
export function loadEnv(source: EnvSource = process.env): Env {
  const result = withProductionTlsStated.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(root)';
      return issue.code === 'invalid_type' && issue.message === 'Required'
        ? `${name} is required but not set`
        : `${name}: ${issue.message}`;
    });
    throw new EnvironmentError(problems);
  }

  const env = result.data;

  return {
    ...env,
    databaseUrl: buildPostgresUrl({
      host: env.POSTGRES_HOST,
      port: env.POSTGRES_PORT,
      user: env.POSTGRES_USER,
      password: env.POSTGRES_PASSWORD,
      database: env.POSTGRES_DB,
      sslMode: env.POSTGRES_SSLMODE,
    }),
    testDatabaseUrl: buildPostgresUrl({
      host: env.POSTGRES_HOST,
      port: env.POSTGRES_PORT,
      user: env.POSTGRES_USER,
      password: env.POSTGRES_PASSWORD,
      database: env.POSTGRES_TEST_DB,
      sslMode: env.POSTGRES_SSLMODE,
    }),
    redisUrl: buildRedisUrl({ host: env.REDIS_HOST, port: env.REDIS_PORT }),
    isProduction: env.NODE_ENV === 'production',
  };
}

/** Safe to log: every credential is redacted. */
export function describeEnv(env: Env): Record<string, string> {
  return {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    metrics: env.METRICS_ENABLED ? 'enabled' : 'disabled',
    database: redactUrl(env.databaseUrl),
    redis: redactUrl(env.redisUrl),
  };
}
