import { describe, expect, it } from 'vitest';
import {
  EnvironmentError,
  POSTGRES_SSL_MODES,
  buildPostgresUrl,
  buildRedisUrl,
  describeEnv,
  loadEnv,
  redactUrl,
} from './env.js';

const valid = {
  POSTGRES_USER: 'rental',
  POSTGRES_PASSWORD: 'local_dev_only',
  POSTGRES_DB: 'rental_dev',
  // Required from slice 4.7a: an absent one stops the process rather than opening
  // an unauthenticated mutating route. Length is all the schema can check.
  INTERNAL_TRIGGER_SECRET: 'test-internal-trigger-secret-not-a-real-one',
} satisfies NodeJS.ProcessEnv;

describe('loadEnv', () => {
  it('applies defaults for everything optional', () => {
    const env = loadEnv(valid);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.POSTGRES_HOST).toBe('localhost');
    expect(env.POSTGRES_PORT).toBe(5433);
    expect(env.REDIS_PORT).toBe(6379);
    expect(env.API_PORT).toBe(3000);
    expect(env.isProduction).toBe(false);
  });

  it('defaults the API to every interface, not loopback', () => {
    // localhost here would start cleanly in a container and refuse every
    // request arriving from outside it.
    expect(loadEnv(valid).API_HOST).toBe('0.0.0.0');
  });

  it('rejects an out-of-range API port', () => {
    expect(() => loadEnv({ ...valid, API_PORT: '70000' })).toThrow(EnvironmentError);
    expect(() => loadEnv({ ...valid, API_PORT: '0' })).toThrow(EnvironmentError);
  });

  it('reports every problem at once, not just the first', () => {
    try {
      loadEnv({});
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentError);
      const { problems } = error as EnvironmentError;
      // Every required variable, not merely the first encountered — one
      // restart per missing value is the failure mode this exists to prevent.
      const reported = problems.join('\n');
      for (const name of [
        'POSTGRES_USER',
        'POSTGRES_PASSWORD',
        'POSTGRES_DB',
        // Added by slice 4.7a. The count below is what makes a new required
        // variable a deliberate edit here rather than a silent extra restart.
        'INTERNAL_TRIGGER_SECRET',
      ]) {
        expect(reported).toContain(name);
      }
      expect(problems).toHaveLength(4);
    }
  });

  it('points at the fix in the message', () => {
    expect(() => loadEnv({})).toThrow(/\.env\.example/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadEnv({ ...valid, POSTGRES_PORT: '70000' })).toThrow(
      EnvironmentError,
    );
    expect(() => loadEnv({ ...valid, POSTGRES_PORT: '0' })).toThrow(EnvironmentError);
  });

  it('rejects a non-numeric port', () => {
    expect(() => loadEnv({ ...valid, POSTGRES_PORT: 'abc' })).toThrow(EnvironmentError);
  });

  it('rejects an unknown NODE_ENV rather than assuming development', () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(EnvironmentError);
  });

  it('rejects an empty password', () => {
    expect(() => loadEnv({ ...valid, POSTGRES_PASSWORD: '' })).toThrow(
      EnvironmentError,
    );
  });

  it('composes the database URLs from parts', () => {
    const env = loadEnv(valid);
    expect(env.databaseUrl).toBe(
      'postgresql://rental:local_dev_only@localhost:5433/rental_dev',
    );
    expect(env.testDatabaseUrl).toBe(
      'postgresql://rental:local_dev_only@localhost:5433/rental_test',
    );
    expect(env.redisUrl).toBe('redis://localhost:6379');
  });

  it('keeps dev and test on separate databases', () => {
    const env = loadEnv(valid);
    expect(env.databaseUrl).not.toBe(env.testDatabaseUrl);
  });
});

describe('buildPostgresUrl', () => {
  it('percent-encodes characters that would otherwise break the URL', () => {
    // A password containing @ and : silently produces a malformed URL when
    // concatenated naively, and the resulting failure blames the wrong thing.
    const url = buildPostgresUrl({
      host: 'db.internal',
      port: 5432,
      user: 'rental',
      password: 'p@ss:w/rd#1',
      database: 'rental_dev',
    });

    expect(url).toBe(
      'postgresql://rental:p%40ss%3Aw%2Frd%231@db.internal:5432/rental_dev',
    );

    // The decoded password must survive the round trip intact.
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.password)).toBe('p@ss:w/rd#1');
    expect(parsed.hostname).toBe('db.internal');
    expect(parsed.port).toBe('5432');
  });

  it('encodes the user and database name too', () => {
    const url = buildPostgresUrl({
      host: 'localhost',
      port: 5432,
      user: 'user name',
      password: 'pw',
      database: 'db name',
    });
    expect(url).toContain('user%20name');
    expect(url).toContain('/db%20name');
  });

  it('builds a redis url', () => {
    expect(buildRedisUrl({ host: 'cache', port: 6380 })).toBe('redis://cache:6380');
  });

  it('omits sslmode entirely when none is given', () => {
    // The property the local stack and the integration suite depend on: an
    // absent mode composes the URL this function composed before the parameter
    // existed, character for character. Appending `?sslmode=disable` instead
    // would be equivalent to the driver and a silent change to nine db tests.
    expect(
      buildPostgresUrl({
        host: 'localhost',
        port: 5433,
        user: 'rental',
        password: 'pw',
        database: 'rental_dev',
      }),
    ).toBe('postgresql://rental:pw@localhost:5433/rental_dev');
  });

  it.each(POSTGRES_SSL_MODES)('appends sslmode=%s when given', (mode) => {
    expect(
      buildPostgresUrl({
        host: 'db.internal',
        port: 5432,
        user: 'rental',
        password: 'pw',
        database: 'rental',
        sslMode: mode,
      }),
    ).toBe(`postgresql://rental:pw@db.internal:5432/rental?sslmode=${mode}`);
  });

  it('keeps the mode readable after the password is encoded', () => {
    // A password containing `/` or `#` mangles everything after it when it is
    // not encoded, and the TLS mode is what sits after it.
    const url = buildPostgresUrl({
      host: 'db.internal',
      port: 5432,
      user: 'rental',
      password: 'p@ss/w#rd',
      database: 'rental',
      sslMode: 'verify-full',
    });
    expect(new URL(url).searchParams.get('sslmode')).toBe('verify-full');
  });
});

describe('POSTGRES_SSLMODE', () => {
  it('is optional outside production, and then composes no sslmode at all', () => {
    const env = loadEnv(valid);
    expect(env.POSTGRES_SSLMODE).toBeUndefined();
    expect(env.databaseUrl).not.toContain('sslmode');
    expect(env.testDatabaseUrl).not.toContain('sslmode');
  });

  it.each(POSTGRES_SSL_MODES)('accepts %s and puts it on both URLs', (mode) => {
    // Both, not just the first. The integration suite connects to
    // testDatabaseUrl, so a mode applied to only one of them would pass every
    // unit test and fail the moment the suite ran against a real TLS database.
    const env = loadEnv({ ...valid, POSTGRES_SSLMODE: mode });
    expect(env.databaseUrl).toContain(`sslmode=${mode}`);
    expect(env.testDatabaseUrl).toContain(`sslmode=${mode}`);
  });

  it('treats an empty value as absent', () => {
    // `POSTGRES_SSLMODE=` in an env file and an unset variable are the same
    // intent, and Compose can only spell one of them.
    const env = loadEnv({ ...valid, POSTGRES_SSLMODE: '' });
    expect(env.POSTGRES_SSLMODE).toBeUndefined();
    expect(env.databaseUrl).not.toContain('sslmode');
  });

  it.each(['require', 'verify-ca'])(
    'refuses %s, because its meaning changes with the driver version',
    (mode) => {
      // The whole point of the slice. pg 8 reads these as verify-full; pg 9
      // reads them as encrypted-but-unverified. Accepted here, a dependency
      // bump downgrades database TLS with nothing failing anywhere.
      try {
        loadEnv({ ...valid, POSTGRES_SSLMODE: mode });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(EnvironmentError);
        const reported = (error as EnvironmentError).problems.join('\n');
        expect(reported).toContain('POSTGRES_SSLMODE');
        // The message has to name the replacement. Refusing a value without
        // saying what to write instead sends somebody to two changelogs.
        expect(reported).toContain('verify-full');
      }
    },
  );

  it.each(['prefer', 'allow'])(
    'refuses %s, because it falls back to plaintext',
    (mode) => {
      try {
        loadEnv({ ...valid, POSTGRES_SSLMODE: mode });
        expect.unreachable('should have thrown');
      } catch (error) {
        const reported = (error as EnvironmentError).problems.join('\n');
        expect(reported).toContain('unencrypted');
        expect(reported).toContain('disable');
      }
    },
  );

  it('refuses a misspelling, which the driver would silently accept', () => {
    // pg-connection-string parses an unrecognised sslmode to `{}` — TLS on,
    // no complaint. So `verifyfull` looks like it worked. This list is checked
    // here precisely because the layer below will not check it.
    try {
      loadEnv({ ...valid, POSTGRES_SSLMODE: 'verifyfull' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const reported = (error as EnvironmentError).problems.join('\n');
      expect(reported).toContain('verify-full');
      expect(reported).toContain('silently enables TLS');
    }
  });

  it('is required in production', () => {
    // Unset means the URL carries no TLS instruction, which against a managed
    // database is a plaintext connection over the internet that nobody chose.
    try {
      loadEnv({ ...valid, NODE_ENV: 'production' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentError);
      const reported = (error as EnvironmentError).problems.join('\n');
      expect(reported).toContain('POSTGRES_SSLMODE');
      expect(reported).toContain('required when NODE_ENV is production');
    }
  });

  it('accepts disable in production, because it has then been chosen', () => {
    // Not defaulted to verify-full: a private network is a legitimate answer,
    // it just has to be one somebody typed. See ADR 0038.
    const env = loadEnv({
      ...valid,
      NODE_ENV: 'production',
      POSTGRES_SSLMODE: 'disable',
    });
    expect(env.databaseUrl).toContain('sslmode=disable');
  });

  it('survives redaction, so a boot log states the TLS mode', () => {
    const env = loadEnv({ ...valid, POSTGRES_SSLMODE: 'verify-full' });
    const described = describeEnv(env);
    expect(described['database']).toContain('sslmode=verify-full');
    expect(described['database']).toContain('***');
    expect(described['database']).not.toContain('local_dev_only');
  });
});

describe('redactUrl', () => {
  it.each([
    [
      'postgresql://rental:supersecret@localhost:5433/rental_dev',
      'postgresql://rental:***@localhost:5433/rental_dev',
    ],
    ['redis://cache:6379', 'redis://cache:6379'],
    ['postgresql://rental:p%40ss%3A@db:5432/x', 'postgresql://rental:***@db:5432/x'],
  ])('redacts %s', (input, expected) => {
    expect(redactUrl(input)).toBe(expected);
  });

  it('never leaks the password through describeEnv', () => {
    const env = loadEnv({ ...valid, POSTGRES_PASSWORD: 'do-not-log-me' });
    const described = JSON.stringify(describeEnv(env));
    expect(described).not.toContain('do-not-log-me');
    expect(described).toContain('***');
  });
});
