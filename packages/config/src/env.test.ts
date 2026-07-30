import { describe, expect, it } from 'vitest';
import {
  EnvironmentError,
  buildPostgresUrl,
  buildRedisUrl,
  describeEnv,
  loadEnv,
  redactUrl,
} from './env.js';

/**
 * A minimal PEM public key. Structurally real — generated, not invented — so
 * the schema's prefix check is exercised against something that would actually
 * parse rather than a string that merely starts with the right characters.
 */
const PEM_ONE_LINE =
  '-----BEGIN PUBLIC KEY-----\\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\\n-----END PUBLIC KEY-----\\n';

const valid = {
  POSTGRES_USER: 'rental',
  POSTGRES_PASSWORD: 'local_dev_only',
  POSTGRES_DB: 'rental_dev',
  CLERK_JWT_PUBLIC_KEY: PEM_ONE_LINE,
  CLERK_AUTHORIZED_PARTIES: 'http://localhost:3000',
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
        'CLERK_JWT_PUBLIC_KEY',
        'CLERK_AUTHORIZED_PARTIES',
      ]) {
        expect(reported).toContain(name);
      }
      expect(problems).toHaveLength(5);
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

describe('loadEnv — Clerk settings', () => {
  it('unescapes the PEM into real newlines', () => {
    // Stored on one line because dotenv has no multi-line syntax we can rely on
    // across a shell, node --env-file and Docker Compose. Handed to the JOSE
    // library still escaped, it fails to parse as a key.
    const key = loadEnv(valid).CLERK_JWT_PUBLIC_KEY;
    expect(key).toContain('\n');
    expect(key).not.toContain('\\n');
    expect(key.split('\n')[0]).toBe('-----BEGIN PUBLIC KEY-----');
  });

  it('accepts a PEM that already has real newlines', () => {
    // A secret manager supplies one this way. Unescaping must be idempotent
    // rather than assuming the dotenv shape.
    const real = PEM_ONE_LINE.replace(/\\n/g, '\n');
    expect(loadEnv({ ...valid, CLERK_JWT_PUBLIC_KEY: real }).CLERK_JWT_PUBLIC_KEY).toBe(
      real,
    );
  });

  it.each([
    ['sk_live_not_a_key'],
    ['-----BEGIN RSA PRIVATE KEY-----\\nMIIB\\n-----END RSA PRIVATE KEY-----'],
    ['-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----'],
  ])('rejects %j as a JWT public key', (value) => {
    // Without the prefix check these fail inside the JOSE library on the first
    // request as an opaque decode error, pointing at the request rather than at
    // the variable. The private-key case matters most: pasting the wrong half
    // of a key pair is exactly the mistake that should never reach runtime.
    expect(() => loadEnv({ ...valid, CLERK_JWT_PUBLIC_KEY: value })).toThrow(
      EnvironmentError,
    );
  });

  it('splits authorized parties on commas and trims them', () => {
    const env = loadEnv({
      ...valid,
      CLERK_AUTHORIZED_PARTIES: ' https://a.example , https://b.example ',
    });
    expect(env.CLERK_AUTHORIZED_PARTIES).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it.each([[''], [','], ['  ,  ']])(
    'rejects %j as an authorized-party list',
    (value) => {
      // An empty list disables the azp check entirely, which is worse than a
      // missing variable because the API starts and accepts tokens minted by
      // any Clerk application on the same instance.
      expect(() => loadEnv({ ...valid, CLERK_AUTHORIZED_PARTIES: value })).toThrow(
        EnvironmentError,
      );
    },
  );

  it('holds no Clerk secret at all', () => {
    // The API is given the *public* JWT key and nothing else. Verification is
    // therefore networkless, and an API that is compromised yields a key Clerk
    // already publishes rather than the ability to mint sessions, read the
    // whole user directory or impersonate anyone.
    //
    // The assertion is on the parsed result, not the input: extra variables in
    // the environment are ignored, so this fails the moment someone adds a
    // Clerk secret to *this* schema.
    const env = loadEnv({
      ...valid,
      CLERK_SECRET_KEY: 'sk_live_should_never_reach_the_api',
      CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_belongs_to_the_web_app',
    });

    expect(env).not.toHaveProperty('CLERK_SECRET_KEY');
    expect(env).not.toHaveProperty('CLERK_WEBHOOK_SIGNING_SECRET');
    expect(JSON.stringify(describeEnv(env))).not.toContain('sk_live');
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
