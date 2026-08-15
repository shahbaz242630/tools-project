import {
  LoadingAnnouncement,
  LoadingPage,
  SkeletonLine,
  SkeletonPanel,
  SkeletonTitle,
} from '../loading-skeleton';

/**
 * While the readiness check runs (Phase 0–3 audit).
 *
 * **The page whose whole content is a live read**, so it is the one where a
 * frozen previous page is most misleading: somebody opening `/status` while the
 * API is unreachable was shown the page they came from until the fetch timed
 * out, which is the opposite of what a status page is for.
 */
export default function StatusLoading() {
  return (
    <LoadingPage>
      <LoadingAnnouncement>Checking the platform’s status</LoadingAnnouncement>
      <SkeletonTitle />
      <SkeletonLine width="long" />
      <SkeletonPanel height="short" />
    </LoadingPage>
  );
}
