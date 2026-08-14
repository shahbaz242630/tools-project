import { NoticePage } from '../components/notice-page';
import { BROWSE_PATH } from '../lib/page-paths';

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
 *
 * **It offers Browse from slice 3.1e**, which the design always drew and D3
 * withheld because search did not exist. That is also why it is the *primary*
 * action here: the commonest way to reach this page is a listing that is gone,
 * and the useful answer to "the thing you wanted is not here" is a way to look
 * for another one — not the front page.
 */
export default function NotFound() {
  return (
    <NoticePage
      overline="404"
      heading="This page doesn't exist."
      primaryLink={{ href: BROWSE_PATH, label: 'Browse tools' }}
    >
      The link may be old, or whatever it pointed at may have been taken down by its
      owner.
    </NoticePage>
  );
}
