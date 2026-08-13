import { BRAND } from '@platform/config';
import Link from 'next/link';
import styles from './site-footer.module.css';

/**
 * The footer on every page (slice D2).
 *
 * **It lists what exists, which is less than the design draws.** The handoff's
 * footer carries Browse, How it works, Privacy, Terms and Support. Browse is
 * Phase 3; How it works is an anchor into the landing page, slice D3; and the
 * three legal pages have no copy, because that is a solicitor's job rather than
 * a designer's. Shipping them as links now would put five dead controls in the
 * one component that appears on every page in the application.
 *
 * The columns are kept, because they are what the footer will look like once
 * those pages exist, and a one-column footer would have to be rebuilt.
 */

const YEAR = 2026;

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.columns}>
        <div>
          <div className={styles.wordmark}>{BRAND.name}</div>
          {/*
            Names the launch category, which is a marketing statement about what
            we sell today rather than an assumption baked into the engine. The
            categories themselves remain configuration (BRD §5) — nothing here
            is read by anything.
          */}
          <p className={styles.tagline}>
            Peer-to-peer rental of tools and garden equipment, across the UK.
          </p>
        </div>

        <div className={styles.column}>
          <h2 className={styles.columnHeading}>Marketplace</h2>
          <Link href="/listings/new">List a tool</Link>
        </div>

        <div className={styles.column}>
          <h2 className={styles.columnHeading}>Account</h2>
          <Link href="/sign-in">Sign in</Link>
          <Link href="/sign-up">Create an account</Link>
          <Link href="/account/profile">Your profile</Link>
        </div>

        <div className={styles.column}>
          <h2 className={styles.columnHeading}>Platform</h2>
          <Link href="/status">Status</Link>
        </div>
      </div>

      <div className={styles.legal}>
        © {YEAR} {BRAND.name}
      </div>
    </footer>
  );
}
