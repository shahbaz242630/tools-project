import {
  LoadingAnnouncement,
  LoadingPage,
  SkeletonLine,
  SkeletonPanel,
  SkeletonTitle,
} from '../loading-skeleton';
import styles from './listings.module.css';

/**
 * While an owner's listings load (Phase 0–3 audit).
 *
 * **One panel, not five table rows.** `ListingList` distinguishes an owner with
 * nothing listed from a list that could not be read, and it does so because
 * telling somebody their work has gone is the worst answer this page can give.
 * A skeleton drawing rows undoes half of that before the read has even
 * finished — it promises listings to somebody who may have none.
 *
 * **`/listings/new`, `/listings/[id]` and its edit form each have their own**,
 * because a `loading.tsx` covers its segment and everything under it, and this
 * one's shape is a table. A form waiting behind a table outline is the same
 * small lie in a different place.
 */
export default function ListingsLoading() {
  return (
    <LoadingPage className={styles.page}>
      <LoadingAnnouncement>Loading your listings</LoadingAnnouncement>
      <SkeletonTitle />
      <SkeletonLine width="long" />
      <SkeletonPanel />
    </LoadingPage>
  );
}
