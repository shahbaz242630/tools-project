import { clerkMiddleware } from '@clerk/nextjs/server';

/**
 * Everything a signed-out visitor must not be handed the shell of.
 *
 * **A prefix list rather than Clerk's `createRouteMatcher`, deliberately.** That
 * helper is deprecated in `@clerk/nextjs` 7 and is slated for removal in the
 * next major, and it hides the rule inside a glob dialect nobody here reads
 * twice. Three literal prefixes and one `startsWith` are the whole rule, and
 * they can be argued with.
 *
 * **This is authentication, not authorisation, and the difference is the point.**
 * `auth.protect()` asks only "is somebody signed in". It does not ask whether
 * they are an administrator: ADR 0021 puts that at the API, on every request,
 * with the second factor, and a role check here would be a second place for the
 * rule to live and the easier of the two to get wrong. `/admin` is in this list
 * so a stranger is sent to sign in rather than shown the admin information
 * architecture — the links to approvals, feature flags, users and listings are
 * themselves a disclosure, even with every one of them refusing the data.
 *
 * **It is a redirect, not a control.** Clerk's own deprecation notice says why:
 * middleware matches paths, and path matching can diverge from how Next routes
 * a request. Every page below still refuses on its own, and the API refuses
 * regardless of what this file thinks — which is what made the bug this fixes
 * survive so long. A bare `clerkMiddleware()` attached auth context and
 * protected nothing, so `/admin/categories`, `/listings/new`, `/listings` and
 * `/account` all answered 200 to an anonymous visitor and drew their full page
 * shell. Nothing private leaked, because the API held the line. They should
 * still never have rendered.
 *
 * **What is deliberately absent.** `/` , `/browse`, `/hire/…`, `/users/…`,
 * `/sign-in`, `/sign-up` and `/status` are public and must stay reachable
 * without a session — `/browse` and `/hire` are the whole product to a stranger.
 * `/api/webhooks/clerk` is public by necessity: Clerk cannot hold a session, and
 * that route verifies a signature instead (slice 1.2).
 */
const SIGNED_IN_ONLY_PREFIXES = ['/account', '/admin', '/listings'] as const;

/**
 * Exact segment matching, never a bare `startsWith` on the prefix alone.
 *
 * `/listings` must be protected and so must `/listings/new`, but a future
 * `/listingsomething` is a different route and would be caught by the sloppier
 * test — silently, and in the direction that refuses real visitors.
 */
function requiresSignIn(pathname: string): boolean {
  return SIGNED_IN_ONLY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export default clerkMiddleware(async (auth, request) => {
  if (requiresSignIn(request.nextUrl.pathname)) await auth.protect();
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
