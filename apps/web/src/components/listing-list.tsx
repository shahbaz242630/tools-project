/**
 * Everything an owner has listed, in one table (slice 2.9a).
 *
 * **This is the page that did not exist for six slices, and its absence is worth
 * recording because nothing failed.** From 2.4a a listing could be created, and
 * the only route back to one was the redirect immediately after saving it: the
 * account page never mentioned listings, and the listing page linked onward to
 * creating another. `listOwnedBy` had exactly one caller in the whole system —
 * the data export. An owner who closed the tab had no way back to their own
 * lawnmower short of the UUID.
 *
 * Presentational and exhaustive, per `ActivityList`: adding a case to
 * `ListingOutcome` is a type error here rather than a blank panel. And the
 * distinction that convention exists for matters here too — **an owner with no
 * listings and a list that could not be read must not look the same.** "You have
 * not listed anything" is a claim about somebody's account, and rendering it
 * because the API timed out would tell them their work had gone.
 *
 * **No `use client`.** No state, no effects, no handlers — it renders on the
 * server like the rest of the presentational components here.
 */

import Link from 'next/link';
import { Money, Time } from '@platform/core';
import type { OwnedListings, OwnerListingSummary } from '@platform/contracts';
import { VisibilityLabel } from './listing-visibility';
import { ownerListingPath } from '../lib/page-paths';
import type { ListingOutcome } from '../lib/listings';
import styles from './listing-list.module.css';

export function ListingList({
  outcome,
}: {
  readonly outcome: ListingOutcome<OwnedListings>;
}) {
  switch (outcome.kind) {
    case 'loaded':
      return outcome.value.listings.length === 0 ? (
        <Empty />
      ) : (
        <Loaded page={outcome.value} />
      );

    case 'signed-out':
      /*
       * **The state first, the likeliest cause second** — the wording every
       * page in the application now shares, for the reason recorded in
       * `listings/new/page.tsx`: an expiry stated as fact is a claim about a
       * session we cannot vouch for, and it was being shown to people who had
       * never had one.
       *
       * That it is *this* page hardly softens it. Somebody arriving here with
       * no session — a stale bookmark, a second browser, a link they were sent
       * — is told their listings could not be read; being told *why* in terms
       * of a session they never had is a sentence they can do nothing with.
       */
      return (
        <p role="alert" className={styles.problem}>
          You are not signed in. Your session may have expired —{' '}
          <Link href="/sign-in">sign in</Link> to see your listings.
        </p>
      );

    /*
     * Every remaining kind is a failure to read, and they collapse to one
     * sentence deliberately — unlike the two above, which a person can act on.
     *
     * The sentence a person needs here is the same in all of them: *your
     * listings are still there and we could not fetch them.* `forbidden`,
     * `not-found`, `invalid` and `stale-category` are all unreachable on this
     * route — it takes no body, addresses no single listing and pins no category
     * version — so distinct copy for each would be four sentences nobody can
     * ever be shown, three of which would be wrong if they somehow were.
     *
     * They are still listed rather than defaulted, so a new kind on
     * `ListingOutcome` breaks the build here instead of falling into a message
     * about something else.
     */
    case 'forbidden':
    case 'not-found':
    case 'invalid':
    case 'stale-category':
    case 'unreachable':
    case 'malformed':
      return (
        <p role="alert" className={styles.problem}>
          Your listings could not be loaded just now. Nothing has been changed or lost —
          try again in a moment.
        </p>
      );

    default: {
      // Exhaustiveness, checked by the compiler rather than by review.
      const unhandled: never = outcome;
      return <p role="alert">{String(unhandled)}</p>;
    }
  }
}

/**
 * What somebody sees before they have listed anything.
 *
 * **The one place on this page a control belongs.** An empty table with a
 * heading is a page that looks broken; the only useful thing to offer somebody
 * here is the thing they came to do.
 */
function Empty() {
  return (
    <section className={styles.empty} aria-labelledby="listings">
      <h2 id="listings" className={styles.emptyHeading}>
        Your listings
      </h2>
      {/*
        **The copy is 2.9a's, unchanged.** The handoff has no empty state for
        this page — it draws the table and nothing else — so there was nothing to
        match, and rewriting a sentence that already works because a slice
        happened to be open would be the same drift this workstream keeps
        catching in the other direction.
      */}
      <p className={styles.emptyBody}>
        You have not listed anything yet. <Link href="/listings/new">List an item</Link>{' '}
        and it will appear here.
      </p>
    </section>
  );
}

function Loaded({ page }: { readonly page: OwnedListings }) {
  return (
    <section aria-labelledby="listings">
      <h2 id="listings" className={styles.srOnly}>
        Your listings
      </h2>

      {/*
        **Said on screen, not only in a log** (ADR 0035). The bound is set far
        above any owner we expect, so this should never render — which is exactly
        why it has to exist: a list that quietly stops is one somebody reads as
        their whole record, and the person it would mislead is the one with the
        most to lose by it.

        `role="alert"` rather than `status`: it is not a result of anything they
        just did.

        **It does not offer a way to get in touch, because there is not one.**
        The original copy said "please get in touch and we will sort it out",
        which named a channel the platform does not have and will not have until
        Phase 6 — no contact page, no inbox, and by our own rule no support desk
        afterwards either. An instruction nobody can follow is worse than an
        admission, so the sentence now tells the owner the two things that are
        true and useful: their listings are all still there, and this page cannot
        reach past the bound yet.
      */}
      {page.truncated ? (
        <p role="alert" className={styles.problem}>
          This is not all of them. You have more listings than this page can show, and
          there is no way to page past it yet — nothing is missing from your account,
          and nothing has been deleted.
        </p>
      ) : null}

      <div className={styles.scroller}>
        <table className={styles.table}>
          <caption className={styles.caption}>Most recently created first.</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Category</th>
              <th scope="col">Who can see it</th>
              <th scope="col">Price</th>
              <th scope="col">Created</th>
            </tr>
          </thead>
          <tbody>
            {page.listings.map((listing) => (
              <Row key={listing.id} listing={listing} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Row({ listing }: { readonly listing: OwnerListingSummary }) {
  return (
    <tr>
      <th scope="row" className={styles.item}>
        {/* The whole point of the page: a route back to a listing that is not
            its UUID. **`ownerListingPath`, not the contract's `listingPath`** —
            that one is the API route this page's data came from, and it spells
            the same string only by coincidence. */}
        <Link href={ownerListingPath(listing.id)}>{listing.title}</Link>
      </th>
      <td>{listing.categoryName}</td>
      <td>
        <VisibilityLabel
          status={listing.status}
          moderationState={listing.moderationState}
        />
        {/*
          Only when it is *not* located, matching the listing page's own rule:
          a line on every row saying "we found this address" is one nobody
          reads, and the value here is that the exception stands out.

          It sits in this column rather than its own because it answers the same
          question — nobody searching nearby can find a listing with no point,
          whatever its status says.
        */}
        {listing.isLocated ? null : (
          <small className={styles.note}>
            Not on the map yet — nobody nearby would find it.
          </small>
        )}
      </td>
      <td className={styles.price}>
        {/*
          The inclusive total, computed by the API (§3.4.4, §6.1). The bare rate
          is not on this shape at all, so showing the wrong figure is not
          available here rather than merely discouraged — which is the point of
          the summary projection carrying one price and not two.
        */}
        {listing.inclusiveDailyPrice === null ? (
          <em className={styles.unpriced}>Not priced</em>
        ) : (
          <>
            {Money.format(listing.inclusiveDailyPrice.total)} a day
            <small className={styles.note}>fees included</small>
          </>
        )}
      </td>
      <td>{Time.formatLocal(Time.fromIsoUtc(listing.createdAt))}</td>
    </tr>
  );
}
