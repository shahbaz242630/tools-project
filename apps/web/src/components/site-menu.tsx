'use client';

import { SignOutButton } from '@clerk/nextjs';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import styles from './site-menu.module.css';

/**
 * The two interactive parts of the header (slice D2).
 *
 * **Everything else in the header is server-rendered and works without
 * JavaScript** — the wordmark, the nav links and the sign-in and list-a-tool
 * buttons are all plain anchors. Only the two things that genuinely need state
 * live here: the avatar dropdown on desktop and the sheet on mobile.
 *
 * They are one file because they are one decision — what a signed-in person can
 * reach from anywhere — presented twice. Two files would mean two lists, and the
 * failure that produces is a menu item that exists on a laptop and not on a
 * phone.
 */

/**
 * Where the account menu goes, in the order the design lists them.
 *
 * Signing out is deliberately not in here: it is a Clerk component rather than a
 * link, and it is styled as a danger action. Putting it in the array would mean
 * a branch inside the map for the one entry that is not a link at all.
 */
const ACCOUNT_LINKS: readonly { readonly href: string; readonly label: string }[] = [
  { href: '/account', label: 'Account' },
  { href: '/account/profile', label: 'Your profile' },
  { href: '/listings', label: 'Your listings' },
];

/**
 * Ties each trigger to the panel it opens, so a screen reader can move to the
 * panel rather than hunting for whatever appeared. Constants rather than
 * `useId`, because these two are the only ones of their kind on any page.
 */
const ACCOUNT_PANEL_ID = 'account-menu';
const MOBILE_PANEL_ID = 'mobile-menu';

/**
 * The letter in the avatar.
 *
 * **The email's initial, not the display name's**, and that is a deliberate
 * trade rather than an oversight. The display name lives on the profile, which
 * `/me` does not carry — reading it would put an API call in the root layout and
 * charge every page in the application, including the public listing page that
 * has to stay fast, for a single character. The email arrives free in the
 * session token that every request already carries.
 *
 * Falls back to a dot rather than a letter when there is no claim at all, since
 * an empty circle reads as a broken image and a wrong letter reads as somebody
 * else's account.
 */
export function avatarInitial(email: string | null): string {
  const first = (email ?? '').trim().charAt(0);
  return first === '' ? '·' : first.toUpperCase();
}

/**
 * Close on Escape, and on any click that lands outside.
 *
 * **Escape puts focus back on the trigger**, which is the half of this that is
 * easy to leave out. Closing a panel destroys whatever was focused inside it, and
 * a keyboard user whose focus has been thrown back to the top of the document
 * has to tab through the entire page to get where they were.
 *
 * Takes React's own `setOpen` rather than a `close` callback: a fresh arrow
 * function on every render would make this effect tear down and rebuild its
 * listeners on every render, which works and is a waste.
 */
function useDismissable(open: boolean, setOpen: (open: boolean) => void) {
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open, setOpen]);

  return { container, trigger };
}

/**
 * The avatar and its dropdown — desktop only, hidden below the mobile
 * breakpoint where the sheet takes over.
 */
export function AccountMenu({ email }: { readonly email: string | null }) {
  const [open, setOpen] = useState(false);
  const { container, trigger } = useDismissable(open, setOpen);

  return (
    <div className={styles.account} ref={container}>
      <button
        ref={trigger}
        type="button"
        className={styles.avatar}
        aria-expanded={open}
        aria-controls={ACCOUNT_PANEL_ID}
        onClick={() => setOpen(!open)}
      >
        {/* The letter is decorative — the accessible name is the label below,
            because "S" announced on its own tells a screen reader user nothing
            about what the button does. */}
        <span aria-hidden="true">{avatarInitial(email)}</span>
        <span className={styles.srOnly}>Your account</span>
      </button>

      {/*
        **A labelled `<nav>`, not `role="menu"`.** The ARIA menu role carries a
        keyboard contract — arrow keys move between items, Home and End jump to
        the ends, typing a letter jumps to a match — and a element that claims the
        role without honouring it is worse than one that never claimed it: it
        tells a screen reader user to expect behaviour that is not there. This is
        a list of links, which is what `nav` is for, and Tab already works.
      */}
      {open ? (
        <nav id={ACCOUNT_PANEL_ID} className={styles.dropdown} aria-label="Account">
          {ACCOUNT_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={styles.menuRow}
              onClick={() => setOpen(false)}
            >
              {link.label}
            </Link>
          ))}
          <SignOutButton>
            <button type="button" className={styles.signOut}>
              Sign out
            </button>
          </SignOutButton>
        </nav>
      ) : null}
    </div>
  );
}

/**
 * The hamburger and its sheet — mobile only.
 *
 * Carries the signed-out rows too, which the desktop header renders inline. On a
 * 375px bar there is no room for a sign-in link beside a list-a-tool pill, so
 * both move inside.
 */
export function MobileMenu({
  signedIn,
  email,
}: {
  readonly signedIn: boolean;
  readonly email: string | null;
}) {
  const [open, setOpen] = useState(false);
  const { container, trigger } = useDismissable(open, setOpen);
  const close = () => setOpen(false);

  return (
    <div className={styles.mobile} ref={container}>
      {signedIn ? (
        <span className={styles.avatarStatic} aria-hidden="true">
          {avatarInitial(email)}
        </span>
      ) : null}

      <button
        ref={trigger}
        type="button"
        className={styles.hamburger}
        aria-expanded={open}
        aria-controls={MOBILE_PANEL_ID}
        onClick={() => setOpen(!open)}
      >
        {/* Three bars drawn in CSS rather than an icon font or an SVG set. The
            design needs no icons anywhere else, and one dependency for one
            glyph is not a trade worth making. */}
        <span className={styles.bars} aria-hidden="true" />
        <span className={styles.srOnly}>Menu</span>
      </button>

      {open ? (
        <nav id={MOBILE_PANEL_ID} className={styles.sheet} aria-label="Menu">
          {signedIn ? (
            <>
              {ACCOUNT_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={styles.sheetRow}
                  onClick={close}
                >
                  {link.label}
                </Link>
              ))}
              <SignOutButton>
                <button type="button" className={styles.sheetSignOut}>
                  Sign out
                </button>
              </SignOutButton>
              <Link href="/listings/new" className={styles.sheetPill} onClick={close}>
                List a tool
              </Link>
            </>
          ) : (
            <>
              <Link href="/sign-in" className={styles.sheetRow} onClick={close}>
                Sign in
              </Link>
              <Link href="/listings/new" className={styles.sheetPill} onClick={close}>
                List a tool
              </Link>
            </>
          )}
        </nav>
      ) : null}
    </div>
  );
}
