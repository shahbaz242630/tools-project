import { auth } from '@clerk/nextjs/server';
import { Fragment } from 'react';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Money, Postcode, Time } from '@platform/core';
import {
  TRANSPORT_REQUIREMENT_HINTS,
  TRANSPORT_REQUIREMENT_LABELS,
  isPubliclyVisible,
} from '@platform/contracts';
import type { CategoryAttribute, OwnerListing } from '@platform/contracts';
import { clientIpFrom } from '../../../lib/client-ip';
import { fetchListing } from '../../../lib/listings';
import { fetchListingMedia } from '../../../lib/listing-media';
import { ListingPhotographs } from '../../../components/listing-photographs';
import { editListingPath, listingCalendarPath } from '../../../lib/page-paths';
import type { ReactNode } from 'react';
import { fetchRequests } from '../../../lib/requests';
import { DamageHold } from '../../../components/damage-hold';
import { OwnerRequests } from '../../../components/owner-requests';
import { webEnv } from '../../../lib/env';
import { PublishListingForm } from '../../../components/publish-listing-form';
import { ModerationNotice, StatusLine } from '../../../components/listing-visibility';
import { AttributeValue } from '../../../components/attribute-value';
import styles from './listing-detail.module.css';

/** Never prerendered — it is somebody's own draft. */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Your listing',
  robots: { index: false, follow: false },
};

/**
 * One of your own listings.
 *
 * **Not the public listing page.** That is slice 2.10, it is a different
 * projection, and it must be crawlable — this one is `noindex` and shows things
 * a stranger will never see. Keeping them apart from the start is what stops the
 * public page inheriting a field it should not have.
 */
export default async function ListingPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  const { getToken } = await auth();
  const token = await getToken();
  const clientIp = clientIpFrom((await headers()).get('x-forwarded-for'));

  /*
   * **Both reads at once, because neither depends on the other** — the shape the
   * calendar page uses. Ownership is enforced by the API on *both*, so this page
   * has no check of its own to forget: a listing that is not theirs answers 404
   * below, and the requests read answers with an empty list rather than a 403.
   */
  const [outcome, requests, photographs] = await Promise.all([
    fetchListing(webEnv().API_BASE_URL, token, id, undefined, clientIp),
    fetchRequests(webEnv().API_BASE_URL, token, id, undefined, clientIp),
    /*
     * **The third read, issued with the other two** (slice 2.6c). Ownership is
     * enforced by the API on all three, so this page still has no check of its
     * own to forget — a listing that is not theirs answers 404 here as well.
     */
    fetchListingMedia(webEnv().API_BASE_URL, token, id, undefined, clientIp),
  ]);

  // Somebody else's listing answers 404 rather than 403, and this page says the
  // same thing the API did. Rendering "you are not allowed" here would leak the
  // existence the API was careful not to confirm.
  if (outcome.kind === 'not-found') notFound();

  return (
    <main className={styles.page}>
      {outcome.kind === 'loaded' ? (
        <Listing
          listing={outcome.value}
          photographs={
            /*
             * **Rendered only when the read succeeded**, for the reason the
             * requests slot beside it gives. An empty gallery would state that
             * this listing has no photographs; a failed read knows nothing of
             * the sort, and the owner's other controls must not be taken down
             * by it either.
             */
            photographs.kind === 'loaded' ? (
              <ListingPhotographs listingId={id} media={photographs.value} />
            ) : null
          }
          requests={
            /*
             * **Rendered only when the read succeeded, and silently absent
             * otherwise.** A failed requests read must not take down the page
             * whose real job is showing somebody their own listing — and it must
             * not claim there are none, either, which is what an empty panel
             * would say. The listing is what this page is for; requests are what
             * it also shows.
             */
            requests.kind === 'loaded' ? (
              <OwnerRequests listingId={id} requests={requests.value.requests} />
            ) : null
          }
        />
      ) : (
        <Unavailable kind={outcome.kind} />
      )}

      <p className={styles.footnote}>
        {/* Added in 2.9a. This page was previously reachable only by the
            redirect that follows saving, and led nowhere but to creating
            another — so the way back to a listing seen once was its UUID. */}
        <Link href="/listings">All your listings</Link> ·{' '}
        <Link href="/listings/new">List another item</Link> ·{' '}
        <Link href="/account">Back to your account</Link>
      </p>
    </main>
  );
}

function Listing({
  listing,
  photographs,
  requests,
}: {
  readonly listing: OwnerListing;
  /**
   * This listing's photographs, or nothing (slice 2.6c).
   *
   * **A slot, for the reason `requests` is one** — and it degrades the same way.
   * A failed media read renders nothing rather than an empty gallery, because an
   * empty gallery is a claim: it says this listing has no photographs, which is
   * a different thing from not having been able to find out.
   */
  readonly photographs: ReactNode;
  /**
   * The requests waiting on this listing, or nothing (slice 4.6b).
   *
   * **A slot rather than something this component fetches.** It is a server
   * component and could read them itself; passing them keeps every network call
   * for this page in one place, where the two can be issued together instead of
   * one waiting on the other.
   */
  readonly requests: ReactNode;
}) {
  return (
    <>
      <h1 className={styles.title}>{listing.title}</h1>

      <p role="status" className={styles.status}>
        {/*
          **`isPubliclyVisible` decides whether anybody can see this, and this
          page does not** (ADR 0041). Its history — three separate defects on one
          sentence — is written up in `listing-visibility.tsx`, which is where the
          two components now live so that a test can hold them.

          A `status === 'PUBLISHED'` written here would have been the fourth, and
          the worst of them: it would tell an owner that strangers can book an item
          the platform is refusing to show.

          This is also the function's **first caller**. It was written in 2.8a and
          widened in 2.8c-i with none, on the argument that a rule with one home is
          cheaper to widen than a comparison with five. Using it here means this
          page and Phase 3's search cannot come to disagree about what "visible"
          means — they ask the same function.
        */}
        <StatusLine
          status={listing.status}
          visible={isPubliclyVisible(listing.status, listing.moderationState)}
        />
      </p>

      <ModerationNotice listing={listing} />

      {/*
        **Above the item's own details, because it is the only thing on this page
        with a clock on it.** §8.6 gives a request 48 hours; editing, availability
        and publishing can all wait, and a panel below the fold is one an owner
        finds after the deadline rather than before it.
      */}
      {requests}

      <dl className={styles.facts}>
        <dt>Category</dt>
        <dd>
          {listing.categoryName}{' '}
          <small>
            (recorded as version {listing.categoryVersionNumber} — the rules as they
            stood when you saved)
          </small>
        </dd>

        <dt>Replacement value</dt>
        {/*
          Formatted by the money primitive, never by string concatenation or
          `toFixed` — which is banned (ADR 0002) and is how a float gets into a
          number somebody will later be charged against.
        */}
        <dd>{Money.format(listing.replacementValue)}</dd>

        <dt>Price</dt>
        <dd>
          {listing.inclusiveDailyPrice === null ? (
            <em>Not priced yet. You will need a daily rate before you can publish.</em>
          ) : (
            <>
              {/*
                **The inclusive total is the headline, and the bare rate is
                never shown on its own** (§3.4.4). Showing the rate as the price
                and adding the fee later is drip pricing, which the DMCC regime
                prohibits rather than discourages — and it is one careless line
                away, because the bare rate is right there on the response.

                The breakdown sits underneath because §3.4.4 permits a base
                price shown *alongside* an inclusive total, and because an owner
                setting a rate needs to see what their renter actually pays.

                Every figure here is computed by the API. Nothing on this page
                does arithmetic with money — §6.1 puts rounding in the pricing
                service and nowhere else.
              */}
              <strong>
                From {Money.format(listing.inclusiveDailyPrice.total)} a day, fees
                included
              </strong>
              <br />
              <small>
                Your rate {Money.format(listing.inclusiveDailyPrice.rate)} + our fee{' '}
                {Money.format(listing.inclusiveDailyPrice.renterFee)}
                {listing.inclusiveDailyPrice.minimumFeeApplied ? (
                  <>
                    {' '}
                    (this category&rsquo;s minimum fee, so a longer rental costs less
                    per day)
                  </>
                ) : null}
              </small>
            </>
          )}
        </dd>

        {/*
          §3.4.4 requires the damage security shown **separately** and never
          folded into the headline. This said only that a hold *may* apply until
          slice 5.5b-ii — and by then the requests panel above it was stating a
          definite figure, so one page said two different things about the same
          hold. **Found by opening the page, not by the suite.**

          Its own row rather than another `<small>` inside the price, because
          "separately" is the rule and a fourth line under the rate reads as part
          of it. §8.7.2's sizing note is addressed to the owner: loss above the
          recovery ceiling is theirs, and they cannot weigh that against "may
          apply".
        */}
        <dt>Damage hold</dt>
        <dd>
          <DamageHold
            excess={listing.appliedExcess}
            audience="owner"
            className={undefined}
            explainSize
          />
        </dd>

        {listing.rates.weekend !== null || listing.rates.weekly !== null ? (
          <>
            <dt>Longer hires</dt>
            <dd>
              {/*
                Shown as the owner set them, without a fee added, and labelled as
                such. These are not yet inclusive totals because the fee on a
                weekend or a week depends on the booking — that arithmetic
                belongs to the quote engine in Phase 4, which has dates. Showing
                a bare figure *labelled* as the owner's rate is not drip pricing;
                showing it as the price would be.
              */}
              {listing.rates.weekend !== null ? (
                <>Weekend: {Money.format(listing.rates.weekend)} (your rate)</>
              ) : null}
              {listing.rates.weekend !== null && listing.rates.weekly !== null ? (
                <br />
              ) : null}
              {listing.rates.weekly !== null ? (
                <>Weekly: {Money.format(listing.rates.weekly)} (your rate)</>
              ) : null}
            </dd>
          </>
        ) : null}

        <dt>Description</dt>
        <dd>
          {listing.description === '' ? (
            <em>
              Nothing written yet. It has to say something before you can publish.
            </em>
          ) : (
            listing.description
          )}
        </dd>

        {/*
          The category's own fields, in the order the category defines and read
          against the schema this listing pinned — not against the category as
          it stands today. Nothing here names a field: that is the Phase 2 exit
          gate.
        */}
        {listing.categoryAttributes.map((attribute) => (
          <Fragment key={attribute.key}>
            <dt>{attribute.label}</dt>
            <dd>
              <OwnerAttributeValue
                attribute={attribute}
                value={listing.attributes[attribute.key]}
              />
            </dd>
          </Fragment>
        ))}

        {/*
          §8.3 requires the transport requirement to be "displayed on the listing
          page and in the booking summary before the booking is submitted". This
          is the first of those; the booking summary is Phase 4.

          Shown even when unanswered, unlike the fields above, because a blank
          here is the thing a renter most needs to know is blank — "we do not
          know what this takes to collect" is information, and an omitted row
          would read as though the question had never been asked.
        */}
        <dt>Getting it home</dt>
        <dd>
          {listing.transportRequirement === null ? (
            <em>
              Not said yet. It has to be answered before you can publish, because
              whoever rents this has to know what to arrive in.
            </em>
          ) : (
            <>
              <strong>
                {TRANSPORT_REQUIREMENT_LABELS[listing.transportRequirement]}
              </strong>{' '}
              — {TRANSPORT_REQUIREMENT_HINTS[listing.transportRequirement]}
            </>
          )}
          {listing.requiresTwoPersonLift ? (
            // Only when true. A line reading "one person can lift it" on every
            // listing is one nobody reads, and the whole value of this is that
            // the exception stands out.
            <>
              <br />
              Takes <strong>two people</strong> to lift.
            </>
          ) : null}
        </dd>

        {/*
          Shown in full, because this page is only ever your own listing. The
          public page in 2.10 shows the district and town and nothing else —
          it is a different projection of a different type, so this block
          cannot be reused there by accident (BRD §8.4.1).

          Shown even when unanswered, like the transport requirement above and
          for the same reason: "we do not know where this is" is information,
          and an omitted row would read as though nobody had been asked.
        */}
        <dt>Collected from</dt>
        <dd>
          {listing.collectionLocation === null ? (
            <em>
              Not said yet. A listing needs an address before it can be published,
              because nobody can come and fetch a thing that is nowhere.
            </em>
          ) : (
            <>
              {listing.collectionLocation.line1}
              {listing.collectionLocation.line2 === null ? null : (
                <>
                  <br />
                  {listing.collectionLocation.line2}
                </>
              )}
              <br />
              {listing.collectionLocation.town}
              <br />
              {listing.collectionLocation.postcode}
              <br />
              <small>
                Renters see only{' '}
                <strong>{outwardCodeOf(listing.collectionLocation.postcode)}</strong>,{' '}
                {listing.collectionLocation.town} until a booking reaches collection.
              </small>
              {/*
                Only when it is *not* located. A line saying "we found this
                address" on every listing is one nobody reads, and the whole
                value here is that the exception stands out — the same reasoning
                as the two-person-lift line above.

                It matters to an owner because it is the difference between a
                listing people can find nearby and one they cannot, and 2.8a's
                publication gate refuses while it is true.
              */}
              {listing.isLocated ? null : (
                <>
                  <br />
                  <em role="status">
                    We have not been able to place this postcode on a map yet, so nobody
                    searching nearby would find it. That usually fixes itself — save the
                    listing again in a few minutes.
                  </em>
                </>
              )}
            </>
          )}
        </dd>

        {/*
          **`updatedAt`, and it was `createdAt` until slice 2.9b-ii.**

          The label was accurate for as long as a listing was write-once: the two
          timestamps were the same value, so either one was "when this was
          saved". 2.9b-i and 2.9b-ii are what made them diverge, and the old field
          then said something false in the one place it matters most — an owner
          who changes their address, presses Save, and reads back a date from last
          week concludes the save did not work, and does it again.

          Found by walking the page rather than by a test, which is the argument
          for walking the page: every assertion in this slice passed while this
          line was wrong, because nothing knew what the date was *for*.
        */}
        <dt>Saved</dt>
        <dd>{Time.formatLocal(Time.fromIsoUtc(listing.updatedAt))}</dd>
      </dl>

      {/*
        **Above publication, deliberately** (slice 2.9b-i). The commonest reason
        somebody is on this page is that publishing refused and named what is
        missing; the control that fixes it should be the one they meet first,
        rather than below the button that just said no.
      */}
      <div className={styles.actions}>
        <Link href={editListingPath(listing.id)} className={styles.edit}>
          Edit this listing
        </Link>

        {/*
          **The way in to the calendar** (slice 4.3b). Beside the edit link
          rather than below the publication control, because both are things an
          owner does *to* their listing — where publishing is what the platform
          does with it. Without this the calendar would be reachable only by
          typing a URL, which is the state 2.9a found the listing page itself in.
        */}
        <Link href={listingCalendarPath(listing.id)} className={styles.edit}>
          Manage availability
        </Link>

        <PublishListingForm
          listingId={listing.id}
          status={listing.status}
          publicationAvailable={listing.publicationAvailable}
        />
      </div>

      {/*
        **This was the sentence "Photographs are not built yet. When they are,
        they will appear here." until slice 2.6c**, and retiring it is the point
        of the slice. It was true when written and had no test on it, which is
        the exact shape `LESSONS.md` warns about: a green suite cannot see a
        false sentence, and this one would have outlived the feature it promised.
      */}
      {photographs}
    </>
  );
}

/**
 * The published half of a postcode, for showing an owner what a renter sees.
 *
 * Derived here rather than sent by the API, because this page already holds the
 * full postcode — it is the owner's own. On the public page in 2.10 the outward
 * code is the *stored column*, never a truncation applied at render time, and
 * that difference is deliberate: there, forgetting the truncation would be a
 * disclosure, and here there is nothing to disclose.
 *
 * Falls back to the whole thing rather than throwing. This is an explanatory
 * aside, and a stored postcode that somehow will not parse should not take down
 * a page whose real job is showing somebody their own address.
 */
function outwardCodeOf(postcode: string): string {
  try {
    return Postcode.outwardCode(postcode);
  } catch {
    return postcode;
  }
}

/**
 * One stored answer as its **owner** reads it, including the ones they have not
 * given yet.
 *
 * **The rendering moved to `attribute-value.tsx` in slice 2.10**, when the
 * public page needed it. What stayed here is the half that is owner-facing: the
 * to-do sentence for an unanswered attribute, which must never appear on a page
 * a stranger reads — a public listing enumerating what somebody has not filled
 * in is a page about our form rather than about the item.
 */
function OwnerAttributeValue({
  attribute,
  value,
}: {
  readonly attribute: CategoryAttribute;
  readonly value: string | number | readonly string[] | undefined;
}) {
  if (value === undefined) {
    return (
      <em>
        {attribute.required
          ? 'Not answered yet — needed before you can publish.'
          : 'Not answered.'}
      </em>
    );
  }

  return <AttributeValue attribute={attribute} value={value} />;
}

/**
 * Every failure gets its own sentence.
 *
 * A single "something went wrong" would make an expired session and an
 * unreachable API look identical, and only one of those is fixed by signing in
 * again.
 */
function Unavailable({ kind }: { readonly kind: string }) {
  if (kind === 'signed-out') {
    // The state first, the likeliest cause second. Claiming an expiry to
    // somebody who never signed in is a lie that costs them a pointless trip
    // through the sign-in page wondering what they lost.
    return (
      <p role="alert">
        You are not signed in. Your session may have expired —{' '}
        <Link href="/sign-in">sign in</Link> to see this listing.
      </p>
    );
  }

  return (
    <p role="alert">
      This listing could not be loaded. Nothing has been changed — try again in a
      moment.
    </p>
  );
}
