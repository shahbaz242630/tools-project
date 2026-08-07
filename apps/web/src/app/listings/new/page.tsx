import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { CategoryOption } from '@platform/contracts';
import { ListingForm } from '../../../components/listing-form';
import { clientIpFrom } from '../../../lib/client-ip';
import { fetchCategoryOptions } from '../../../lib/listings';
import type { ListingOutcome } from '../../../lib/listings';
import { webEnv } from '../../../lib/env';

/** Never prerendered — it needs a session, and the category list changes. */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'List an item',
  robots: { index: false, follow: false },
};

/**
 * Where an owner puts an item up for rent.
 *
 * **The first page in this application that a signed-in person with no role can
 * write from.** Everything before it was either public, about the reader's own
 * account, or administrative.
 *
 * The form renders only when the category list loaded. That is the rule slice
 * 2.1 learned the hard way: a control that cannot work must not be presented as
 * though it can — and a category dropdown with nothing in it cannot.
 */
export default async function NewListingPage() {
  const { getToken } = await auth();
  const outcome = await fetchCategoryOptions(
    webEnv().API_BASE_URL,
    await getToken(),
    undefined,
    clientIpFrom((await headers()).get('x-forwarded-for')),
  );

  return (
    <main>
      <h1>List an item</h1>

      <p>
        This saves a <strong>draft</strong>. Nobody can see it and nobody can book it.
        Photographs come later; publishing is a separate step you take when you are
        ready, and it will tell you if anything is still missing.
      </p>

      <Categories outcome={outcome} />

      <p>
        <Link href="/account">Back to your account</Link>
      </p>
    </main>
  );
}

function Categories({
  outcome,
}: {
  readonly outcome: ListingOutcome<readonly CategoryOption[]>;
}) {
  switch (outcome.kind) {
    case 'signed-out':
      return (
        <p role="alert">
          Your session has expired. <Link href="/sign-in">Sign in again</Link>.
        </p>
      );

    case 'forbidden':
      return (
        <p role="alert">
          Your account cannot list items at the moment. If it has been suspended, the
          reason is on your <Link href="/account">account page</Link>.
        </p>
      );

    case 'not-found':
    case 'invalid':
      return <p role="alert">That is not available.</p>;

    // A read cannot conflict with anything — only the create can. Handled
    // rather than lumped in with the failures above because the compiler is
    // right to insist: the day this page does something other than read, a
    // silent fall-through would be the bug.
    case 'stale-category':
      return (
        <p role="alert">
          The categories have just changed. Reload the page to see the current list.
        </p>
      );

    case 'unreachable':
    case 'malformed':
      return (
        <p role="alert">
          The categories could not be loaded — {outcome.reason}. Nothing has been saved,
          so nothing is lost by trying again.
        </p>
      );

    case 'loaded':
      break;
  }

  if (outcome.value.length === 0) {
    // Not an error, and not a form either. No category exists yet, which is a
    // state of the platform rather than a fault of the person reading.
    return (
      <p>
        There is nothing to list in yet — no categories have been set up. This is
        expected before launch rather than a fault, and there is nothing you can do
        about it from here.
      </p>
    );
  }

  return <ListingForm categories={outcome.value} />;
}
