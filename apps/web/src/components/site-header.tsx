import { BRAND } from '@platform/config';
import Link from 'next/link';
import { BROWSE_PATH } from '../lib/page-paths';
import { AccountMenu, MobileMenu } from './site-menu';
import styles from './site-header.module.css';

/**
 * The bar at the top of every page (slice D2).
 *
 * **Server-rendered and mostly plain anchors**, so the whole navigation works
 * with JavaScript disabled and with a keyboard before hydration. Only the avatar
 * dropdown and the mobile sheet are client components, because only they hold
 * state.
 *
 * It takes `signedIn` as a prop rather than reading Clerk itself. The layout
 * already knows — it holds the session — and a presentational component that
 * fetches its own auth state cannot be rendered in a test without standing up an
 * identity provider.
 *
 * **Browse arrived in slice 3.1b, and it arrived because the page did.** It was
 * absent from D2 through 3.1a on the rule BRD §15 states — a control must do
 * what it says, and a nav item that 404s is worse than one that is not there.
 * That rule is why it is here now rather than why it was missing: `/browse`
 * exists, so the link does.
 *
 * **One link the design specifies is still absent.** *How it works* is an anchor
 * into a section of the landing page that has not been written. It arrives with
 * the thing it points at, the same way this one did.
 */
export function SiteHeader({
  signedIn,
  email,
}: {
  readonly signedIn: boolean;
  /** From the session claim. Only ever used for the avatar's letter. */
  readonly email: string | null;
}) {
  return (
    <header className={styles.header}>
      <div className={styles.bar}>
        {/*
          The wordmark reads from the one file the brand lives in (ADR 0005), so
          deciding the name changes this without anybody editing a component.
          Today it renders the placeholder, which is the truth.
        */}
        <Link href="/" className={styles.wordmark}>
          {BRAND.name}
        </Link>

        <nav className={styles.nav} aria-label="Main">
          {/*
            **Before the sign-in and listing controls, and shown to everybody.**
            Renting is the demand side and this application has been entirely
            supply-side until now; the first thing a stranger should be offered
            is the thing they came for, not an invitation to sign up.
          */}
          <Link href={BROWSE_PATH} className={styles.link}>
            Browse
          </Link>

          {signedIn ? (
            <>
              <Link href="/listings/new" className={styles.link}>
                List a tool
              </Link>
              <AccountMenu email={email} />
            </>
          ) : (
            <>
              <Link href="/sign-in" className={styles.link}>
                Sign in
              </Link>
              <Link href="/listings/new" className={styles.pill}>
                List a tool
              </Link>
            </>
          )}

          <MobileMenu signedIn={signedIn} email={email} />
        </nav>
      </div>
    </header>
  );
}
