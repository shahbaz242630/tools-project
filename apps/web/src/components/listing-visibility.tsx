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

import { isPubliclyVisible } from '@platform/contracts';
import type { ListingStatus, ModerationState, OwnerListing } from '@platform/contracts';
import styles from './listing-visibility.module.css';

/**
 * The same truth as {@link StatusLine}, in the few words a table cell has
 * (slice 2.9a).
 *
 * **Here rather than in the list component, because this file is where the
 * vocabulary lives.** `StatusLine` produced the same defect three times — a
 * sentence derived from one authority when the truth takes two — and a second
 * rendering of listing state written somewhere else would be the fourth. Both
 * now sit in one file, and a state added to either vocabulary is a compile error
 * in both.
 *
 * **It takes the two fields and asks `isPubliclyVisible` itself**, where
 * `StatusLine` takes a `visible` boolean its caller computed. That asymmetry is
 * deliberate and this is the safer of the two: a caller that can pass a boolean
 * is a caller that can pass `status === 'PUBLISHED'`, which is exactly the
 * comparison ADR 0041 made into a leak. Nothing here can be handed a wrong
 * answer, because it is not handed an answer at all.
 *
 * **Moderation is read before status**, which is the ordering decision worth
 * knowing. A rejected *draft* is a real combination — moderation and publication
 * are independent authorities — and a cell reading "Draft" would hide the more
 * important half. What the platform has decided outranks what the owner set,
 * because it is the part they did not already know.
 */
export function VisibilityLabel({
  status,
  moderationState,
}: {
  readonly status: ListingStatus;
  readonly moderationState: ModerationState;
}) {
  // **The rule gates the claim, and nothing else may.** Every other branch below
  // only explains why the answer was no, so no rewording of an explanation can
  // ever put "anyone can find it" in front of a listing nobody can.
  if (isPubliclyVisible(status, moderationState)) {
    // Green, per the design — and the words stay, because colour must never be
    // the only thing carrying the state (WCAG 1.4.1).
    return <span className={styles.live}>Live — anyone can find it</span>;
  }

  switch (moderationState) {
    case 'UNDER_REVIEW':
      return <>Being reviewed — hidden</>;
    case 'REJECTED':
      return <span className={styles.refused}>Refused — hidden</span>;
    case 'APPROVED':
      break;
    default: {
      const unhandled: never = moderationState;
      return <>{String(unhandled)}</>;
    }
  }

  // Approved, and still not visible — so this half is the owner's own doing.
  switch (status) {
    case 'PAUSED':
      return <>Paused by you</>;
    case 'DRAFT':
      return <>Draft — only you</>;
    /* c8 ignore next 8 -- unreachable by construction, and cased rather than
       defaulted on purpose. A published listing that reached here would have to
       be `APPROVED` (the switch above returned for everything else) and not
       publicly visible, which `isPubliclyVisible` cannot say of that pair. It is
       written out so a **fourth status** is a compile error here rather than a
       blank cell, which is what a `default` would have given it. The first draft
       of this component reached this line through a different route and rendered
       dead copy nobody could ever be shown. */
    case 'PUBLISHED':
      return <span className={styles.live}>Published</span>;
    default: {
      const unhandled: never = status;
      return <>{String(unhandled)}</>;
    }
  }
}

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
    <section className={styles.notice} aria-labelledby="moderation" role="alert">
      <h2 id="moderation" className={styles.noticeHeading}>
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

        **And it no longer says "ask us", which is what it said until the Phase
        0–3 audit.** There is nobody to ask: no contact page, no email channel
        until Phase 6, and by this platform's own principle no support desk after
        it either. Pointing somebody at a door that does not open is a worse
        answer than saying the page holds everything we have — especially here,
        where the reader has just been refused and is looking for a person.
      */}
      {listing.moderationReason === null ? (
        <p>
          No reason was recorded, which should not happen. This page holds everything we
          can show you about the decision.
        </p>
      ) : (
        <>
          <p>{reviewing ? 'Why it is being reviewed:' : 'Why it was refused:'}</p>
          <blockquote className={styles.reason}>{listing.moderationReason}</blockquote>
        </>
      )}

      {/*
        **Neither branch offers a channel, and the refused one used to.** It read
        "If you think this is wrong, get in touch" — an appeal route with nothing
        behind it: there is no contact page, messaging is Phase 6, and the
        platform's own rule is that no support desk is coming. The reader most
        likely to act on that sentence is the one most owed a true answer, so it
        now says plainly that there is nowhere to appeal yet and that this page
        is where a reversal would show up.

        **The reviewing branch is unchanged**, because "check back here" was
        already the honest instruction rather than a promise — the same reasoning
        that keeps both branches from implying an email.
      */}
      <p>
        {reviewing
          ? 'Check back here — this page shows the current decision. We do not send an email about it yet.'
          : 'There is no way to challenge this yet. This page shows the current decision, and it is where a reversal would appear; we do not send an email about it.'}
      </p>
    </section>
  );
}
