import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Each test imports the module fresh, because `webEnv` memoises at module
 * scope — which is the behaviour under test, and would otherwise leak the
 * first test's environment into every later one.
 */
async function freshWebEnv() {
  vi.resetModules();
  return (await import('./env')).webEnv;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('webEnv', () => {
  it('reads the validated environment', async () => {
    vi.stubEnv('API_BASE_URL', 'http://api:3000');
    const webEnv = await freshWebEnv();
    expect(webEnv().API_BASE_URL).toBe('http://api:3000');
  });

  it('reads the environment once and caches it', async () => {
    vi.stubEnv('API_BASE_URL', 'http://api:3000');
    const webEnv = await freshWebEnv();

    const first = webEnv();
    // Changing the environment after the first read must not change the answer.
    // A per-request re-read would let a half-applied environment change take
    // effect between two renders of the same page.
    vi.stubEnv('API_BASE_URL', 'http://elsewhere:9999');

    expect(webEnv()).toBe(first);
    expect(webEnv().API_BASE_URL).toBe('http://api:3000');
  });

  it('does not read the environment until called', async () => {
    // The reason this is lazy: `next build` evaluates module scope, and a build
    // machine has no API. Importing must not throw.
    vi.stubEnv('API_BASE_URL', '');
    await expect(freshWebEnv()).resolves.toBeTypeOf('function');
  });

  it('throws when the environment is invalid, at call time', async () => {
    vi.stubEnv('API_BASE_URL', 'not-a-url');
    const webEnv = await freshWebEnv();
    expect(() => webEnv()).toThrow(/API_BASE_URL/);
  });
});
