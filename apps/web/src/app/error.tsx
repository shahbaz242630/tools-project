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
 */
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <NoticePage
      overline="Something went wrong"
      heading="That didn't work."
      action={
        <button type="button" onClick={reset}>
          Try again
        </button>
      }
    >
      Nothing you did caused this. Try again in a moment.
    </NoticePage>
  );
}
