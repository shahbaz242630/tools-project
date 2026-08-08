'use client';

import { useActionState, useEffect, useRef } from 'react';
import type { ListingStatus } from '@platform/contracts';
import { publishListingAction } from '../app/listings/[id]/actions';
import { INITIAL_PUBLICATION_STATE } from '../app/listings/[id]/publication-state';

/**
 * The publish control and what it says when it refuses (§8.3, slice 2.8a).
 *
 * **The button holds no state of its own**, which is why the React 19 form-reset
 * defect that bit 2.4c-i, 2.5a and 2.7a cannot reach it: there is nothing typed
 * into this form to lose. The only input is a hidden listing id, and that is
 * re-rendered from a prop rather than restored from an attribute.
 *
 * The blockers come from the API and are rendered as a list rather than as one
 * joined sentence. Seven unmet requirements read as a checklist and not as a
 * paragraph, and the owner has to work through them one at a time either way.
 */
export function PublishListingForm({
  listingId,
  status,
  publicationAvailable,
}: {
  readonly listingId: string;
  readonly status: ListingStatus;
  /**
   * Whether the platform is accepting publications right now (slice H3b).
   *
   * **This disables the button; it does not replace the server's check.** The
   * value was true when this page was rendered and may not be by the time
   * somebody presses the button, so the API asks again and answers 503 either
   * way. Removing the server-side check because the button is disabled would be
   * the classic mistake of treating an interface affordance as a control.
   */
  readonly publicationAvailable: boolean;
}) {
  const [state, action, pending] = useActionState(
    publishListingAction,
    INITIAL_PUBLICATION_STATE,
  );
  const outcome = useRef<HTMLDivElement>(null);

  /**
   * Move to the refusal, rather than leaving it above the fold.
   *
   * Session 25 found this the hard way: the listing form's message rendered
   * 240px above the viewport and read as a button that did nothing. This page is
   * longer than that form.
   *
   * **Keyed on the whole state, not on `state.message`.** Two identical refusals
   * compare equal, and an effect that skips the second one leaves the page
   * perfectly still exactly when somebody is most likely to conclude it is
   * stuck — which is the bug 2.4c-ii found in 2.4b's own fix.
   */
  useEffect(() => {
    if (state.status === 'idle') return;
    outcome.current?.focus();
    // Optional call: jsdom does not implement `scrollIntoView`, and a component
    // that throws where a method is merely absent is one that cannot be tested
    // without the test knowing about the browser. The same shape
    // `listing-form.tsx` and `category-form.tsx` already use.
    outcome.current?.scrollIntoView?.({ block: 'center' });
  }, [state]);

  if (status === 'PUBLISHED') {
    return (
      // The status line at the top of the page owns "this is published" and
      // says it first. Repeating it here in different words made the page state
      // the same fact twice, which reads as two separate pieces of information.
      // What this adds is the part the status line cannot know: that there is
      // no way back yet.
      <p>
        Pausing and archiving arrive in a later slice — for now, publishing is one way.
      </p>
    );
  }

  return (
    <form action={action}>
      <div ref={outcome} tabIndex={-1}>
        {state.status === 'not-ready' ? (
          <div role="alert">
            <p>
              <strong>{state.message}</strong>
            </p>
            <ul>
              {state.blockers.map((blocker) => (
                <li key={blocker.field}>{blocker.message}</li>
              ))}
            </ul>
            {/*
              **Not "edit the listing and try again", because there is no way to
              edit one.** A listing is immutable once created — there is no PUT
              or PATCH on the route, and no form that would call one. Telling
              somebody to do something the application cannot do is worse than
              telling them nothing, and it is exactly the kind of copy that
              survives review because it describes what the feature *ought* to
              be. Editing is a real gap, recorded in the phase handoff, and it
              belongs with the owner dashboard in 2.9.
            */}
            <p>
              Nothing has changed — it is still a draft, and only you can see it.
              Listings cannot be edited yet, so for now the way to fix these is to list
              the item again with them filled in.
            </p>
          </div>
        ) : null}

        {state.status === 'error' ? <p role="alert">{state.message}</p> : null}
      </div>

      <input type="hidden" name="listingId" value={listingId} />

      {/*
        **Disabled and explained, never hidden.** A button that vanishes leaves
        somebody looking for a control that was there yesterday, with nothing on
        the page accounting for it — which reads as a broken page rather than as
        a deliberate pause. Saying so costs one sentence and answers the question
        before it is asked.

        The explanation sits *above* the button rather than below it, because
        somebody scanning for the control finds the reason on the way to it.
      */}
      {publicationAvailable ? null : (
        <p role="status">
          <strong>Publishing is paused across the whole platform right now.</strong>{' '}
          This is nothing to do with your listing — it is saved, it is unchanged, and
          you can carry on getting it ready. Try again shortly.
        </p>
      )}

      <p>
        <button type="submit" disabled={pending || !publicationAvailable}>
          {pending ? 'Publishing…' : 'Publish this listing'}
        </button>
      </p>
      <p>
        Publishing makes this listing findable and bookable. Its location is shown only
        as an approximate point, never your address.
      </p>
    </form>
  );
}
