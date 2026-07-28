import { describe, expect, it } from 'vitest';
import { EnvironmentError } from './env.js';
import { loadWebEnv } from './web-env.js';

const MINIMUM = { API_BASE_URL: 'http://api:3000' };

describe('loadWebEnv', () => {
  it('needs only the API address', () => {
    const env = loadWebEnv(MINIMUM);
    expect(env.API_BASE_URL).toBe('http://api:3000');
    expect(env.NODE_ENV).toBe('development');
  });

  it('does not claim ownership of the host or port', () => {
    // Next's standalone server reads HOSTNAME and PORT itself. A second,
    // validated copy here would look authoritative and silently disagree.
    expect(loadWebEnv({ ...MINIMUM, PORT: '9999' })).not.toHaveProperty('PORT');
  });

  it('does not require database credentials', () => {
    // The point of a separate schema. The web app is the process reachable from
    // a browser; anything it can read is one bug away from being served.
    expect(() => loadWebEnv(MINIMUM)).not.toThrow();
  });

  it('fails when the API address is missing', () => {
    expect(() => loadWebEnv({})).toThrow(EnvironmentError);
  });

  it.each([['api:3000'], ['/api'], ['not a url'], ['']])(
    'rejects %j as an API address',
    (value) => {
      // A relative or malformed URL fails at the first fetch, inside a rendered
      // page, as a blank screen. Catching it at startup is the whole design.
      expect(() => loadWebEnv({ API_BASE_URL: value })).toThrow(EnvironmentError);
    },
  );

  it('reports every problem at once', () => {
    try {
      loadWebEnv({ API_BASE_URL: 'nope', NODE_ENV: 'staging' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentError);
      expect((error as EnvironmentError).problems.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('marks production', () => {
    expect(loadWebEnv({ ...MINIMUM, NODE_ENV: 'production' }).isProduction).toBe(true);
    expect(loadWebEnv(MINIMUM).isProduction).toBe(false);
  });
});
