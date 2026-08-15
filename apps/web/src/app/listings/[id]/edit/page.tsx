import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ListingEditForm } from '../../../../components/listing-edit-form';
import { clientIpFrom } from '../../../../lib/client-ip';
import { fetchCategoryOptions, fetchListing } from '../../../../lib/listings';
import { ownerListingPath } from '../../../../lib/page-paths';
import { webEnv } from '../../../../lib/env';

/** Never prerendered — it is somebody's own listing. */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Edit your listing',
  robots: { index: false, follow: false },
};

/**
 * Editing one of your own listings (slice 2.9b-i).
 *
 * **Two reads, and they answer different questions** — which is the thing about
 * this page worth understanding. `fetchListing` gives the values an owner
 * already wrote; `fetchCategoryOptions` gives the category's **current** schema,
 * which is what the form draws its fields from (ADR 0042). The listing's own
 * `categoryAttributes` is the *pinned* schema and is deliberately not used here:
 * rendering the pinned questions and then pinning the current version on save is
 * the silent orphaning ADR 0029 rejected.
 *
 * Concurrent, because they are independent, and one failing does not take the
 * other down — the page refuses rather than guessing.
 */
export default async function EditListingPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  const { getToken } = await auth();
  const token = await getToken();
  const clientIp = clientIpFrom((await headers()).get('x-forwarded-for'));
  const api = webEnv().API_BASE_URL;

  const [listing, categories] = await Promise.all([
    fetchListing(api, token, id, undefined, clientIp),
    fetchCategoryOptions(api, token, undefined, clientIp),
  ]);

  // Somebody else's listing answers 404 rather than 403, and this page says the
  // same thing the API did — rendering "you are not allowed" would leak the
  // existence the API was careful not to confirm.
  if (listing.kind === 'not-found') notFound();

  return (
    <main>
      <h1>Edit your listing</h1>

      <Body listing={listing} categories={categories} />

      <p>
        <Link href={ownerListingPath(id)}>Back to the listing</Link> ·{' '}
        <Link href="/listings">All your listings</Link>
      </p>
    </main>
  );
}

/**
 * Every failure gets its own sentence, and **the form is not drawn without both
 * reads**.
 *
 * A form rendered from half the answer would be one that quietly dropped the
 * category's own fields, and an owner pressing Save on it would clear every
 * attribute they had answered. Refusing is the only safe reading of a partial
 * load here — which is why this is a guard rather than a fallback.
 */
function Body({
  listing,
  categories,
}: {
  readonly listing: Awaited<ReturnType<typeof fetchListing>>;
  readonly categories: Awaited<ReturnType<typeof fetchCategoryOptions>>;
}) {
  if (listing.kind === 'signed-out' || categories.kind === 'signed-out') {
    // The state first, the likeliest cause second — an expiry stated as fact is
    // a claim about a session we cannot vouch for.
    return (
      <p role="alert">
        You are not signed in. Your session may have expired —{' '}
        <Link href="/sign-in">sign in</Link> to edit this listing.
      </p>
    );
  }

  if (listing.kind !== 'loaded' || categories.kind !== 'loaded') {
    return (
      <p role="alert">
        This listing could not be loaded for editing. Nothing has been changed — try
        again in a moment.
      </p>
    );
  }

  const category = categories.value.find(
    (option) => option.slug === listing.value.categorySlug,
  );

  if (category === undefined) {
    /*
     * The listing's category is no longer offered — it was removed, or the
     * picker's bound cut it (ADR 0035). Rare, and the honest answer is to say so
     * rather than draw a form with no category-specific fields: saving that
     * would clear every answer the owner had given.
     *
     * **It used to end "Please get in touch".** There is no contact page, no
     * email channel until Phase 6, and by this project's own principle there
     * will not be a support desk after it either — we are an online platform
     * with no manual operations. Pointing somebody at a channel that will not
     * answer is worse than telling them plainly that nothing can be done yet,
     * because they wait for a reply instead of reading the rest of the sentence.
     */
    return (
      <p role="alert">
        This listing&rsquo;s category is not available at the moment, so it cannot be
        edited. Nothing has been changed and nothing has been lost — the listing and
        every answer on it are still stored, and{' '}
        <Link href={ownerListingPath(listing.value.id)}>its own page</Link> still shows
        them. Editing returns on its own if the category comes back. There is no way to
        force it from here, and we do not send an email when it does.
      </p>
    );
  }

  return <ListingEditForm listing={listing.value} category={category} />;
}
