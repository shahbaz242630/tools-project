import { Fragment } from 'react';
import Link from 'next/link';
import { Money } from '@platform/core';
import {
  TRANSPORT_REQUIREMENT_HINTS,
  TRANSPORT_REQUIREMENT_LABELS,
} from '@platform/contracts';
import type { PublicListing } from '@platform/contracts';
import { AttributeValue } from './attribute-value';

/**
 * A listing as a stranger sees it (slice 2.10).
 *
 * **A component rather than a function inside the page**, for the reason
 * `listing-visibility.tsx` is one: server pages in this app have no tests, and
 * everything decided here is a disclosure decision or a price. Those are exactly
 * the two things that must not be verified only by looking at them.
 *
 * It receives a `PublicListing` and can therefore render nothing it should not:
 * the projection has no street lines, no coordinates and no owner. **This
 * component chooses no fields** — the same sentence `PublicListingsController`
 * carries, and for the same reason.
 */
export function PublicListingView({ listing }: { readonly listing: PublicListing }) {
  /*
   * Only the attributes that have an answer, and that is a disclosure decision
   * rather than a layout one. The owner's page lists unanswered fields because
   * it is their to-do list; a public page doing the same would be telling
   * strangers what somebody has not filled in — a page about our form rather
   * than about the item.
   */
  const answered = listing.categoryAttributes.filter(
    (attribute) => listing.attributes[attribute.key] !== undefined,
  );

  return (
    <>
      <h1>{listing.title}</h1>

      <p>
        {/*
          **The inclusive total is the headline and the bare rate never appears
          on its own** (§3.4.4). Drip pricing is prohibited by the DMCC regime
          rather than discouraged by it, and the bare rate is one careless line
          away — it is right there on the response, because the breakdown
          underneath is the other half of the same rule.

          Nothing on this page does arithmetic with money. Every figure was
          computed by the pricing service, which §6.1 makes the only place
          rounding happens.
        */}
        <strong>
          {Money.format(listing.inclusiveDailyPrice.total)} a day, fees included
        </strong>
        <br />
        <small>
          Owner&rsquo;s rate {Money.format(listing.inclusiveDailyPrice.rate)} + our fee{' '}
          {Money.format(listing.inclusiveDailyPrice.renterFee)}
          {listing.inclusiveDailyPrice.minimumFeeApplied ? (
            <> (our minimum fee, so a longer hire costs less per day)</>
          ) : null}
        </small>
        <br />
        {/*
          §3.4.4 requires the refundable damage security to be shown
          **separately** and never folded into the headline. The amount arrives
          in Phase 5 with the deposit bands; the sentence is here now, saying
          only what is true today, because a disclosure added later is one
          somebody forgets — and because a renter deciding on price should know
          a hold exists before they get to a checkout that mentions it first.
        */}
        <small>
          A refundable damage hold may also apply at collection. It is not a fee and is
          never part of the price above.
        </small>
      </p>

      <dl>
        <dt>Where</dt>
        <dd>
          {/*
            **The district and the town, which is everything this page knows**
            (§8.4.1). There is no precise address to leak here: the projection
            carries none, and the query behind it does not join the table that
            holds one. The sentence underneath is for the renter's benefit —
            somebody deciding whether to travel needs to know this is
            approximate rather than assume the item is on that street.
          */}
          {listing.location.outwardCode}, {listing.location.town}
          <br />
          <small>
            The exact address is shared once a booking is confirmed. Until then a
            listing shows only its postcode district.
          </small>
        </dd>

        <dt>Category</dt>
        <dd>{listing.categoryName}</dd>

        {listing.description === '' ? null : (
          <>
            <dt>About this item</dt>
            <dd>{listing.description}</dd>
          </>
        )}

        {/*
          **The category's own fields, rendered without knowing what any category
          contains** — this phase's exit gate, on a page a stranger reads. The
          schema is the one the listing *pinned* (ADR 0029), so an answer given
          last month appears under the labels it was given under.
        */}
        {answered.map((attribute) => (
          <Fragment key={attribute.key}>
            <dt>{attribute.label}</dt>
            <dd>
              <AttributeValue
                attribute={attribute}
                // Narrowed by the filter above, which the compiler cannot see.
                value={listing.attributes[attribute.key] ?? ''}
              />
            </dd>
          </Fragment>
        ))}

        <dt>Getting it home</dt>
        <dd>
          {listing.transportRequirement === null ? (
            <em>The owner has not said what is needed to collect this.</em>
          ) : (
            <>
              {TRANSPORT_REQUIREMENT_LABELS[listing.transportRequirement]} —{' '}
              {TRANSPORT_REQUIREMENT_HINTS[listing.transportRequirement]}
            </>
          )}
          {listing.requiresTwoPersonLift ? (
            <>
              <br />
              <strong>It takes two people to lift.</strong> Bring somebody with you.
            </>
          ) : null}
        </dd>

        {listing.rates.weekend !== null || listing.rates.weekly !== null ? (
          <>
            <dt>Longer hires</dt>
            <dd>
              {/*
                The owner's rates, labelled as such and without a fee added.
                They are not inclusive totals because the fee on a weekend or a
                week depends on the dates, and that arithmetic belongs to Phase
                4's quote engine. Showing a bare figure *labelled as the owner's
                rate* is not drip pricing; showing it as the price would be.
              */}
              {listing.rates.weekend === null ? null : (
                <>Weekend {Money.format(listing.rates.weekend)}</>
              )}
              {listing.rates.weekend !== null && listing.rates.weekly !== null ? (
                <> · </>
              ) : null}
              {listing.rates.weekly === null ? null : (
                <>Week {Money.format(listing.rates.weekly)}</>
              )}
              <br />
              <small>
                The owner&rsquo;s rate before our fee. You will see the full total
                before you book.
              </small>
            </dd>
          </>
        ) : null}
      </dl>

      {/*
        **No booking control, and it says so rather than showing a dead one.**
        BRD §15 forbids a control that does not call real behaviour, and booking
        is Phase 4. A disabled "Book now" would be exactly the dead control that
        rule exists to prevent, and would tell a visitor the platform does
        something it does not.
      */}
      <p>
        <strong>Booking is not open yet.</strong> This listing is visible while the
        platform is being built — there is nothing to book here.
      </p>

      <p>
        <Link href="/">Home</Link>
      </p>
    </>
  );
}
