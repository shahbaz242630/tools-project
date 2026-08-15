import {
  LoadingAnnouncement,
  LoadingPage,
  SkeletonLine,
  SkeletonPanel,
  SkeletonTitle,
} from '../../loading-skeleton';
import styles from './listing-detail.module.css';

/**
 * While one of an owner's own listings loads (Phase 0–3 audit).
 *
 * The title bar stands in for the item's name, the short line for the status
 * sentence under it, and the panel for the fact grid — which is as far as a
 * skeleton can honestly go, because how many rows that grid has depends on the
 * category's attribute schema and nothing here has read it yet.
 */
export default function ListingLoading() {
  return (
    <LoadingPage className={styles.page}>
      <LoadingAnnouncement>Loading this listing</LoadingAnnouncement>
      <SkeletonTitle />
      <SkeletonLine width="short" />
      <SkeletonPanel />
    </LoadingPage>
  );
}
