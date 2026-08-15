import {
  LoadingAnnouncement,
  LoadingPage,
  SkeletonField,
  SkeletonLine,
  SkeletonTitle,
} from '../../loading-skeleton';

/**
 * While the category list loads (Phase 0–3 audit).
 *
 * **Fields, and this is the one shape that may be repeated.** How many fields
 * this form has is decided by the category schema rather than by how much
 * content exists, so drawing four of them promises a form — which is what is
 * coming — rather than promising content that may not be there.
 *
 * No page class: this form sits in the 600px default column, which is what most
 * of this application is.
 */
export default function NewListingLoading() {
  return (
    <LoadingPage>
      <LoadingAnnouncement>Loading the listing form</LoadingAnnouncement>
      <SkeletonTitle />
      <SkeletonLine />
      <SkeletonLine width="long" />
      <SkeletonField />
      <SkeletonField />
      <SkeletonField />
      <SkeletonField />
    </LoadingPage>
  );
}
