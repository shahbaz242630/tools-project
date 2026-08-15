import {
  LoadingAnnouncement,
  LoadingPage,
  SkeletonPanel,
  SkeletonTitle,
} from '../loading-skeleton';
import styles from './browse.module.css';

/**
 * While a search runs (Phase 0–3 audit).
 *
 * **The page most in need of one.** `/browse` geocodes a postcode and then runs
 * a PostGIS radius query, both behind a five-second timeout, and until this file
 * existed a searcher pressing Search saw the previous page unchanged for as long
 * as that took — the one interaction in this application where somebody has just
 * done something and is waiting for an answer.
 *
 * **The form is drawn as a panel and the results as one block below it.** Not a
 * grid of card outlines: this is the page whose empty state is real and
 * designed — "nothing within 5 miles, try 10" — and promising six results before
 * a single row has been read is the version of a skeleton that lies.
 *
 * The width comes from the page's own module so the column does not jump when
 * the results land.
 */
export default function BrowseLoading() {
  return (
    <LoadingPage className={styles.page}>
      <LoadingAnnouncement>Searching for tools near you</LoadingAnnouncement>
      <SkeletonTitle />
      <SkeletonPanel height="short" />
      <SkeletonPanel />
    </LoadingPage>
  );
}
