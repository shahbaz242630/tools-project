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

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  POSTGRES_HOST: z.string().min(1).default('localhost'),
  POSTGRES_PORT: port.default(5433),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_TEST_DB: z.string().min(1).default('rental_test'),

  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: port.default(6379),
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

/** Parse and validate, reporting every problem rather than only the first. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
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
