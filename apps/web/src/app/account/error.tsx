'use client';

import { NoticePage } from '../../components/notice-page';

/**
 * When something throws anywhere under `/account` (Phase 0–3 audit).
 *
 * **The segment holds the two irreversible things in the application** — the
 * deletion page and the data export — plus the profile form and the address that
 * BRD §10.1 keeps encrypted. Somebody who has just pressed a button in here and
 * met an error page needs to be told which of those happened, and the answer is
 * none of them: an error rendering a page is not a request that half-succeeded,
 * and deletion in particular is a separate confirmed step that this cannot have
 * started.
 *
 * That is the sentence the root boundary cannot say, and it is why this file
 * exists rather than inheriting.
 *
 * `retry` rather than `reset`, for the reason written out in `app/error.tsx`.
 */
export default function AccountError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <NoticePage
      overline="Your account"
      heading="That didn't load."
      action={
        <button
          type="button"
          onClick={() => {
            retry();
          }}
        >
          Try again
        </button>
      }
    >
      Nothing about your account has been changed, downloaded or deleted. Try again in a
      moment.
    </NoticePage>
  );
}
