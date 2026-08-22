'use client';

import { useActionState, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { Money, Time } from '@platform/core';
import type { ListingRequest } from '@platform/contracts';
import { answerRequestAction } from '../app/listings/[id]/request-decisions';
import { INITIAL_DECISION_STATE } from '../app/listings/[id]/request-state';
import type { RequestDecisionState } from '../app/listings/[id]/request-state';
import { DamageHold } from './damage-hold';
import styles from './owner-requests.module.css';

/**
 * The requests waiting on an owner (BRD §8.6, §7.1, slice 4.6b).
 *
 * **This is the first place in the product where an owner can accept anything.**
 * 4.6a built the transaction; until this existed it could only be reached with a
 * bearer token.
 *
 * **§7.1's disclosure clause is the reason this is a panel and not a button.**
 * *"Owners must be shown, before accepting, that competing requests exist and
 * will be declined."* Each request carries what accepting it would take down
 * with it, in the same box as the control that would do it — not in a
 * confirmation afterwards, which is after the decision, and not in a modal,
 * which is a place a sentence goes to be dismissed.
 *
 * **And accepting cannot be undone.** §7 gives `ACCEPTED` no cancel edge until
 * `RESERVED`, which is Phase 5 — so the dates are held permanently and no
 * control in this product can free them. That is a one-way door, shipped
 * deliberately *with the sentence attached* (product owner, 18 August 2026), and
 * the sentence sits on the control rather than in a footnote.
 *
 * **The outcome lives on the panel, not on the request** — found by pressing the
 * button. An answered request leaves the list, so a confirmation rendered inside
 * it unmounts before anybody reads it. See `request-decisions.ts`.
 *
 * **The renter is not named, and no payout is stated.** Both omissions are the
 * projection's, argued in `listingRequestSchema`: an owner is deciding about
 * dates and a price, and any figure labelled as what *they* receive would be a
 * false sentence about money while §3.4's commission arithmetic is Phase 5.
 */
export function OwnerRequests({
  listingId,
  requests,
}: {
  readonly listingId: string;
  readonly requests: readonly ListingRequest[];
}) {
  const [outcome, action, pending] = useActionState(
    answerRequestAction,
    INITIAL_DECISION_STATE,
  );
  const anchor = useOutcomeFocus(outcome);

  return (
    <section className={styles.panel} aria-labelledby="requests-heading">
      <h2 id="requests-heading" className={styles.heading}>
        Requests
        {requests.length > 0 ? (
          <span className={styles.count}> ({requests.length})</span>
        ) : null}
      </h2>

      {/*
        **Above the list, because the list is what changes.** The request that was
        just answered is gone by the time this renders, and the news of it has to
        outlive the row that carried it.
      */}
      <Outcome anchor={anchor} state={outcome} />

      {requests.length === 0 ? (
        /*
          **"No requests are waiting", never "nobody has asked yet".** The first
          wording was here until the page was read: an owner who accepts one
          request and watches the other auto-decline is then told that nobody has
          asked — immediately after two people did. This panel only ever knows
          what is *pending*, so its empty state must be a sentence that is true
          whether or not anything came before.
        */
        <p className={styles.empty}>
          No requests are waiting. When somebody asks to hire this, their dates appear
          here and you have <strong>48 hours</strong> to accept or decline before the
          request expires.
        </p>
      ) : (
        <ul className={styles.list}>
          {requests.map((request) => (
            <Request
              key={request.id}
              listingId={listingId}
              request={request}
              action={action}
              pending={pending}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One request, and the two answers to it. */
function Request({
  listingId,
  request,
  action,
  pending,
}: {
  readonly listingId: string;
  readonly request: ListingRequest;
  readonly action: (form: FormData) => void;
  readonly pending: boolean;
}) {
  return (
    <li className={styles.request}>
      <p className={styles.period}>
        {Time.formatLocalDate(request.startDate)} to{' '}
        {Time.formatLocalDate(request.endDate)}
        <span className={styles.days}>
          {' '}
          · {request.days} {request.days === 1 ? 'day' : 'days'}
        </span>
      </p>

      <p className={styles.charge}>
        <strong>{Money.format(request.itemCharge)}</strong> at your rates
        <span className={styles.chargeNote}>
          {' '}
          — before our commission, which is worked out when payments are built.
        </span>
      </p>

      {/*
        **The owner's half of §8.7.2's *"shown to both parties before booking"*.**
        Their commitment is the acceptance, so the figure belongs on the thing
        they accept — and it is the one number in this row that is about the
        renter's exposure rather than what the hire earns. Somebody handing over a
        £900 breaker is entitled to know what stands behind it, and to be told
        plainly when nothing does.
      */}
      <DamageHold
        excess={request.appliedExcess}
        audience="owner"
        className={styles.hold}
        explainSize={false}
      />

      <p className={styles.deadline}>
        Expires{' '}
        <strong>{Time.formatLocal(Time.fromIsoUtc(request.requestExpiresAt))}</strong>{' '}
        (UK time) if you do not answer.
      </p>

      {/*
        **§7.1's clause, in the same box as the button it is about.** Shown only
        when there is something to say: a count of nought would be noise on every
        request forever, and noise is what makes the real warning invisible.
      */}
      {request.conflictCount > 0 ? (
        <p className={styles.conflicts} role="note">
          Accepting this will <strong>decline {describeConflicts(request)}</strong> for
          overlapping dates.
        </p>
      ) : null}

      {/*
        **One form, two submit buttons, and the intent on the button.** `name` and
        `value` on a `<button type="submit">` are submitted with the form, which is
        ordinary HTML and works before React has hydrated anything — and it keeps
        the two answers from needing two forms carrying the same two hidden fields.
      */}
      <form action={action} className={styles.actions}>
        <input type="hidden" name="listingId" value={listingId} />
        <input type="hidden" name="bookingId" value={request.id} />

        <button type="submit" name="intent" value="accept" disabled={pending}>
          Accept
        </button>
        <button
          type="submit"
          name="intent"
          value="decline"
          className="button-secondary"
          disabled={pending}
        >
          Decline
        </button>
      </form>

      {/*
        **The one-way door, said where the decision is made.** Not a footnote and
        not a confirmation dialog: a dialog is a place a sentence goes to be
        clicked past, and a footnote is read after. §7 gives an accepted booking
        no way back until Phase 5 builds the states after it, and an owner is
        entitled to know that before they press rather than when they go looking
        for the undo.
      */}
      <p className={styles.warning}>
        Accepting holds these dates for this renter.{' '}
        <strong>It cannot be undone yet</strong> — cancelling a confirmed booking
        arrives with payments.
      </p>
    </li>
  );
}

/** What the last answer did, or nothing at all. */
function Outcome({
  anchor,
  state,
}: {
  readonly anchor: RefObject<HTMLDivElement | null>;
  readonly state: RequestDecisionState;
}) {
  return (
    <div ref={anchor} tabIndex={-1}>
      {state.status === 'error' ? (
        <p role="alert" className={styles.error}>
          {state.message}
        </p>
      ) : null}
      {state.status === 'accepted' || state.status === 'declined' ? (
        <p role="status" className={styles.done}>
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

/** "1 other request", "3 other requests" — the count §7.1 wants shown. */
function describeConflicts({ conflictCount }: ListingRequest): string {
  return `${String(conflictCount)} other request${conflictCount === 1 ? '' : 's'}`;
}

/**
 * Move to the outcome rather than leaving it above the fold.
 *
 * **Keyed on the whole state, not on the message.** Two identical refusals
 * compare equal, and an effect that skips the second leaves the page perfectly
 * still exactly when somebody is most likely to conclude it is stuck — the
 * defect 2.4c-ii found in 2.4b's own fix.
 */
function useOutcomeFocus(
  state: RequestDecisionState,
): RefObject<HTMLDivElement | null> {
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.status === 'idle') return;
    anchor.current?.focus();
    // Optional call: jsdom does not implement `scrollIntoView`.
    anchor.current?.scrollIntoView?.({ block: 'center' });
  }, [state]);

  return anchor;
}
