'use client';

import { NoticePage } from '../components/notice-page';

/**
 * The error boundary (slice D3).
 *
 * **A client component, and it has to be** — React error boundaries are a client
 * feature, and Next requires this file to declare it.
 *
 * **It shows the visitor nothing about the failure**, which is not politeness: an
 * unhandled server error can carry a stack trace, a query, or a row that was
 * mid-flight, and this page is reachable by anybody. Next already strips the
 * message in production for the same reason. What a person needs here is to know
 * it was not their fault and that trying again is worth doing.
 *
 * The `error` prop is accepted and unused rather than omitted, because Next
 * passes it and the signature is the contract. When an error-tracking adapter
 * exists (ADR 0008) this is where the report is raised, and having the argument
 * already named is what stops that becoming a signature change.
 *
 * **`retry`, not `reset` — and the difference is whether the button works.**
 * Next 16.3 made `retry` the stable prop and gave the two distinct meanings:
 * `retry` refreshes the router and *then* clears the error, so the failed server
 * read is done again; `reset` only clears the error state, which re-renders the
 * same cached failure. Every page under this boundary fails for one reason — a
 * server fetch that timed out or was refused — so `reset` gave this button a
 * label promising something it could not do. Read out of
 * `next/dist/client/components/error-boundary.js` rather than assumed, because
 * both props are still passed and neither errors.
 *
 * **It stays at the root and stays generic.** Three segments below it say
 * something more specific (`/listings`, `/account`, `/admin`); `/browse` and
 * `/hire/[id]` deliberately do not, because on those pages "try again" *is* the
 * whole of the useful advice and a boundary that repeats its parent is one more
 * file to keep in step for nothing.
 */
export default function Error({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <NoticePage
      overline="Something went wrong"
      heading="That didn't work."
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
      Nothing you did caused this. Try again in a moment.
    </NoticePage>
  );
}
