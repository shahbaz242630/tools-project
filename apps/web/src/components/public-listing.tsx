import { Fragment } from 'react';
import Link from 'next/link';
import { Money } from '@platform/core';
import {
  TRANSPORT_REQUIREMENT_HINTS,
  TRANSPORT_REQUIREMENT_LABELS,
} from '@platform/contracts';
import type { PublicListing } from '@platform/contracts';
import { AttributeValue } from './attribute-value';
import styles from './public-listing.module.css';

/**
 * A listing as a stranger sees it (slice 2.10, laid out in D8).
 *
 * **A component rather than a function inside the page**, for the reason
 * `listing-visibility.tsx` is one: server pages in this app have no tests, and
 * everything decided here is a disclosure decision or a price. Those are exactly
 * the two things that must not be verified only by looking at them.
 *
 * It receives a `PublicListing` and can therefore render nothing it should not:
 * the projection has no street lines, no coordinates and no owner. **This
 * component chooses no fields** — the same sentence `PublicListingsController`
 * carries, and for the same reason. D8 changed where things sit on the page and
 * added no field and no sentence.
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
    <div className={styles.layout}>
      {/*
          **The normal state, not an edge case.** Photographs are slice 2.6 and
          blocked on the domain, so every listing looks like this today. The
          handoff designs it rather than leaving a gap: the item's initial on a
          tinted block, and a caption that says whose omission it is.
        */}
      <div className={styles.media}>
        <span className={styles.photoInitial} aria-hidden="true">
          {listing.title.trim().charAt(0).toUpperCase()}
        </span>
        <span className={styles.photoCaption}>
          No photo yet — the owner hasn&rsquo;t added one
        </span>
      </div>

      <header className={styles.header}>
        <h1 className={styles.title}>{listing.title}</h1>
        <p className={styles.category}>{listing.categoryName}</p>
      </header>

      <aside className={styles.aside}>
        <div className={styles.card}>
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
          {/*
            **The total and the words "fees included" are one element**, and a
            test holds them that way. Wrapping the *unit* in a span put the
            cheaper-looking half in its own node, and the assertion that the
            headline contains the inclusive total and not the bare rate then
            matched an element the total was not in — still passing on this page
            while proving nothing. The span goes round the number instead.
          */}
          <p className={styles.price}>
            <span className={styles.priceAmount}>
              {Money.format(listing.inclusiveDailyPrice.total)}
            </span>{' '}
            a day, fees included
          </p>

          <p className={styles.breakdown}>
            Owner&rsquo;s rate {Money.format(listing.inclusiveDailyPrice.rate)} + our
            fee {Money.format(listing.inclusiveDailyPrice.renterFee)}
            {listing.inclusiveDailyPrice.minimumFeeApplied ? (
              <> (our minimum fee, so a longer hire costs less per day)</>
            ) : null}
          </p>

          {/*
            §3.4.4 requires the refundable damage security to be shown
            **separately** and never folded into the headline. The amount arrives
            in Phase 5 with the deposit bands; the sentence is here now, saying
            only what is true today, because a disclosure added later is one
            somebody forgets — and because a renter deciding on price should know
            a hold exists before they get to a checkout that mentions it first.
          */}
          <p className={styles.hold}>
            A refundable damage hold may also apply at collection. It is not a fee and
            is never part of the price above.
          </p>

          {/*
            **No booking control, and it says so rather than showing a dead one.**
            BRD §15 forbids a control that does not call real behaviour, and
            booking is Phase 4. A disabled "Book now" would be exactly the dead
            control that rule exists to prevent, and would tell a visitor the
            platform does something it does not.
          */}
          <p className={styles.notOpen}>
            <strong>Booking is not open yet.</strong> This listing is visible while the
            platform is being built — there is nothing to book here.
          </p>
        </div>

        <div className={styles.card}>
          <h2 className={styles.cardHeading}>Where</h2>
          {/*
            **The district and the town, which is everything this page knows**
            (§8.4.1). There is no precise address to leak here: the projection
            carries none, and the query behind it does not join the table that
            holds one. The sentence underneath is for the renter's benefit —
            somebody deciding whether to travel needs to know this is approximate
            rather than assume the item is on that street.
          */}
          <p className={styles.cardBody}>
            {listing.location.outwardCode}, {listing.location.town}
          </p>
          <p className={styles.cardNote}>
            The exact address is shared once a booking is confirmed. Until then a
            listing shows only its postcode district.
          </p>
        </div>

        <div className={styles.card}>
          {/*
            **The consumer-law disclosure BRD §8.3 requires** (slice 2.13). A
            renter has materially stronger rights against a business than against
            a private individual, so they are entitled to know which before they
            book — which is why this sits in the body of the page rather than in
            small print at the bottom.

            Rendered from the field rather than hardcoded, even though only
            private owners can publish today. A constant sentence is one that goes
            on being printed after it stops being true.
          */}
          <h2 className={styles.cardHeading}>Who you would be renting from</h2>
          {listing.ownerStatus === 'private_owner' ? (
            <>
              <p className={styles.cardBody}>
                A private individual, lending their own item.
              </p>
              <p className={styles.cardNote}>
                Not a business. Your rights differ from renting through a shop — we will
                set out what that means before you book.
              </p>
            </>
          ) : (
            <p className={styles.cardBody}>A business.</p>
          )}
        </div>
      </aside>

      <div className={styles.body}>
        {listing.description === '' ? null : (
          <section className={styles.section}>
            <h2 className={styles.sectionHeading}>About this item</h2>
            <p className={styles.body}>{listing.description}</p>
          </section>
        )}

        {/*
          **The category's own fields, rendered without knowing what any category
          contains** — this phase's exit gate, on a page a stranger reads. The
          schema is the one the listing *pinned* (ADR 0029), so an answer given
          last month appears under the labels it was given under.
        */}
        {answered.length === 0 ? null : (
          <section className={styles.section}>
            <h2 className={styles.sectionHeading}>Details</h2>
            <dl className={styles.attributes}>
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
            </dl>
          </section>
        )}

        <section className={styles.section}>
          <h2 className={styles.sectionHeading}>Getting it home</h2>
          <p className={styles.body}>
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
          </p>
        </section>

        {listing.rates.weekend !== null || listing.rates.weekly !== null ? (
          <section className={styles.section}>
            <h2 className={styles.sectionHeading}>Longer hires</h2>
            {/*
              The owner's rates, labelled as such and without a fee added. They
              are not inclusive totals because the fee on a weekend or a week
              depends on the dates, and that arithmetic belongs to Phase 4's
              quote engine. Showing a bare figure *labelled as the owner's rate*
              is not drip pricing; showing it as the price would be.
            */}
            <p className={styles.body}>
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
            </p>
          </section>
        ) : null}

        <p className={styles.section}>
          <Link href="/">Home</Link>
        </p>
      </div>
    </div>
  );
}
