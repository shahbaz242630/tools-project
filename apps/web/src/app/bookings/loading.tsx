import {
  LoadingAnnouncement,
  LoadingPage,
  SkeletonLine,
  SkeletonPanel,
  SkeletonTitle,
} from '../loading-skeleton';
import styles from './bookings.module.css';

/**
 * While the two lists load (slice 4.8b).
 *
 * **Two panels, and no rows inside either.** `booking-list.tsx` distinguishes
 * somebody with no bookings from a list that could not be read, because telling
 * a person a confirmed hire has vanished is the worst answer this page can give.
 * A skeleton drawing rows undoes half of that before the read has finished — it
 * promises bookings to somebody who may have none.
 *
 * Two rather than one because the page has two sections and they load together;
 * a single panel would redraw into two and shift everything below it.
 */
export default function BookingsLoading() {
  return (
    <LoadingPage className={styles.page}>
      <LoadingAnnouncement>Loading your bookings</LoadingAnnouncement>
      <SkeletonTitle />
      <SkeletonLine width="long" />
      <SkeletonPanel />
      <SkeletonPanel />
    </LoadingPage>
  );
}
