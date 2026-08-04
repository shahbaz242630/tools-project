import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Money, Time } from '@platform/core';
import type { OwnerListing } from '@platform/contracts';
import { clientIpFrom } from '../../../lib/client-ip';
import { fetchListing } from '../../../lib/listings';
import { webEnv } from '../../../lib/env';

/** Never prerendered — it is somebody's own draft. */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Your listing',
  robots: { index: false, follow: false },
};

/**
 * One of your own listings.
 *
 * **Not the public listing page.** That is slice 2.10, it is a different
 * projection, and it must be crawlable — this one is `noindex` and shows things
 * a stranger will never see. Keeping them apart from the start is what stops the
 * public page inheriting a field it should not have.
 */
export default async function ListingPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  const { getToken } = await auth();

  const outcome = await fetchListing(
    webEnv().API_BASE_URL,
    await getToken(),
    id,
    undefined,
    clientIpFrom((await headers()).get('x-forwarded-for')),
  );

  // Somebody else's listing answers 404 rather than 403, and this page says the
  // same thing the API did. Rendering "you are not allowed" here would leak the
  // existence the API was careful not to confirm.
  if (outcome.kind === 'not-found') notFound();

  return (
    <main>
      {outcome.kind === 'loaded' ? (
        <Listing listing={outcome.value} />
      ) : (
        <Unavailable kind={outcome.kind} />
      )}

      <p>
        <Link href="/listings/new">List another item</Link> ·{' '}
        <Link href="/account">Back to your account</Link>
      </p>
    </main>
  );
}

function Listing({ listing }: { readonly listing: OwnerListing }) {
  return (
    <>
      <h1>{listing.title}</h1>

      <p role="status">
        <strong>Draft.</strong> Nobody else can see this and nobody can book it.
      </p>

      <dl>
        <dt>Category</dt>
        <dd>
          {listing.categoryName}{' '}
          <small>
            (recorded as version {listing.categoryVersionNumber} — the rules as they
            stood when you saved)
          </small>
        </dd>

        <dt>Replacement value</dt>
        {/*
          Formatted by the money primitive, never by string concatenation or
          `toFixed` — which is banned (ADR 0002) and is how a float gets into a
          number somebody will later be charged against.
        */}
        <dd>{Money.format(listing.replacementValue)}</dd>

        <dt>Description</dt>
        <dd>
          {listing.description === '' ? (
            <em>
              Nothing written yet. It has to say something before you can publish.
            </em>
          ) : (
            listing.description
          )}
        </dd>

        <dt>Saved</dt>
        <dd>{Time.formatLocal(Time.fromIsoUtc(listing.createdAt))}</dd>
      </dl>

      <p>
        Photographs, a collection point and prices are not built yet. When they are,
        they will appear here — and publishing will be a separate step.
      </p>
    </>
  );
}

/**
 * Every failure gets its own sentence.
 *
 * A single "something went wrong" would make an expired session and an
 * unreachable API look identical, and only one of those is fixed by signing in
 * again.
 */
function Unavailable({ kind }: { readonly kind: string }) {
  if (kind === 'signed-out') {
    return (
      <p role="alert">
        Your session has expired. <Link href="/sign-in">Sign in again</Link>.
      </p>
    );
  }

  return (
    <p role="alert">
      This listing could not be loaded. Nothing has been changed — try again in a
      moment.
    </p>
  );
}
