import {
  LoadingAnnouncement,
  LoadingPage,
  SkeletonLine,
  SkeletonPanel,
  SkeletonTitle,
} from '../loading-skeleton';

/**
 * While an administrative page loads (Phase 0–3 audit).
 *
 * **One file for all seven**, because the shape is the same on every one of them
 * — a heading, a sentence, and a panel of whatever was looked up — and because a
 * `loading.tsx` covers its whole segment. Seven near-identical files would be
 * seven places to forget.
 *
 * **It sits inside `admin/layout.tsx`, which reads the account before it renders
 * anything.** Next does not show a loading fallback for a layout's own uncached
 * data, so arriving at an admin page from outside the section still waits on that
 * read with nothing on screen — this fires on the navigations that go
 * *between* admin pages, which is what the admin nav does and is where the
 * waiting actually happens. Moving that read out of the layout would fix the
 * remainder and would also mean an admin page could exist without the
 * second-factor banner, which is the one thing that layout is for (ADR 0030).
 */
export default function AdminLoading() {
  return (
    <LoadingPage>
      <LoadingAnnouncement>Loading this administrative page</LoadingAnnouncement>
      <SkeletonTitle />
      <SkeletonLine width="long" />
      <SkeletonPanel />
    </LoadingPage>
  );
}
