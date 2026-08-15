'use client';

import { NoticePage } from '../../components/notice-page';

/**
 * When something throws anywhere under `/listings` (Phase 0–3 audit).
 *
 * **It earns its place on one sentence.** The root boundary says "nothing you
 * did caused this", which is true everywhere and useless here: this segment
 * holds the create form, the edit form, and the buttons that publish and pause,
 * so the question an owner actually has is whether the thing they just pressed
 * half-happened. It did not — every write here is a single API call that either
 * completed or did not, and a render that throws afterwards changes nothing.
 * Saying so is the whole reason for the file, and it is the wording
 * `listing-list.tsx` already uses when a read fails.
 *
 * `retry` rather than `reset`, for the reason written out in `app/error.tsx`.
 */
export default function ListingsError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <NoticePage
      overline="Your listings"
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
      Everything you have listed is still there. Nothing has been published, paused,
      changed or deleted by this — try again in a moment.
    </NoticePage>
  );
}
