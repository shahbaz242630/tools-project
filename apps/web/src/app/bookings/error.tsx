'use client';

import { NoticePage } from '../../components/notice-page';

/**
 * When something throws under `/bookings` (slice 4.8b).
 *
 * **It earns its place on one sentence, and it is a different sentence from the
 * listings boundary's.** That segment holds forms and buttons, so the question
 * an owner has there is whether the thing they pressed half-happened. This page
 * has no controls at all — it only reads — so nobody arriving here has just
 * changed anything. What they need to know is that a page which failed to draw
 * has not touched a hire either of them is relying on, and in particular that an
 * accepted booking is still accepted.
 *
 * `retry` rather than `reset`, for the reason written out in `app/error.tsx`.
 */
export default function BookingsError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <NoticePage
      overline="Your bookings"
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
      Every booking you are part of is still exactly as it was. This page only reads
      them — nothing here has been accepted, declined or cancelled by this.
    </NoticePage>
  );
}
