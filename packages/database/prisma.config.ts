import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * Prisma 7 moved the connection URL out of `schema.prisma`, so this file is the
 * only place the CLI learns how to reach a database. The applications connect
 * through the adapter in `src/client.ts` and never read this.
 *
 * Deliberately self-contained — no workspace imports. The migrations image
 * (packages/database/Dockerfile) installs the Prisma CLI on its own and copies
 * in only this file and `prisma/`, because pulling the schema engine out of a
 * pnpm workspace build turned out to be fragile. That constraint is what forces
 * the small amount of duplication below.
 */

/**
 * The TLS modes we accept, copied from `POSTGRES_SSL_MODES` in @platform/config
 * (ADR 0038). libpq has eight; these three are the ones whose meaning does not
 * change under pg 9 / pg-connection-string 3.
 */
const SSL_MODES = ['disable', 'no-verify', 'verify-full'];

/**
 * Percent-encode the credential parts and append the TLS mode, exactly as
 * `buildPostgresUrl` in @platform/config does (ADR 0006, ADR 0038).
 *
 * This is the one deliberate copy of those rules, and it is here because this
 * file runs where `@platform/config` does not exist. The encoding matters: the
 * documented way to generate a password is `openssl rand`, which emits `/`, `+`
 * and `=`. An unencoded `/` terminates the authority section, so the URL quietly
 * addresses a different database — or fails with an error that names neither
 * the password nor the reason.
 *
 * The TLS mode matters for a reason this file demonstrates better than any
 * other: **migrations ran against Neon before the applications could connect to
 * it at all**, because the Prisma engine and node-postgres disagree about what
 * an absent `sslmode` means. A migration image that connects proves nothing
 * about whether the API will.
 *
 * If either rule ever changes, it changes in both places. There is no third.
 */
function composeUrl(parts: {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  sslMode: string | undefined;
}): string {
  const user = encodeURIComponent(parts.user);
  const password = encodeURIComponent(parts.password);
  const database = encodeURIComponent(parts.database);
  const url = `postgresql://${user}:${password}@${parts.host}:${parts.port}/${database}`;
  return parts.sslMode === undefined ? url : `${url}?sslmode=${parts.sslMode}`;
}

/**
 * Reject a mode we do not accept, rather than passing it through.
 *
 * Unlike the missing-credential case below, this throws. An absent database is
 * a legitimate state — `prisma generate` needs none — but a database configured
 * with a TLS mode nobody vetted is a wrong answer, and the driver will not
 * complain: an unrecognised `sslmode` silently enables TLS rather than failing.
 */
function checkedSslMode(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (SSL_MODES.includes(value)) return value;

  throw new Error(
    `POSTGRES_SSLMODE=${value} is not accepted. Use one of ${SSL_MODES.join(', ')}. ` +
      `In particular 'require' is refused because pg 8 reads it as verify-full and pg 9 ` +
      `reads it as encrypted-but-unverified, so it silently weakens on a dependency ` +
      `bump. See ADR 0038.`,
  );
}

function datasourceUrl(): string {
  // invariant-ok: no-direct-env — the Prisma CLI loads this file standing
  // alone, outside any application, so @platform/config is not reachable.
  const env = process.env;

  // An explicit URL wins. CI and one-off maintenance legitimately point the CLI
  // at a scratch database.
  //
  // It carries its own `sslmode` or it has none — POSTGRES_SSLMODE is not
  // merged into a URL somebody supplied whole, because a query parameter
  // appended to a string we did not compose is how you get two of them. This is
  // the path the first 23 migrations against Neon actually took.
  const explicit = env['DATABASE_URL'];
  if (explicit !== undefined && explicit !== '') return explicit;

  const host = env['POSTGRES_HOST'];
  const user = env['POSTGRES_USER'];
  const password = env['POSTGRES_PASSWORD'];
  const database = env['POSTGRES_DB'];

  // Empty rather than throwing. `prisma generate` needs no database at all and
  // still loads this file, so raising here would break every Docker build —
  // which correctly carries no credentials. Commands that do need a connection
  // fail with their own clear error.
  if (
    host === undefined ||
    user === undefined ||
    password === undefined ||
    database === undefined
  ) {
    return '';
  }

  return composeUrl({
    host,
    port: env['POSTGRES_PORT'] ?? '5432',
    user,
    password,
    database,
    sslMode: checkedSslMode(env['POSTGRES_SSLMODE']),
  });
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: datasourceUrl() },
  migrations: { path: 'prisma/migrations' },
});
