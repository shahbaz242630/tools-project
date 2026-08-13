import { NoticePage } from '../components/notice-page';

export const metadata = { title: 'Page not found' };

/**
 * The 404 (slice D3).
 *
 * **The wording has to cover more than a mistyped URL**, because the commonest
 * way to reach this page is a listing that was published and is no longer
 * visible — paused by its owner, or hidden by a moderator. `findPublic` answers
 * null for all of those deliberately, so that a stranger cannot tell them apart
 * and cannot audit our moderation decisions from outside. This page is the other
 * half of that decision: it must not say "this listing was removed" either.
 */
export default function NotFound() {
  return (
    <NoticePage overline="404" heading="This page doesn't exist.">
      The link may be old, or whatever it pointed at may have been taken down by its
      owner.
    </NoticePage>
  );
}
