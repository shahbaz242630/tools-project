'use client';

import { useActionState, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { ListingStatus } from '@platform/contracts';
import { pauseListingAction, publishListingAction } from '../app/listings/[id]/actions';
import { INITIAL_PUBLICATION_STATE } from '../app/listings/[id]/publication-state';
import type { PublicationActionState } from '../app/listings/[id]/publication-state';

/**
 * The controls that move a listing in and out of public view (§8.3, slices 2.8a
 * and 2.8b).
 *
 * **One control is rendered at a time, chosen by status**, and each lives in its
 * own component with its own action state. The alternative — one component
 * holding both hooks — would keep a refusal from the button that is no longer on
 * screen, so an owner who failed to publish, fixed nothing, and then paused
 * would see the old list of missing fields under the new outcome.
 *
 * **The button holds no state of its own**, which is why the React 19 form-reset
 * defect that bit 2.4c-i, 2.5a and 2.7a cannot reach it: there is nothing typed
 * into these forms to lose. The only input is a hidden listing id, re-rendered
 * from a prop rather than restored from an attribute.
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
   *
   * **It does not reach the pause control**, and that asymmetry is the rule
   * rather than an oversight: the switch stops listings going public and has no
   * business stopping one being taken down.
   */
  readonly publicationAvailable: boolean;
}) {
  if (status === 'PUBLISHED') {
    return <PauseControl listingId={listingId} />;
  }

  return (
    <PublishControl
      listingId={listingId}
      status={status}
      publicationAvailable={publicationAvailable}
    />
  );
}

/**
 * Publish, or resume — the same operation and deliberately the same control.
 *
 * To an owner they are two words; to the platform resuming *is* publishing, past
 * the same completeness gate and the same kill switch. Rendering them as one
 * component is what stops a "Resume" button acquiring a shortcut past either.
 * Only the wording changes.
 */
function PublishControl({
  listingId,
  status,
  publicationAvailable,
}: {
  readonly listingId: string;
  readonly status: ListingStatus;
  readonly publicationAvailable: boolean;
}) {
  const [state, action, pending] = useActionState(
    publishListingAction,
    INITIAL_PUBLICATION_STATE,
  );
  const outcome = useOutcomeFocus(state);
  const resuming = status === 'PAUSED';

  return (
    <form action={action}>
      <Outcome anchor={outcome} state={state}>
        <p>
          {resuming
            ? 'Nothing has changed — it is still paused, and only you can see it.'
            : 'Nothing has changed — it is still a draft, and only you can see it.'}{' '}
          {/*
            **Not "edit the listing and try again", because there is no way to
            edit one.** A listing is immutable once created — there is no PUT or
            PATCH on the route, and no form that would call one. Telling somebody
            to do something the application cannot do is worse than telling them
            nothing, and it is exactly the kind of copy that survives review
            because it describes what the feature *ought* to be. Editing is a
            real gap, recorded in the phase handoff, and it belongs with the
            owner dashboard in 2.9.
          */}
          Listings cannot be edited yet, so for now the way to fix these is to list the
          item again with them filled in.
        </p>
      </Outcome>

      <input type="hidden" name="listingId" value={listingId} />

      {/*
        **Disabled and explained, never hidden** (slice H3b). A button that
        vanishes leaves somebody looking for a control that was there yesterday,
        with nothing on the page accounting for it — which reads as a broken page
        rather than as a deliberate pause.

        The explanation sits *above* the button, so somebody scanning for the
        control meets the reason on the way to it.
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
          {buttonLabel(pending, resuming)}
        </button>
      </p>
      <p>
        {resuming
          ? 'Putting it back makes this listing findable and bookable again.'
          : 'Publishing makes this listing findable and bookable.'}{' '}
        Its location is shown only as an approximate point, never your address.
      </p>
    </form>
  );
}

function buttonLabel(pending: boolean, resuming: boolean): string {
  if (resuming) return pending ? 'Putting it back…' : 'Put this listing back up';
  return pending ? 'Publishing…' : 'Publish this listing';
}

/** Take a live listing out of public view (slice 2.8b). */
function PauseControl({ listingId }: { readonly listingId: string }) {
  const [state, action, pending] = useActionState(
    pauseListingAction,
    INITIAL_PUBLICATION_STATE,
  );
  const outcome = useOutcomeFocus(state);

  return (
    <form action={action}>
      <Outcome anchor={outcome} state={state} />

      <input type="hidden" name="listingId" value={listingId} />

      <p>
        <button type="submit" disabled={pending}>
          {pending ? 'Pausing…' : 'Pause this listing'}
        </button>
      </p>
      {/*
        Said before the button rather than after it, and said plainly, because
        the fear that stops somebody pressing a control like this is that it
        cannot be undone. It can, and that is the reason archive was removed from
        the BRD rather than built beside it.
      */}
      <p>
        Pausing hides it from search and from anybody who has the link. Nothing is
        deleted, and you can put it back whenever you like.
      </p>
    </form>
  );
}

/**
 * Move to the outcome, rather than leaving it above the fold.
 *
 * Session 25 found this the hard way: the listing form's message rendered 240px
 * above the viewport and read as a button that did nothing. This page is longer
 * than that form.
 *
 * **Keyed on the whole state, not on `state.message`.** Two identical refusals
 * compare equal, and an effect that skips the second one leaves the page
 * perfectly still exactly when somebody is most likely to conclude it is stuck —
 * the bug 2.4c-ii found in 2.4b's own fix.
 */
function useOutcomeFocus(
  state: PublicationActionState,
): RefObject<HTMLDivElement | null> {
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.status === 'idle') return;
    anchor.current?.focus();
    // Optional call: jsdom does not implement `scrollIntoView`, and a component
    // that throws where a method is merely absent is one that cannot be tested
    // without the test knowing about the browser.
    anchor.current?.scrollIntoView?.({ block: 'center' });
  }, [state]);

  return anchor;
}

/**
 * What the last attempt did, or nothing at all.
 *
 * The blockers render as a list rather than one joined sentence: seven unmet
 * requirements read as a checklist and not as a paragraph, and the owner works
 * through them one at a time either way.
 */
function Outcome({
  anchor,
  state,
  children,
}: {
  readonly anchor: RefObject<HTMLDivElement | null>;
  readonly state: PublicationActionState;
  /** What to say beneath the blocker list. Only the publish control has any. */
  readonly children?: React.ReactNode;
}) {
  return (
    <div ref={anchor} tabIndex={-1}>
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
          {children}
        </div>
      ) : null}

      {state.status === 'error' ? <p role="alert">{state.message}</p> : null}
    </div>
  );
}
