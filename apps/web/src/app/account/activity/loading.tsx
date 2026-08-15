import {
  LoadingAnnouncement,
  LoadingPage,
  SkeletonLine,
  SkeletonPanel,
  SkeletonTitle,
} from '../../loading-skeleton';

/**
 * While the account's activity log loads (Phase 0–3 audit).
 *
 * One panel rather than a stack of entry outlines, for the reason the owner's
 * listings page gives: how many entries somebody has is exactly what has not
 * been read yet, and a brand-new account has almost none.
 */
export default function AccountActivityLoading() {
  return (
    <LoadingPage>
      <LoadingAnnouncement>Loading your account activity</LoadingAnnouncement>
      <SkeletonTitle />
      <SkeletonLine width="long" />
      <SkeletonPanel />
    </LoadingPage>
  );
}
