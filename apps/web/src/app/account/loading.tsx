import {
  LoadingAnnouncement,
  LoadingPage,
  SkeletonPanel,
  SkeletonTitle,
} from '../loading-skeleton';

/**
 * While an account page loads (Phase 0–3 audit).
 *
 * **It covers `/account` and everything under it that has no `loading.tsx` of
 * its own** — the profile form, the data download page and the deletion page —
 * which is why it draws no heading text. A `loading.tsx` inherits down the tree,
 * so a real "Account" heading here would flash the wrong words on three other
 * pages before each corrected itself. A title-shaped bar is right on all four.
 *
 * `/account/activity` has its own, because its shape is a log rather than a pair
 * of cards.
 */
export default function AccountLoading() {
  return (
    <LoadingPage>
      <LoadingAnnouncement>Loading your account</LoadingAnnouncement>
      <SkeletonTitle />
      <SkeletonPanel height="short" />
      <SkeletonPanel />
    </LoadingPage>
  );
}
