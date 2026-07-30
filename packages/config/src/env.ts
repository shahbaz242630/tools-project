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
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

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

  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: port.default(6379),

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

export type RawEnv = z.infer<typeof schema>;

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
 */
export function buildPostgresUrl(parts: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}): string {
  const user = encodeURIComponent(parts.user);
  const password = encodeURIComponent(parts.password);
  const database = encodeURIComponent(parts.database);
  return `postgresql://${user}:${password}@${parts.host}:${parts.port}/${database}`;
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
  const result = schema.safeParse(source);

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
    }),
    testDatabaseUrl: buildPostgresUrl({
      host: env.POSTGRES_HOST,
      port: env.POSTGRES_PORT,
      user: env.POSTGRES_USER,
      password: env.POSTGRES_PASSWORD,
      database: env.POSTGRES_TEST_DB,
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
    database: redactUrl(env.databaseUrl),
    redis: redactUrl(env.redisUrl),
  };
}
