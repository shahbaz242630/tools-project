import {
  LoadingAnnouncement,
  LoadingPage,
  SkeletonPanel,
  SkeletonTitle,
} from '../../loading-skeleton';

/**
 * While somebody's public profile loads (Phase 0–3 audit).
 *
 * Not on the audit's list of pages, and it is the same defect: `force-dynamic`,
 * a server read on a five-second timeout, and no boundary. Leaving the one data
 * page in the application without feedback would be an inconsistency somebody
 * later has to explain.
 */
export default function PublicProfileLoading() {
  return (
    <LoadingPage>
      <LoadingAnnouncement>Loading this profile</LoadingAnnouncement>
      <SkeletonTitle />
      <SkeletonPanel height="short" />
    </LoadingPage>
  );
}
