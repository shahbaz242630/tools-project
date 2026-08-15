import {
  LoadingAnnouncement,
  LoadingPage,
  SkeletonPanel,
  SkeletonTitle,
} from '../../loading-skeleton';
import styles from './hire.module.css';

/**
 * While a public listing loads (Phase 0–3 audit).
 *
 * **The only page here a stranger with no account reaches from a search
 * engine**, so it is also the one where a blank wait is most likely to be read
 * as a site that does not work.
 *
 * **No heading bar for the title.** The `<h1>` on this page is the item's own
 * name and it is what is being fetched; a title-shaped bar is honest about that,
 * where drawing anything with words in it would not be.
 *
 * Two panels rather than the design's two columns: the sticky price card is
 * placed by grid on desktop and stacks on a phone (slice D8), and reproducing
 * that placement for a rectangle would be layout code with nothing in it.
 */
export default function PublicListingLoading() {
  return (
    <LoadingPage className={styles.page}>
      <LoadingAnnouncement>Loading this listing</LoadingAnnouncement>
      <SkeletonTitle />
      <SkeletonPanel />
      <SkeletonPanel height="short" />
    </LoadingPage>
  );
}
