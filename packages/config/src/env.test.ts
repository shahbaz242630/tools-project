import { describe, expect, it } from 'vitest';
import {
  EnvironmentError,
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
} satisfies NodeJS.ProcessEnv;

describe('loadEnv', () => {
  it('applies defaults for everything optional', () => {
    const env = loadEnv(valid);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.POSTGRES_HOST).toBe('localhost');
    expect(env.POSTGRES_PORT).toBe(5433);
    expect(env.REDIS_PORT).toBe(6379);
    expect(env.isProduction).toBe(false);
  });

  it('reports every problem at once, not just the first', () => {
    try {
      loadEnv({});
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentError);
      const { problems } = error as EnvironmentError;
      // All three required variables, not merely the first encountered.
      expect(problems).toHaveLength(3);
      expect(problems.join('\n')).toContain('POSTGRES_USER');
      expect(problems.join('\n')).toContain('POSTGRES_PASSWORD');
      expect(problems.join('\n')).toContain('POSTGRES_DB');
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
