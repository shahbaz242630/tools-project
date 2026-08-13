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
 */
export function NoticePage({
  overline,
  heading,
  children,
  action,
}: {
  /** Small, monospace, above the heading — "404", "SOMETHING WENT WRONG". */
  readonly overline: string;
  readonly heading: string;
  /** One calm sentence. */
  readonly children: ReactNode;
  /** The primary control, when the page has one that is not a link. */
  readonly action?: ReactNode;
}) {
  return (
    <main className={styles.page}>
      <p className={styles.overline}>{overline}</p>
      <h1 className={styles.heading}>{heading}</h1>
      <p className={styles.body}>{children}</p>

      <div className={styles.actions}>
        {action}
        {/*
          **"Go home" and nothing else.** The design pairs it with "Browse
          tools", which is search — Phase 3. A 404 offering a link to another
          page that does not exist is a joke at the reader's expense.
        */}
        <Link href="/" className={styles.secondary}>
          Go home
        </Link>
      </div>
    </main>
  );
}
