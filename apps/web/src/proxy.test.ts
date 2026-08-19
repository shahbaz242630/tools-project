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

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
    '/bookings',
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

/**
 * Every page and route handler in the app, read off disk.
 *
 * **The tests above enumerate paths somebody typed, which is why they were all
 * green while `/bookings` was open to strangers.** They can only assert about
 * routes a person remembered; they have no way to know a route exists. So this
 * block asks the filesystem instead, and the declaration below is the *only*
 * place a new page can be answered for — leave it out and the first test here
 * fails, naming the route.
 *
 * Deriving from `page.tsx` and `route.ts` is what App Router itself does, so
 * this cannot drift from the real route table without the route table moving.
 */
const APP_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'app');

/** Whether a signed-out visitor may be served this route. */
const CLASSIFIED: Readonly<Record<string, 'signed-in' | 'public'>> = {
  '/': 'public',
  '/account': 'signed-in',
  '/account/activity': 'signed-in',
  '/account/data': 'signed-in',
  '/account/data/download': 'signed-in',
  '/account/delete': 'signed-in',
  '/account/email/[[...rest]]': 'signed-in',
  '/account/profile': 'signed-in',
  '/admin': 'signed-in',
  '/admin/activity': 'signed-in',
  '/admin/approvals': 'signed-in',
  '/admin/categories': 'signed-in',
  '/admin/feature-flags': 'signed-in',
  '/admin/listings': 'signed-in',
  '/admin/users': 'signed-in',
  // Clerk cannot hold a session and signs the delivery instead (slice 1.2).
  // A sign-in redirect here would stop every `user.created` reaching the
  // mirror, with nothing failing loudly.
  '/api/webhooks/clerk': 'public',
  '/bookings': 'signed-in',
  '/browse': 'public',
  '/hire/[id]': 'public',
  '/listings': 'signed-in',
  '/listings/[id]': 'signed-in',
  '/listings/[id]/calendar': 'signed-in',
  '/listings/[id]/edit': 'signed-in',
  '/listings/new': 'signed-in',
  '/sign-in/[[...sign-in]]': 'public',
  '/sign-up/[[...sign-up]]': 'public',
  '/status': 'public',
  '/users/[userId]': 'public',
};

/** Every route App Router will serve, as its bracketed pattern. */
function routePatternsOnDisk(directory: string, prefix = ''): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      /*
       * A parenthesised segment is a route group — it organises files and
       * contributes nothing to the URL. There are none today; handling it here
       * means the first one added does not silently mint a route this test
       * then reports as unclassified.
       */
      const segment = /^\(.*\)$/.test(entry.name) ? '' : `/${entry.name}`;
      found.push(
        ...routePatternsOnDisk(path.join(directory, entry.name), prefix + segment),
      );
      continue;
    }

    if (entry.name === 'page.tsx' || entry.name === 'route.ts') {
      found.push(prefix === '' ? '/' : prefix);
    }
  }

  return found;
}

/** The pattern as a URL a browser could actually ask for. */
function sampleUrlFor(pattern: string): string {
  const filled = pattern
    // An optional catch-all matches the bare parent, which is the case that
    // matters: `/sign-in` is what somebody types, not `/sign-in/anything`.
    .replace(/\/\[\[\.\.\..+?\]\]/g, '')
    .replace(/\[.+?\]/g, '11111111-1111-4111-8111-111111111111');

  return filled === '' ? '/' : filled;
}

describe('every route the app serves', () => {
  const onDisk = routePatternsOnDisk(APP_DIRECTORY).sort();

  /*
   * The test `/bookings` would have failed. It is first because the other two
   * are only meaningful once the set they run over is known to be complete.
   */
  it('is classified as needing a session or not', () => {
    expect(onDisk.filter((pattern) => CLASSIFIED[pattern] === undefined)).toEqual([]);
  });

  it('has no classification for a route that no longer exists', () => {
    expect(
      Object.keys(CLASSIFIED)
        .filter((p) => !onDisk.includes(p))
        .sort(),
    ).toEqual([]);
  });

  it.each(Object.entries(CLASSIFIED))(
    'treats %s as %s',
    async (pattern, classification) => {
      expect(await protects(sampleUrlFor(pattern))).toBe(
        classification === 'signed-in',
      );
    },
  );
});
