/**
 * What an owner is told about who can see their listing (ADR 0041, slice 2.8c-ii).
 *
 * **Extracted from the page rather than left in it**, and the reason is this
 * project's own coverage rule: App Router pages are composition roots, excluded
 * from the thresholds and not unit tested, while presentational components live
 * here and are counted. `StatusLine` had been in the page since 2.8a and has now
 * produced the same defect three times — a sentence derived from one authority
 * when the truth takes two. A line with that history belongs somewhere a test can
 * hold it.
 *
 * **No `use client`.** Neither of these has state, an effect or a handler, so they
 * render on the server like the rest of the presentational components here; the
 * directive would ship them to the browser for nothing.
 */

import type { ListingStatus, OwnerListing } from '@platform/contracts';

export function StatusLine({
  status,
  visible,
}: {
  readonly status: ListingStatus;
  readonly visible: boolean;
}) {
  switch (status) {
    case 'PUBLISHED':
      return visible ? (
        <>
          <strong>Published.</strong> People can find this and book it. The map shows an
          approximate point, never your address.
        </>
      ) : (
        <>
          {/*
            **"You have published this" and "people can find it" are two claims,
            and only the first is the owner's to make.** The sentence stops after
            the part that is still true and hands the rest to `ModerationNotice`,
            rather than repeating a promise the platform is currently refusing.
          */}
          <strong>Published, but not visible.</strong> You have this published — nothing
          you set has changed — and the platform is holding it back while the note below
          applies.
        </>
      );
    case 'PAUSED':
      return (
        <>
          <strong>Paused.</strong> Nobody can find this or book it while it is paused.
          Everything you have written is kept, and you can put it back up whenever you
          like.
        </>
      );
    case 'DRAFT':
      return (
        <>
          <strong>Draft.</strong> Nobody else can see this and nobody can book it.
        </>
      );
    default: {
      // Exhaustiveness, checked by the compiler rather than by review.
      const unhandled: never = status;
      return <>{String(unhandled)}</>;
    }
  }
}

/**
 * What the platform has decided, and why — slice 2.8c-ii.
 *
 * **A separate block from `StatusLine`, because they answer to different people.**
 * ADR 0041 split the two authorities in the schema precisely so a rejection could
 * not overwrite an owner's intent; merging them back into one sentence here would
 * undo that where it is actually read. So the owner sees what they set, and then —
 * only when it matters — what the platform did about it.
 *
 * **`APPROVED` renders nothing at all, deliberately.** It is the default and the
 * absence of a decision rather than the result of one: §8.3 makes moderation
 * something that *flags*, not a gate every listing waits at. A page announcing
 * "approved" would tell every owner their listing had been reviewed, which is
 * false for all but a handful and is the kind of false comfort that becomes a
 * complaint the first time something prohibited stays up for a week.
 *
 * **`UNDER_REVIEW` and `REJECTED` ask opposite things of the reader** — wait, or
 * fix it and come back — which is the whole argument for their being two states
 * (ADR 0041). The copy has to differ accordingly or the distinction is decorative.
 *
 * **No email is sent, and the copy does not imply one.** Notifications are
 * Phase 6; until then this page is the entire channel, so it tells the owner to
 * check back rather than promising to be in touch — a promise nothing would keep.
 */
export function ModerationNotice({ listing }: { readonly listing: OwnerListing }) {
  if (listing.moderationState === 'APPROVED') return null;

  const reviewing = listing.moderationState === 'UNDER_REVIEW';

  return (
    /*
     * `role="alert"` rather than `status`: this is the one thing on the page the
     * owner has not been told anywhere else, and it is the reason their item is
     * not earning. The status line above is `role="status"` — it changes when they
     * act, so it is polite; this changes when *somebody else* acts.
     */
    <section aria-labelledby="moderation" role="alert">
      <h2 id="moderation">
        {reviewing ? 'This listing is being reviewed' : 'This listing was not allowed'}
      </h2>

      <p>
        {reviewing ? (
          <>
            Somebody at the platform is looking at this listing, so it is hidden from
            everybody else while they do.{' '}
            <strong>You do not need to change anything</strong> — and nothing you have
            written has been altered or lost.
          </>
        ) : (
          <>
            The platform has refused this listing, so nobody else can find it or book
            it. <strong>Everything you wrote is still here</strong>, and it becomes
            visible again if the decision is reversed.
          </>
        )}
      </p>

      {/*
        **The reason, exactly as it was written** (ADR 0024's rule for suspension).
        A `blockquote` because it is somebody else's words and not the platform
        speaking in its own voice — the distinction matters when the words are a
        refusal.

        Null is possible in the type and not in practice for these two states: the
        service refuses them without a reason and a CHECK constraint refuses them
        again. The branch exists because a page must not render "why: null", and
        because the honest sentence for a state that somehow arrived without one is
        that we cannot show what we were not given.
      */}
      {listing.moderationReason === null ? (
        <p>
          No reason was recorded, which should not happen. Ask us and we will tell you
          what we know.
        </p>
      ) : (
        <>
          <p>{reviewing ? 'Why it is being reviewed:' : 'Why it was refused:'}</p>
          <blockquote>{listing.moderationReason}</blockquote>
        </>
      )}

      <p>
        {reviewing
          ? 'Check back here — this page shows the current decision. We do not send an email about it yet.'
          : 'If you think this is wrong, get in touch. This page shows the current decision; we do not send an email about it yet.'}
      </p>
    </section>
  );
}
