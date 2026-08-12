import { notFound } from 'next/navigation';
import { fetchPublicListing } from '../../../lib/listings';
import { webEnv } from '../../../lib/env';
import { PublicListingView } from '../../../components/public-listing';

/**
 * A listing, as anybody may see it — the first page in this project that does
 * not require a session (slice 2.10).
 *
 * **`force-dynamic`, on the one page that most wants to be static.** §8.17 makes
 * this crawlable and fast, and a cached copy of it is a listing its owner paused
 * or a moderator rejected still being served to strangers. Caching this is a
 * real optimisation with a real invalidation story, and the story belongs to
 * whichever slice builds it rather than being inherited by a default.
 *
 * **It is indexable, which every other page in this app is not.** The owner's
 * page at `/listings/[id]` is `noindex` and says so; this is the counterpart it
 * has been anticipating since 2.8a. §8.17's rule that indexing must never expose
 * precise locations is kept by the projection rather than by the metadata here:
 * `PublicListing` has no address beyond a postal district, so there is nothing
 * on this page for a crawler to find.
 *
 * **Canonical URLs, structured data and the sitemap are slice 2.12**, not this
 * one. This page is the thing they will describe.
 */
export const dynamic = 'force-dynamic';

/**
 * The title a search result shows, built from what the listing says.
 *
 * `generateMetadata` rather than a constant, because every page sharing one
 * title is the duplicate-content problem §8.17 names. The district is in it for
 * the same reason a renter reads it: the question this page answers is *what is
 * it and how far away*.
 *
 * **It reads the listing a second time.** Next dedupes the two calls within a
 * render, and `fetchPublicListing` is a `no-store` fetch — so this is not free,
 * and it is still right: a title assembled from the id would be worse than
 * useless in a search result. If it ever shows up in a profile, the fix is
 * caching with invalidation, not a worse title.
 */
export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  const outcome = await fetchPublicListing(webEnv().API_BASE_URL, id);

  if (outcome.kind !== 'loaded') {
    // Nothing about why. A 404 title that said "paused" would disclose through
    // metadata exactly what the route refuses to disclose in its body.
    return { title: 'Listing not found' };
  }

  return {
    title: `${outcome.value.title} to hire in ${outcome.value.location.town}`,
    description: outcome.value.description.slice(0, 160),
  };
}

export default async function PublicListingPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;

  // No token and no client IP: there is no session to read and nothing here is
  // audited. See `fetchPublicListing`.
  const outcome = await fetchPublicListing(webEnv().API_BASE_URL, id);

  /*
   * **One 404 for four situations** — no such listing, a draft, one its owner
   * paused, one a moderator rejected. The API refuses to tell them apart and
   * this page must not undo that: a message saying "this listing is currently
   * unavailable" would confirm to a stranger that it exists, which is the whole
   * thing the API's uniform 404 protects.
   */
  if (outcome.kind === 'not-found') notFound();

  return (
    <main>
      {outcome.kind === 'loaded' ? (
        <PublicListingView listing={outcome.value} />
      ) : (
        /*
         * **Two failures, one sentence, and deliberately no detail.** The
         * owner's page distinguishes its failure kinds because the reader can
         * act on the difference — signing in again fixes one of them. A visitor
         * can act on none of these, and `malformed` in particular means the API
         * sent something this build would not vouch for, which is not a
         * stranger's business.
         */
        <p role="alert">
          This listing cannot be shown at the moment. Please try again shortly.
        </p>
      )}
    </main>
  );
}
