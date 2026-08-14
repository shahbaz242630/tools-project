import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from './notice-page.module.css';

/**
 * The centred page behind 404 and the error boundary (slice D3).
 *
 * One component because the design draws one shape twice — a monospace overline,
 * a heading, one calm sentence and a pair of buttons — and because the two pages
 * that use it are `app/` files, which this repository does not unit test. Putting
 * the shape here is what makes the copy assertable.
 *
 * **The action is a prop rather than a variant flag.** The 404 offers a link
 * home; the error boundary offers a button that calls React's `reset`. Those are
 * different elements, not different labels, and a component that took
 * `kind: '404' | 'error'` would have to know about both.
 *
 * **Which is why slice 3.1e added a second prop rather than widening the first.**
 * The 404's primary action is a *link* to Browse and the error boundary's is a
 * *button* that retries. Passing markup for the link would have meant the caller
 * reaching for this module's styles, which it cannot see; passing
 * `kind: 'link' | 'button'` is the flag the paragraph above rejects. Two props,
 * one per element, and a page that wants neither passes neither.
 */
export function NoticePage({
  overline,
  heading,
  children,
  action,
  primaryLink,
}: {
  /** Small, monospace, above the heading — "404", "SOMETHING WENT WRONG". */
  readonly overline: string;
  readonly heading: string;
  /** One calm sentence. */
  readonly children: ReactNode;
  /** The primary control, when the page has one that is not a link. */
  readonly action?: ReactNode;
  /** The primary control, when it *is* a link. */
  readonly primaryLink?: { readonly href: string; readonly label: string };
}) {
  return (
    <main className={styles.page}>
      <p className={styles.overline}>{overline}</p>
      <h1 className={styles.heading}>{heading}</h1>
      <p className={styles.body}>{children}</p>

      <div className={styles.actions}>
        {action}
        {/*
          **The design's pairing, complete from slice 3.1e.** It draws "Browse
          tools" beside "Go home"; D3 shipped only the second, because search was
          Phase 3 and a 404 linking to a page that does not exist is a joke at
          the reader's expense. It exists now, so the pair is whole — and on the
          404 the Browse link is the *primary* one, because the commonest way to
          reach that page is a listing that is gone and the useful answer is a
          way to find another.
        */}
        {primaryLink !== undefined && (
          <Link href={primaryLink.href} className={styles.primary}>
            {primaryLink.label}
          </Link>
        )}
        <Link href="/" className={styles.secondary}>
          Go home
        </Link>
      </div>
    </main>
  );
}
