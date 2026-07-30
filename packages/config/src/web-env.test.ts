import { describe, expect, it } from 'vitest';
import { EnvironmentError } from './env.js';
import { loadWebEnv } from './web-env.js';

const MINIMUM = {
  API_BASE_URL: 'http://api:3000',
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_example',
  CLERK_SECRET_KEY: 'sk_test_example',
  CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_test_example',
};

describe('loadWebEnv', () => {
  it('needs the API address and the Clerk keys', () => {
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

  const CLERK_KEYS = [
    'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
    'CLERK_SECRET_KEY',
    'CLERK_WEBHOOK_SIGNING_SECRET',
  ];

  it.each(CLERK_KEYS)('fails when %s is missing', (key) => {
    // Clerk's SDK reads these from process.env itself, so without declaring
    // them here a missing key surfaces at the first sign-in as a stack trace
    // from inside node_modules rather than at startup naming the variable.
    const without = Object.fromEntries(
      Object.entries(MINIMUM).filter(([name]) => name !== key),
    );
    expect(() => loadWebEnv(without)).toThrow(EnvironmentError);
  });

  it('still refuses database credentials', () => {
    // Holding the Clerk secret key does not soften the rule this schema exists
    // for. The web app has no reason to reach Postgres, and the day it can is
    // the day a rendering bug can serve rows.
    const env = loadWebEnv({ ...MINIMUM, POSTGRES_PASSWORD: 'hunter2' });
    expect(env).not.toHaveProperty('POSTGRES_PASSWORD');
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
