import { BRAND } from '@platform/config';
import Link from 'next/link';
import { BROWSE_PATH } from '../lib/page-paths';
import styles from './site-footer.module.css';

/**
 * The footer on every page (slice D2).
 *
 * **It lists what exists, which is less than the design draws.** The handoff's
 * footer carries Browse, How it works, Privacy, Terms and Support. How it works
 * is an anchor into a landing-page section nobody has written; the three legal
 * pages have no copy, because that is a solicitor's job rather than a
 * designer's. Shipping them as links now would put four dead controls in the one
 * component that appears on every page in the application.
 *
 * **Browse left that list in slice 3.1b**, when `/browse` was built. That is the
 * rule working rather than being relaxed — and it is here as well as in the
 * header because the footer is the only navigation on a page somebody has
 * scrolled to the bottom of.
 *
 * The columns are kept, because they are what the footer will look like once
 * those pages exist, and a one-column footer would have to be rebuilt.
 *
 * **It takes `signedIn`, and until the Phase 0–3 audit it did not.** `SiteHeader`
 * has read the session since D2 and this component — rendered on every page
 * beside it — was entirely static, so it offered *Sign in* and *Create an
 * account* to people who were already signed in, and *Your profile* to strangers.
 * The profile link led somewhere courteous rather than broken, which is why
 * nobody noticed: a page reading "Sign in to edit your profile" is still a nav
 * item that cannot be used, and BRD §15's rule about controls doing what they say
 * has no exemption for a polite dead end.
 *
 * The prop comes from the layout for the same reason the header's does: the
 * layout already holds the session, and a presentational component that fetches
 * its own auth state cannot be rendered in a test without standing up an
 * identity provider.
 */

const YEAR = 2026;

/**
 * What the Account column offers once there is an account.
 *
 * **The header's own menu, in its order.** `site-menu.tsx` decides what a
 * signed-in person can reach from anywhere; a second list here that disagreed
 * would be the failure that file's docblock warns about — an item that exists in
 * one navigation and not the other — arrived at from the opposite direction.
 */
const SIGNED_IN_LINKS: readonly { readonly href: string; readonly label: string }[] = [
  { href: '/account', label: 'Your account' },
  { href: '/account/profile', label: 'Your profile' },
  { href: '/listings', label: 'Your listings' },
];

/** And what it offers before there is one. */
const SIGNED_OUT_LINKS: readonly { readonly href: string; readonly label: string }[] = [
  { href: '/sign-in', label: 'Sign in' },
  { href: '/sign-up', label: 'Create an account' },
];

export function SiteFooter({ signedIn }: { readonly signedIn: boolean }) {
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
          {/* Renting before lending, the same order the header uses and for the
              same reason: this application has been supply-side until now. */}
          <Link href={BROWSE_PATH}>Browse</Link>
          <Link href="/listings/new">List a tool</Link>
        </div>

        <div className={styles.column}>
          <h2 className={styles.columnHeading}>Account</h2>
          {/*
            One list or the other, never both and never a mixture. The two
            states share no entry — everything a stranger is offered here is
            something a signed-in person has already done, and everything a
            signed-in person is offered needs the session a stranger has not
            got.

            *List a tool* stays above in Marketplace and is shown to everybody,
            which the header does too: the proxy sends a signed-out visitor to
            sign in before that page renders, so it is an invitation rather than
            a dead control.
          */}
          {(signedIn ? SIGNED_IN_LINKS : SIGNED_OUT_LINKS).map((link) => (
            <Link key={link.href} href={link.href}>
              {link.label}
            </Link>
          ))}
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
