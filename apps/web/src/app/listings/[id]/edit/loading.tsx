import {
  LoadingAnnouncement,
  LoadingPage,
  SkeletonField,
  SkeletonTitle,
} from '../../../loading-skeleton';

/**
 * While an edit form loads (Phase 0–3 audit).
 *
 * **The page with two reads and therefore the longest wait**: the listing and
 * the category's current schema, fetched concurrently and each on its own
 * five-second timeout, and the form is drawn only when both land.
 *
 * Its own file rather than inheriting `../loading.tsx`, which draws the fact
 * grid of the page this one edits.
 */
export default function EditListingLoading() {
  return (
    <LoadingPage>
      <LoadingAnnouncement>Loading this listing for editing</LoadingAnnouncement>
      <SkeletonTitle />
      <SkeletonField />
      <SkeletonField />
      <SkeletonField />
      <SkeletonField />
    </LoadingPage>
  );
}
