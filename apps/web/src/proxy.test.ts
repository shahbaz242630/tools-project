/**
 * What the proxy protects, asserted by running the rule rather than by reading
 * the list it was built from.
 *
 * `clerkMiddleware` is the only thing faked, and only so the handler it is given
 * can be called directly — the predicate under test is ours, and a test that
 * asserted "we passed Clerk a list containing /admin" would be asserting the
 * list back to itself.
 *
 * **The failing case this was written for:** with a bare `clerkMiddleware()`,
 * nothing is handed a handler at all, so `captured.handler` stays null and every
 * assertion below throws. That is the defect — an anonymous visitor clicking the
 * header's "List a tool" reached `/listings/new` and was served the page.
 */

import { describe, expect, it, vi } from 'vitest';

type Protect = () => Promise<void>;
type Handler = (
  auth: { protect: Protect },
  request: { nextUrl: URL },
  event: unknown,
) => unknown;

const captured = vi.hoisted(() => ({ handler: null as Handler | null }));

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: (given: unknown) => {
    captured.handler = typeof given === 'function' ? (given as Handler) : null;
    return () => undefined;
  },
}));

import { config } from './proxy';

/** Whether a request for this path is made to prove a session. */
async function protects(pathname: string): Promise<boolean> {
  const handler = captured.handler;
  if (handler === null) {
    throw new Error('clerkMiddleware was given no handler, so nothing is protected');
  }

  const protect = vi.fn<Protect>().mockResolvedValue(undefined);
  await handler(
    { protect },
    { nextUrl: new URL(`https://example.test${pathname}`) },
    {},
  );

  return protect.mock.calls.length > 0;
}

describe('the proxy', () => {
  it.each([
    '/account',
    '/account/profile',
    '/account/activity',
    '/account/data',
    '/account/delete',
    '/admin',
    '/admin/categories',
    '/admin/approvals',
    '/admin/feature-flags',
    '/admin/users',
    '/admin/listings',
    '/admin/activity',
    '/listings',
    '/listings/new',
    '/listings/11111111-1111-4111-8111-111111111111',
    '/listings/11111111-1111-4111-8111-111111111111/edit',
  ])('sends an anonymous visitor to sign in for %s', async (pathname) => {
    expect(await protects(pathname)).toBe(true);
  });

  it.each([
    '/',
    '/browse',
    '/hire/11111111-1111-4111-8111-111111111111',
    '/users/11111111-1111-4111-8111-111111111111',
    '/sign-in',
    '/sign-up',
    '/status',
  ])('leaves %s open to somebody with no account', async (pathname) => {
    expect(await protects(pathname)).toBe(false);
  });

  /*
   * Its own case rather than another row above, because getting this wrong
   * breaks identity itself rather than a page. Clerk cannot hold a session, so
   * the webhook route authenticates by verifying the delivery's signature — a
   * sign-in redirect in front of it would silently stop every `user.created`
   * from ever reaching the mirror, with nothing failing loudly.
   */
  it('leaves the Clerk webhook reachable, because it has no session to prove', async () => {
    expect(await protects('/api/webhooks/clerk')).toBe(false);
  });

  /*
   * A prefix is not a path. `/listingsomething` shares eleven characters with
   * `/listings` and is a different route; a `startsWith` on the bare prefix
   * would protect it, which is the failure that refuses real visitors from a
   * page nobody meant to close.
   */
  it('matches whole segments rather than string prefixes', async () => {
    expect(await protects('/listingsomething')).toBe(false);
    expect(await protects('/accounts-payable')).toBe(false);
    expect(await protects('/administrators')).toBe(false);
  });

  it('still runs on every route that is not a static asset', () => {
    expect(config.matcher).toContain('/(api|trpc)(.*)');
  });
});
