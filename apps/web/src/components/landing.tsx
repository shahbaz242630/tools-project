import Link from 'next/link';
import { DEFAULT_SEARCH_RADIUS_MILES } from '@platform/contracts';
import { BrowseSearch } from './browse-search';
import styles from './landing.module.css';

/**
 * The front page (slice D3, search added in 3.1e).
 *
 * **Two things about this page are not the design's, and both are deliberate.**
 *
 * **The hero now searches, and the "Near you" grid still does not exist.** Both
 * were withheld in D3 because search was Phase 3; 3.1b built it, so the pill is
 * real — it is `BrowseSearch`, the same control the search page uses, so the two
 * cannot disagree about a parameter name.
 *
 * **The grid stays out, and that is a decision rather than a deferral.** It
 * needs a location for somebody who has given us none, and the three ways to
 * get one are all worse than asking. Browser geolocation cannot fill a panel
 * nobody has touched — Chrome's own Lighthouse audit fails a page for requesting
 * it on load — and it collects a precise point to answer a question that only
 * needs a postcode. IP inference is a free Cloudflare header and wrong too
 * often to be useful at a five-mile radius: roughly 60–75% correct city on fixed
 * lines, worse on mobile and CGNAT, which is most traffic. Remembering a typed
 * postcode is storage on somebody's device, which engages PECR, and the ICO's
 * strictly-necessary exemption does not cover a convenience. **So the hero asks,
 * and the answer lives in the URL** — which is what Gumtree does (it says
 * plainly *"In your area — United Kingdom"* rather than guessing) and roughly
 * what Hygglo does. `landing.test.tsx` pins it: there is exactly one place to
 * ask, and nothing on this page claims to know where anybody is.
 *
 * **"Browse everything" is not here either, and it is redundant rather than
 * unbuilt.** In the design it is the escape hatch beneath the grid; with no grid
 * it has no parent, and the header already carries *Browse* while the hero now
 * carries the search itself. Three routes to one page on one screen is not
 * generosity.
 *
 * **The copy about money was rewritten, and this is the more important one.** The
 * handoff says *"Deposits held safely"*, *"Pay by the day with a refundable
 * deposit"* and *"Your deposit comes back when the tool does"*. We do not take a
 * deposit and hold it. BRD §8.7.2 authorises a **hold on the renter's own card**
 * at the collection window and captures against it; no customer money ever sits
 * with us. `public-listing.tsx` already says it correctly — *"A refundable damage
 * hold may also apply at collection. It is not a fee"* — and a marketing page
 * that contradicts the disclosure on the page you book from is the wrong half to
 * keep. §8.15 is emphatic that substance beats labels.
 *
 * The page therefore also says **paying** is not open. Without it this is a
 * shopfront for a shop that cannot take payment. It said *booking* was not open
 * until 25 August 2026, six days after Phase 4 closed and made that false — see
 * the notice itself for the account.
 */
export function Landing() {
  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <h1 className={styles.headline}>
          Borrow better<span className={styles.stop}>.</span>
        </h1>

        <p className={styles.lede}>
          Tools and garden equipment, rented by the day from people near you. Addresses
          stay private until a booking is agreed.
        </p>

        {/*
          **The honest state of the platform, above the fold** — and it went
          stale for six days, which is the reason this comment is longer than
          the sentence it explains.

          It read *"Booking is not open yet … renting opens when it is ready"*
          from slice 3.1e until 25 August 2026. That was true when it was
          written: booking was Phase 4 and unbuilt. **Phase 4 closed on 19
          August**, and nobody came back here — so the front page went on telling
          people not to try the single most valuable thing they could do, while
          `landing.test.tsx` pinned the wrong sentence and every check stayed
          green. Found by reading the page before sending a beta link, which is
          `LESSONS.md`'s standing lesson arriving exactly on schedule.

          **What is true now:** a renter can pick dates, read a firm inclusive
          total and ask an owner for the item; the owner can accept or decline;
          an unanswered request expires on its own. What does not work is
          **paying** — `booking.payment` is off until 5.2e, so an accepted
          booking rests in `ACCEPTED` and goes no further.

          So the notice names *payment*, not booking. Say the narrowest true
          thing: a visitor who is told the wrong door is shut does not try the
          one that is open.

          Listing is still called out first, because it is what the platform
          needs most — BRD §17 names low inventory density as the dominant
          failure mode of local marketplaces, and supply has to exist before
          demand has anywhere to go.
        */}
        <p className={styles.notice}>
          <strong>Paying is not open yet.</strong> You can list an item, find one near
          you and ask its owner for it — and an owner can accept or decline. Money does
          not change hands here yet, so agree that between yourselves for now.
        </p>

        {/*
          **The ask, and it sits below the notice on purpose** (slice 3.1e).
          Search works, and so does asking an owner for an item — but paying does
          not, and inviting somebody to search before saying so would put the
          good news above the honest news. Same instinct as D3's decision to keep
          the notice above the fold at all.

          It is the search page's own form rather than a copy, so the field
          names, the five radii and the placeholder cannot drift from what the
          API accepts. It carries no postcode, because we know nothing about
          whoever is reading this and will not pretend otherwise — the module
          docblock has the three ways we could have guessed and why each was
          rejected.
        */}
        {/*
          **No category either, and for the same reason as the postcode** (slice
          3.2a): we know nothing about whoever is reading this, and a filter
          nobody chose is a narrower search than they asked for.

          **`categories={[]}` is deliberate, not a stub** (slice 3.2b). The hero
          asks the one question it has to ask, and a category `select` here would
          be a second decision in front of somebody who has not made the first —
          the same argument that cut the "Near you" grid in 3.1e. Browse is one
          click away and has the control.

          **`keywordField={false}` is the same decision for the same reason**
          (slice 3.3b), and it is worth saying that it is a decision rather than
          an omission: a "what are you looking for?" box here would be perfectly
          reasonable, and every large marketplace has one. It is left out because
          this hero's job is to get somebody to a search at all, a keyword is
          optional where a postcode is not, and adding it is a change to the
          landing page rather than a consequence of building the search box.
          Turn it on deliberately, not by noticing the prop.
        */}
        <BrowseSearch
          postcode=""
          radiusMiles={DEFAULT_SEARCH_RADIUS_MILES}
          category={null}
          categories={[]}
          keyword={null}
          /* The hero is an entry point: it carries no dates to preserve, exactly
             as it carries no keyword and no categories. */
          dates={null}
          keywordField={false}
          error={null}
          className={styles.heroSearch}
        />

        <Link href="/listings/new" className={styles.cta}>
          List a tool
        </Link>

        <p className={styles.strapline}>Peer-to-peer rental · United Kingdom</p>
      </section>

      <section className={styles.steps} aria-labelledby="how-it-works">
        {/* The nav will link here once it carries "How it works"; the id is what
            makes that a one-line change rather than a restructure. */}
        <h2 id="how-it-works" className={styles.srOnly}>
          How it works
        </h2>

        <div className={styles.step}>
          <div className={styles.stepNumber}>1</div>
          <h3>Find it nearby</h3>
          <p>
            Search your area. Every listing shows a postcode district, never a full
            address.
          </p>
        </div>

        <div className={styles.step}>
          <div className={styles.stepNumber}>2</div>
          <h3>Book your days</h3>
          {/*
            Not "with a refundable deposit". A hold is authorised against the
            renter's card and released or captured; it is never money we take.
            §3.4.4 also requires the price a renter sees to be inclusive of
            mandatory fees and to show the damage security separately, which is
            why the second sentence exists at all.
          */}
          <p>
            Pay by the day, at a price that already includes our fee. A refundable hold
            covers damage and is never part of that price.
          </p>
        </div>

        <div className={styles.step}>
          <div className={styles.stepNumber}>3</div>
          <h3>Collect &amp; return</h3>
          <p>Meet, borrow, return. The hold is released when the tool comes back.</p>
        </div>
      </section>

      <section className={styles.privacy} aria-labelledby="privacy-heading">
        <h2 id="privacy-heading" className={styles.privacyHeading}>
          Your address stays yours.
        </h2>

        <div className={styles.privacyList}>
          <div className={styles.privacyItem}>
            <h3>District, not doorstep</h3>
            <p>
              Your profile shows only the first part of your postcode — a district that
              covers thousands of homes.
            </p>
          </div>

          <div className={styles.privacyItem}>
            <h3>Details only after you agree</h3>
            <p>
              Phone numbers and full addresses are shared only between two people who
              have agreed a rental.
            </p>
          </div>

          <div className={styles.privacyItem}>
            {/*
              The handoff called this "Deposits, held properly", which describes
              something we deliberately do not do. Naming the mechanism is also
              simply better copy: "we never hold your money" is the reassuring
              part, and it happens to be true.
            */}
            <h3>A hold, not a deposit</h3>
            <p>
              We never take a deposit and keep it. A hold sits on the renter&rsquo;s own
              card and is released when the item comes home.
            </p>
          </div>
        </div>
      </section>

      <section className={styles.owner}>
        <h2 className={styles.ownerHeading}>Your tools could be earning.</h2>
        <p className={styles.ownerLede}>
          Set a daily price, approve every booking, lend on your terms. Listing is free.
        </p>
        <Link href="/listings/new" className={styles.cta}>
          List a tool
        </Link>
      </section>
    </main>
  );
}
