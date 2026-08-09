/**
 * Tests for `prisma.config.ts`, which had none until slice 0.9c.
 *
 * That file is deliberately self-contained: the migrations image installs the
 * Prisma CLI on its own and copies in only the config and `prisma/`, so it
 * cannot import `@platform/config`. The cost of that constraint is a duplicated
 * copy of two rules — percent-encoding (ADR 0006) and the accepted TLS modes
 * (ADR 0038) — and a duplicate nobody exercises is a duplicate that drifts.
 *
 * It also sits outside the package's `include`, so until this file existed it
 * was neither typechecked nor run by anything. Importing it here fixes both.
 *
 * The URL is composed at module evaluation time, so each case resets the module
 * registry and re-imports rather than calling a function.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const KEYS = [
  'DATABASE_URL',
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'POSTGRES_SSLMODE',
] as const;

const saved = new Map<string, string | undefined>();

function withEnv(
  values: Partial<Record<(typeof KEYS)[number], string | undefined>>,
): void {
  for (const key of KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

async function datasourceUrl(): Promise<string> {
  vi.resetModules();
  const module = (await import('../prisma.config.js')) as {
    default: { datasource?: { url?: string } };
  };
  return module.default.datasource?.url ?? '';
}

const credentials = {
  POSTGRES_HOST: 'db.internal',
  POSTGRES_PORT: '5432',
  POSTGRES_USER: 'rental',
  POSTGRES_PASSWORD: 'pw',
  POSTGRES_DB: 'rental',
} as const;

describe('prisma.config.ts datasource url', () => {
  it('composes from parts, percent-encoding the credential', async () => {
    // The rule this file copies from @platform/config. `openssl rand -base64`
    // is the documented way to make a password and emits `/`, `+` and `=`; an
    // unencoded `/` terminates the authority section and the URL quietly
    // addresses a different database.
    withEnv({ ...credentials, POSTGRES_PASSWORD: 'p@ss/w+rd=' });
    expect(await datasourceUrl()).toBe(
      'postgresql://rental:p%40ss%2Fw%2Brd%3D@db.internal:5432/rental',
    );
  });

  it('omits sslmode when none is set', async () => {
    withEnv(credentials);
    expect(await datasourceUrl()).toBe(
      'postgresql://rental:pw@db.internal:5432/rental',
    );
  });

  it.each(['disable', 'no-verify', 'verify-full'])(
    'appends sslmode=%s',
    async (mode) => {
      withEnv({ ...credentials, POSTGRES_SSLMODE: mode });
      expect(await datasourceUrl()).toBe(
        `postgresql://rental:pw@db.internal:5432/rental?sslmode=${mode}`,
      );
    },
  );

  it('treats an empty sslmode as absent', async () => {
    withEnv({ ...credentials, POSTGRES_SSLMODE: '' });
    expect(await datasourceUrl()).toBe(
      'postgresql://rental:pw@db.internal:5432/rental',
    );
  });

  it('refuses require, matching @platform/config rather than passing it through', async () => {
    // The duplicate has to refuse the same values as the original. If it did
    // not, migrations would run under one TLS guarantee and the application
    // under another, which is exactly the split that made Neon look reachable
    // when it was not.
    withEnv({ ...credentials, POSTGRES_SSLMODE: 'require' });
    await expect(datasourceUrl()).rejects.toThrow(/not accepted/);
    await expect(datasourceUrl()).rejects.toThrow(/verify-full/);
  });

  it('refuses a misspelling the driver would silently accept', async () => {
    withEnv({ ...credentials, POSTGRES_SSLMODE: 'verifyfull' });
    await expect(datasourceUrl()).rejects.toThrow(/not accepted/);
  });

  it('lets an explicit DATABASE_URL win, without merging sslmode into it', async () => {
    // A URL somebody supplied whole keeps whatever it carries. Appending a
    // query parameter to a string we did not compose is how you end up with
    // two of them. This is the path the first migrations against Neon took.
    withEnv({
      ...credentials,
      POSTGRES_SSLMODE: 'verify-full',
      DATABASE_URL: 'postgresql://someone:else@elsewhere:5432/other?sslmode=no-verify',
    });
    expect(await datasourceUrl()).toBe(
      'postgresql://someone:else@elsewhere:5432/other?sslmode=no-verify',
    );
  });

  it('returns an empty url rather than throwing when no database is configured', async () => {
    // `prisma generate` needs no database and still loads this file, so the
    // Docker build — which correctly carries no credentials — must not break.
    withEnv({});
    expect(await datasourceUrl()).toBe('');
  });

  it('defaults the port to 5432, not the local stack 5433', async () => {
    // This file runs inside the compose network and in the migrations image,
    // where Postgres is on the standard port. @platform/config defaults to
    // 5433 for the local stack; the two defaults differ on purpose.
    withEnv({ ...credentials, POSTGRES_PORT: undefined });
    expect(await datasourceUrl()).toContain('@db.internal:5432/');
  });
});
