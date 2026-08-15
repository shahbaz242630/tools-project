import type { ReactNode } from 'react';
import styles from './loading-skeleton.module.css';

/**
 * The pieces every `loading.tsx` in this application is built from (Phase 0–3
 * audit).
 *
 * **There was not one loading state anywhere before this.** Every page that
 * reads data is `export const dynamic = 'force-dynamic'` with a server fetch on a
 * five-second timeout and no Suspense boundary, so a slow API meant up to five
 * seconds of the *previous* page sitting there with nothing to say — a link that
 * looks like it did not register, on `/browse`, `/hire/[id]`, `/listings`,
 * `/account`, `/status` and every administrative page.
 *
 * **This is not `route-transition.tsx` and does not fight it.** That is a 250ms
 * fade played when a page mounts; it says a navigation happened, not that one is
 * still happening. The two compose rather than collide: the fade plays once when
 * the skeleton mounts, and React then swaps the real content into the same
 * Suspense boundary without remounting the wrapper, so nothing fades twice.
 *
 * **Not in `components/`, on purpose.** Nothing here makes a decision — there is
 * no data, no branch and no copy that claims anything — so it is layout for the
 * `app/` files that use it, which is where `admin-access.tsx` already sits for
 * the same reason.
 */

/**
 * The visually-hidden line that says what is being waited for.
 *
 * **The part of a skeleton that is not decoration.** Bars announce nothing, so
 * without this a screen reader meets an empty page and is told nothing at all.
 * `role="status"` rather than `alert`: waiting is not an error, and `status` is
 * polite — it waits for a pause rather than interrupting.
 *
 * The label names the thing, not the mechanism. "Loading your listings" is
 * something a person can act on; "Loading" is a spinner spelled out.
 */
export function LoadingAnnouncement({ children }: { readonly children: string }) {
  return (
    <p role="status" className={styles.announcement}>
      {children}
    </p>
  );
}

/**
 * Everything below is decoration, and every one of them says so.
 *
 * `aria-hidden` on each bar rather than on a wrapper, so a caller cannot
 * accidentally hide the announcement by nesting it inside the wrong element.
 */

/** Where the page's heading will be. */
export function SkeletonTitle() {
  return <div aria-hidden="true" className={`${styles.bar} ${styles.title}`} />;
}

/** A line of the sentence under it. */
export function SkeletonLine({
  width = 'full',
}: {
  /** A closed set rather than a number — three widths is a rhythm, not a knob. */
  readonly width?: 'full' | 'long' | 'short';
}) {
  const size =
    width === 'full'
      ? styles.lineFull
      : width === 'long'
        ? styles.lineLong
        : styles.lineShort;

  return <div aria-hidden="true" className={`${styles.bar} ${styles.line} ${size}`} />;
}

/**
 * A region standing in for content whose amount is not known yet.
 *
 * **One block, never a row of them** — see the note in the stylesheet. A row of
 * card outlines is a promise about how much there is, made before anything has
 * been read, to an application whose empty states are real.
 */
export function SkeletonPanel({
  height = 'tall',
}: {
  readonly height?: 'short' | 'tall';
}) {
  return (
    <div
      aria-hidden="true"
      className={`${styles.bar} ${styles.panel} ${
        height === 'tall' ? styles.panelTall : styles.panelShort
      }`}
    />
  );
}

/**
 * One form field: its label and its control.
 *
 * The one shape that may be repeated, because how many fields a form has is
 * decided by the category schema rather than by how much content exists.
 */
export function SkeletonField() {
  return (
    <div className={styles.field}>
      <div aria-hidden="true" className={`${styles.bar} ${styles.fieldLabel}`} />
      <div aria-hidden="true" className={`${styles.bar} ${styles.fieldControl}`} />
    </div>
  );
}

/**
 * The `<main>` every loading state renders, so that the skeleton occupies the
 * same column the page will.
 *
 * **The width comes from the page's own module**, passed in as a class rather
 * than restated here. `--page-width` is read on `<main>` and differs per route —
 * 1160px on Browse, 1080px on a public listing, 1000px on the owner's table,
 * 720px on one of their listings — and a skeleton that used the 600px default
 * would reflow the whole page the moment the content arrived, which is the
 * jolt a loading state exists to prevent.
 */
export function LoadingPage({
  className,
  children,
}: {
  /**
   * The page's own `.page` class, or absent for the 600px default.
   *
   * `| undefined` written out, because `exactOptionalPropertyTypes` is on and a
   * CSS Module's class is typed `string | undefined` — Next cannot know at
   * compile time which classes a stylesheet defines, so every lookup is
   * possibly-absent and "optional" and "present but undefined" are different
   * types here.
   */
  readonly className?: string | undefined;
  readonly children: ReactNode;
}) {
  return <main className={className}>{children}</main>;
}
