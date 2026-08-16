import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Each test imports the module fresh, because `webEnv` memoises at module
 * scope — which is the behaviour under test, and would otherwise leak the
 * first test's environment into every later one.
 */
async function freshWebEnv() {
  vi.resetModules();
  return (await import('./env')).webEnv;
}

/**
 * Everything `loadWebEnv` requires beyond the variable under test.
 *
 * Stubbed rather than omitted because the schema reports *every* problem at
 * once: a test that set only `API_BASE_URL` would fail with the Clerk keys in
 * the message, pointing at the wrong thing entirely.
 */
function stubRequired(): void {
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test_example');
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_example');
  vi.stubEnv('CLERK_WEBHOOK_SIGNING_SECRET', 'whsec_test_example');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * Load the module graph once, before anything is timed.
 *
 * The same flake and the same fix as `packages/database/src/prisma-config.test.ts`,
 * whose `beforeAll` carries the full diagnosis: a dynamic `import` inside the
 * body means the **first** test is billed for the whole file's dependency tree,
 * `vi.resetModules` does not make the re-import expensive again, and under a
 * saturated parallel run that one-off crosses the test timeout — surfacing as
 * *"Test timed out in 5000ms"* on whichever file lost the race.
 *
 * Stubbed here too, because `loadWebEnv` throws on an incomplete environment
 * and a warm-up that throws is a warm-up that failed to warm anything.
 */
beforeAll(async () => {
  stubRequired();
  vi.stubEnv('API_BASE_URL', 'http://localhost:3001');
  await freshWebEnv();
  vi.unstubAllEnvs();
});

describe('webEnv', () => {
  it('reads the validated environment', async () => {
    stubRequired();
    vi.stubEnv('API_BASE_URL', 'http://api:3000');
    const webEnv = await freshWebEnv();
    expect(webEnv().API_BASE_URL).toBe('http://api:3000');
  });

  it('reads the environment once and caches it', async () => {
    stubRequired();
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
    stubRequired();
    vi.stubEnv('API_BASE_URL', 'not-a-url');
    const webEnv = await freshWebEnv();
    expect(() => webEnv()).toThrow(/API_BASE_URL/);
  });

  it('throws when a Clerk key is missing', async () => {
    // Clerk's SDK reads these from process.env itself, so without validating
    // them here the failure arrives at the first sign-in as a stack trace from
    // inside node_modules rather than at startup naming the variable.
    vi.stubEnv('API_BASE_URL', 'http://api:3000');
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', '');
    vi.stubEnv('CLERK_SECRET_KEY', '');

    const webEnv = await freshWebEnv();
    expect(() => webEnv()).toThrow(/CLERK/);
  });
});
