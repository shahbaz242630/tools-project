import { Fragment } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Money } from '@platform/core';
import {
  TRANSPORT_REQUIREMENT_HINTS,
  TRANSPORT_REQUIREMENT_LABELS,
} from '@platform/contracts';
import type { PublicListing } from '@platform/contracts';
import { AttributeValue } from './attribute-value';
import { DamageHold } from './damage-hold';
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
export function PublicListingView({
  listing,
  requestPanel,
}: {
  readonly listing: PublicListing;
  /**
   * The renter's request panel, or the prompt a signed-out visitor gets instead
   * (slice 4.5b).
   *
   * **A slot rather than something this component builds.** Whether there is a
   * session is the page's to know — it is the only layer that can call `auth()`
   * — and this component's whole discipline is that it chooses no fields and
   * makes no disclosure decisions it was not handed. Reaching for the session in
   * here would put an authentication branch inside the one component in the app
   * whose job is to be certain about what a stranger may see.
   */
  readonly requestPanel: ReactNode;
}) {
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
          **The empty state is still a designed state, not a fallback** (slice
          2.6c). Photographs now exist and most listings will not have one for a
          long time, so this branch is the common case rather than the edge: the
          item's initial on a tinted block, and a caption that says whose
          omission it is. The comment here used to say media was "blocked on the
          domain", which stopped being true on 24 August.

          **The projection decides what may be shown and this component does
          not** — `listing.media` is already filtered to `APPROVED` and signed by
          the API, which is the same sentence the rest of this file carries.
        */}
      {listing.media.length === 0 ? (
        <div className={`${styles.media} ${styles.noPhoto}`}>
          <span className={styles.photoInitial} aria-hidden="true">
            {listing.title.trim().charAt(0).toUpperCase()}
          </span>
          <span className={styles.photoCaption}>
            No photo yet — the owner hasn&rsquo;t added one
          </span>
        </div>
      ) : (
        <Gallery listing={listing} />
      )}

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
            §3.4.4 requires the damage security shown **separately** and never
            folded into the headline. The sentence has been here since 2.10
            saying only that a hold *may* apply; slice 5.5b-i replaces the hedge
            with the figure, which is what §8.7.2 means by *"shown to both parties
            before booking"*.
          */}
          <DamageHold
            excess={listing.appliedExcess}
            audience="renter"
            className={styles.hold}
            explainSize
          />

          {/*
            **Where the "booking is not open yet" paragraph used to be** (2.10).
            That paragraph existed because §15 forbids a control that calls
            nothing, and a disabled "Book now" would have been exactly that.
            Booking opened in 4.5a and the panel below calls it, so the sentence
            goes rather than sitting above a control that contradicts it.
          */}
          {requestPanel}
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

/**
 * The item's photographs, as a stranger sees them (slice 2.6c).
 *
 * **The first is large and the rest are a strip beneath it**, which is the shape
 * every marketplace uses because it answers the two questions in order: what is
 * it, and what else is there to see. The owner's order is the array's order —
 * there is no `position` on the public projection to sort by, deliberately, and
 * none is needed: the API returns a total order and this renders it.
 *
 * **No lightbox, no carousel, no `next/image`.** A signed URL expires in fifteen
 * minutes and may not be cached or used as a key, which removes most of what an
 * image component buys; and a gallery whose every photograph is already on the
 * page needs no machinery to reach the second one. `/hire/[id]` is
 * `force-dynamic`, which is what makes per-response signing correct.
 *
 * **Nothing here persists a URL.** They are rendered and forgotten.
 */
function Gallery({ listing }: { readonly listing: PublicListing }) {
  const [first, ...rest] = listing.media;
  if (first === undefined) return null;

  return (
    <div className={styles.media}>
      <img
        alt={`${listing.title}, photographed by its owner`}
        className={styles.photo}
        height={first.display.height}
        src={first.display.url}
        width={first.display.width}
      />

      {rest.length === 0 ? null : (
        <ul className={styles.thumbnails}>
          {rest.map((photograph, index) => (
            <li key={photograph.id}>
              <img
                /*
                 * **Numbered from two, because the large one above is the
                 * first.** "Photograph 1 of 4" on the second picture is the kind
                 * of small lie that makes a screen reader's account of a page
                 * disagree with what is on it.
                 */
                alt={`${listing.title}, photograph ${String(index + 2)} of ${String(
                  listing.media.length,
                )}`}
                className={styles.thumbnail}
                height={photograph.thumbnail.height}
                src={photograph.thumbnail.url}
                width={photograph.thumbnail.width}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
