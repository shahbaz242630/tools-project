import Link from 'next/link';
import { fetchFeatureFlags } from '../../lib/admin-feature-flags';

/**
 * Whether this viewer may operate an administrative control, and one place to
 * say so when they may not.
 *
 * **The defect it exists to close.** Slice 2.1 fixed it on `/admin/categories`:
 * the list correctly said "you do not have access", and directly underneath sat
 * a complete, enabled form inviting the same person to create a category. Every
 * test passed, because each half was right on its own. Four pages still did it —
 * `/admin/approvals`, `/admin/users`, `/admin/activity` and `/admin/listings` —
 * and two of those performed no read at all, so they had nothing that could
 * refuse before the form did.
 *
 * **This is not an authorisation check and must never become one.** ADR 0021 is
 * explicit that the admin page does not check the role: the API does, on every
 * request, with the second factor, and a check here would be a second place for
 * the rule to live and the easier of the two to get wrong. What this does is
 * *ask the API* and render its answer. Hiding a form protects nothing — the
 * endpoint holds the data — but showing one that cannot work is a lie about what
 * the reader can do.
 *
 * **Why the flag list is the question asked.** A page with no read of its own
 * needs one, and it must be refused by exactly the guard that will refuse the
 * write: the role, a second factor verified in the last twelve hours (ADR 0021),
 * and not being suspended (ADR 0024 — no admin route opts in). `GET
 * /admin/feature-flags` is the cheapest read that satisfies all three. It takes
 * no reason and writes no audit entry, unlike the account routes, so using it as
 * the question does not put a row in somebody's trail that nobody asked for. The
 * flags themselves are thrown away; the *refusal* is the answer.
 *
 * The honest version of this is an API route that answers "may I administer",
 * and it should replace this the moment the API is being changed for another
 * reason. Until then a borrowed read beats a page that guesses.
 */
export type AdminAccess =
  | { readonly kind: 'permitted' }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'forbidden' }
  /** The API did not answer, so nothing can be claimed either way. */
  | { readonly kind: 'unknown'; readonly reason: string };

/**
 * Read an admin outcome as an access answer.
 *
 * Structural on purpose: every admin client in `lib/` uses the same member names
 * for the same meanings, deliberately, so a page that already performs its own
 * admin read — `/admin/approvals` reads the approval queue — can gate on that
 * rather than paying for a second request.
 */
export function accessFrom(outcome: {
  readonly kind: string;
  readonly reason?: string;
}): AdminAccess {
  switch (outcome.kind) {
    case 'loaded':
      return { kind: 'permitted' };
    case 'signed-out':
      return { kind: 'signed-out' };
    case 'forbidden':
      return { kind: 'forbidden' };
    default:
      // `not-found`, `invalid`, `taken` and the rest cannot arise from a plain
      // read. Reported as unknown rather than silently treated as permitted,
      // because "we did not understand the answer" is not "yes".
      return {
        kind: 'unknown',
        reason: outcome.reason ?? `unexpected response (${outcome.kind})`,
      };
  }
}

export async function adminAccess(
  apiBaseUrl: string,
  token: string | null,
  clientIp: string | null = null,
): Promise<AdminAccess> {
  return accessFrom(await fetchFeatureFlags(apiBaseUrl, token, undefined, clientIp));
}

/**
 * Why a control is not on the page.
 *
 * Every refusal gets its own sentence. A single "something went wrong" would
 * make an expired session, a missing second factor and an unreachable API look
 * identical, and only one of those is fixed by signing in again.
 */
export function AdminAccessNotice({
  access,
  controls,
}: {
  readonly access: Exclude<AdminAccess, { kind: 'permitted' }>;
  /** What is missing, named the way the page names it. */
  readonly controls: string;
}) {
  switch (access.kind) {
    case 'signed-out':
      return (
        <p role="alert">
          You are not signed in. Your session may have expired —{' '}
          <Link href="/sign-in">sign in</Link> to use {controls}.
        </p>
      );

    case 'forbidden':
      return (
        <p role="alert">
          You do not have access to this, so {controls} is not shown. Administrator
          access needs the role <strong>and</strong> a second factor verified in the
          last 12 hours — if you have one, sign in again with it.
        </p>
      );

    case 'unknown':
      return (
        <p role="alert">
          We could not check whether you may do this, so {controls} is not shown —{' '}
          {access.reason}. <strong>Nothing has been changed.</strong> Try again in a
          moment.
        </p>
      );
  }
}
