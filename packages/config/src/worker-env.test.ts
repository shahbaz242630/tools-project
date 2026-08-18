import { describe, expect, it } from 'vitest';
import { EnvironmentError } from './env.js';
import { loadWorkerEnv } from './worker-env.js';

/**
 * The worker's own environment (slice 4.7b).
 *
 * The point of a separate schema is what it does *not* demand, so the last test here
 * is as load-bearing as the rest: the API must not be made to supply a value it never
 * reads.
 */

describe('loadWorkerEnv', () => {
  it('accepts an internal service URL', () => {
    expect(
      loadWorkerEnv({ API_INTERNAL_URL: 'http://api:3000' }).API_INTERNAL_URL,
    ).toBe('http://api:3000');
  });

  it('accepts the local development address', () => {
    // 3001, not 3000: the Next dev server takes 3000 and they cannot share it.
    expect(
      loadWorkerEnv({ API_INTERNAL_URL: 'http://localhost:3001' }).API_INTERNAL_URL,
    ).toBe('http://localhost:3001');
  });

  it('accepts https, for a deployment that ever terminates TLS internally', () => {
    expect(
      loadWorkerEnv({ API_INTERNAL_URL: 'https://api.internal' }).API_INTERNAL_URL,
    ).toBe('https://api.internal');
  });

  it('is required, because a default would be wrong somewhere and silent', () => {
    expect(() => loadWorkerEnv({})).toThrow(EnvironmentError);
  });

  it('names the variable and the fix when it is missing', () => {
    try {
      loadWorkerEnv({});
      expect.unreachable('should have thrown');
    } catch (error) {
      const { problems } = error as EnvironmentError;
      expect(problems.join('\n')).toContain('API_INTERNAL_URL');
    }
  });

  it.each([
    ['a bare host', 'api:3000'],
    ['a path only', '/internal'],
    ['an empty string', ''],
    ['a non-http scheme', 'redis://api:6379'],
    ['something that is not a URL at all', 'not a url'],
  ])('refuses %s', (_why, value) => {
    /*
     * Checked at startup rather than at the first job. A malformed value otherwise
     * surfaces as a `fetch` TypeError inside a scheduled job — with no request to
     * fail and nobody watching — up to fifteen minutes after the deploy.
     */
    expect(() => loadWorkerEnv({ API_INTERNAL_URL: value })).toThrow(EnvironmentError);
  });

  it('ignores everything else in the environment', () => {
    /*
     * **The reason this schema is separate at all.** It must not grow into a second
     * copy of `loadEnv`, and it must not demand what the API holds — the coupling
     * that once made a queue consumer refuse to start without a JWT key.
     */
    const env = loadWorkerEnv({
      API_INTERNAL_URL: 'http://api:3000',
      POSTGRES_USER: 'rental',
      INTERNAL_TRIGGER_SECRET: 'lives-in-the-shared-loader-not-this-one',
    });

    expect(Object.keys(env)).toEqual(['API_INTERNAL_URL']);
  });
});
