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
 * Percent-encode the credential parts, exactly as `buildPostgresUrl` in
 * @platform/config does (ADR 0006).
 *
 * This is the one deliberate copy of that rule, and it is here because this
 * file runs where `@platform/config` does not exist. It matters: the documented
 * way to generate a password is `openssl rand`, which emits `/`, `+` and `=`.
 * An unencoded `/` terminates the authority section, so the URL quietly
 * addresses a different database — or fails with an error that names neither
 * the password nor the reason.
 *
 * If the encoding rule ever changes, it changes in both places. There is no
 * third.
 */
function composeUrl(parts: {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}): string {
  const user = encodeURIComponent(parts.user);
  const password = encodeURIComponent(parts.password);
  const database = encodeURIComponent(parts.database);
  return `postgresql://${user}:${password}@${parts.host}:${parts.port}/${database}`;
}

function datasourceUrl(): string {
  // invariant-ok: no-direct-env — the Prisma CLI loads this file standing
  // alone, outside any application, so @platform/config is not reachable.
  const env = process.env;

  // An explicit URL wins. CI and one-off maintenance legitimately point the CLI
  // at a scratch database.
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
  });
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: datasourceUrl() },
  migrations: { path: 'prisma/migrations' },
});
