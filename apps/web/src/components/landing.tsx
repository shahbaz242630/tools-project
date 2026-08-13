import Link from 'next/link';
import styles from './landing.module.css';

/**
 * The front page (slice D3).
 *
 * **Two things about this page are not the design's, and both are deliberate.**
 *
 * **It does not carry the hero's search pill, the "Near you" grid, or "Browse
 * everything".** All three are search, which is Phase 3 — there is no radius
 * query, no public list endpoint and no way to say what is *near* anybody. The
 * design's own note on the empty state gives the game away: it says the panel
 * *"replaces the 4-card grid when search returns nothing within 100 miles"*, so
 * it is a search result rather than a landing section. A search box that
 * searches nothing would be the largest dead control in the application (BRD
 * §15), and it arrives with the thing behind it.
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
 * The page therefore also says booking is not open, in the same words the public
 * listing page uses. Without it this is a shopfront for a shop that cannot sell
 * you anything.
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
          **The honest state of the platform, above the fold.** The public
          listing page has said this since slice 2.10 and the front page cannot
          say less: booking is Phase 4 and payments are Phase 5, so every verb in
          the section below is a description of the product rather than something
          a visitor can do today.

          The one thing they *can* do is list an item, which is also what the
          platform needs most — BRD §17 names low inventory density as the
          dominant failure mode of local marketplaces, and supply has to exist
          before demand has anywhere to go.
        */}
        <p className={styles.notice}>
          <strong>Booking is not open yet.</strong> The marketplace is still being
          built. You can list an item today, and renting opens when it is ready.
        </p>

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
