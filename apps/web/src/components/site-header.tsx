import { BRAND } from '@platform/config';
import Link from 'next/link';
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
 * **Two links the design specifies are deliberately absent.** *Browse* points at
 * search, which is Phase 3, and *How it works* is an anchor into the landing
 * page, which is slice D3. BRD §15 forbids a control that does not do what it
 * says, and a nav item that 404s is worse than one that is not there yet. Both
 * arrive with the things they point at.
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
